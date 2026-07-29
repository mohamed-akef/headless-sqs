import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Consumer } from '../src/consumer'
import { InvalidQueueAttributeError } from '../src/errors'
import type { ConsumerConfig } from '../src/types'

const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders'
const FIFO_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders.fifo'

const createSqsMock = () => mockClient(SQSClient)
let sqs: ReturnType<typeof createSqsMock>
let client: SQSClient
let running: Consumer[]

function message(id: string, groupId?: string): Message {
  return {
    MessageId: id,
    Body: id,
    ReceiptHandle: `receipt-${id}`,
    ...(groupId !== undefined ? { Attributes: { MessageGroupId: groupId } } : {}),
  }
}

/** Build a consumer that polls fast and is torn down after the test. */
function consumer(overrides: Partial<ConsumerConfig> = {}): Consumer {
  const instance = new Consumer({
    client,
    queue: { name: 'orders' },
    handler: () => Promise.resolve(),
    batchSize: 3,
    waitTimeSeconds: 0,
    pollingWaitTimeMs: 5,
    ...overrides,
  })

  // Keep an error listener attached so a stray SQS error cannot fail the run.
  instance.on('error', () => undefined)
  running.push(instance)
  return instance
}

beforeEach(() => {
  running = []
  sqs = createSqsMock()
  client = new SQSClient({ region: 'eu-west-1' })
  sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: QUEUE_URL })
  sqs.on(ReceiveMessageCommand).resolves({ Messages: [] })
  sqs.on(DeleteMessageBatchCommand).resolves({ Successful: [], Failed: [] })
})

afterEach(async () => {
  for (const instance of running) {
    await instance.stop({ abort: true, timeoutMs: 500 })
  }
  sqs.restore()
})

describe('Consumer — configuration', () => {
  it('requires a handler function', () => {
    expect(
      () =>
        new Consumer({
          client,
          queue: { name: 'orders' },
        } as unknown as ConsumerConfig),
    ).toThrow(/handler/)
  })

  it.each([0, 11, 2.5])('rejects batchSize = %s', batchSize => {
    expect(() => consumer({ batchSize })).toThrow(InvalidQueueAttributeError)
  })

  it('rejects a non-positive concurrency', () => {
    expect(() => consumer({ concurrency: 0 })).toThrow(InvalidQueueAttributeError)
  })

  it('rejects waitTimeSeconds above the SQS maximum', () => {
    expect(() => consumer({ waitTimeSeconds: 21 })).toThrow(InvalidQueueAttributeError)
  })

  it('requires visibilityTimeout alongside heartbeatInterval', () => {
    // The heartbeat extends visibility by adding visibilityTimeout, so it is
    // meaningless without one.
    expect(() => consumer({ heartbeatInterval: 10 })).toThrow(
      /requires `visibilityTimeout`/,
    )
  })

  it('rejects a heartbeat that is not shorter than the visibility timeout', () => {
    expect(() => consumer({ heartbeatInterval: 30, visibilityTimeout: 30 })).toThrow(
      /must be less than/,
    )
  })

  it('accepts a heartbeat shorter than the visibility timeout', () => {
    expect(() =>
      consumer({ heartbeatInterval: 10, visibilityTimeout: 30 }),
    ).not.toThrow()
  })
})

describe('Consumer — lifecycle', () => {
  it('reports it is not running before start', () => {
    expect(consumer().isRunning).toBe(false)
  })

  it('starts polling', async () => {
    const subject = consumer()

    await subject.start()

    expect(subject.isRunning).toBe(true)
  })

  it('stops the poller that is actually running', async () => {
    // Regression: the previous implementation built a *new* consumer inside
    // stop() and stopped that one, so the running poller kept going forever.
    const subject = consumer()
    await subject.start()
    expect(subject.isRunning).toBe(true)

    await subject.stop()

    expect(subject.isRunning).toBe(false)

    const callsAtStop = sqs.commandCalls(ReceiveMessageCommand).length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(sqs.commandCalls(ReceiveMessageCommand).length).toBe(callsAtStop)
  })

  it('is safe to start twice', async () => {
    const subject = consumer()

    await subject.start()
    await subject.start()

    expect(subject.isRunning).toBe(true)
    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(1)
  })

  it('collapses concurrent starts', async () => {
    const subject = consumer()

    await Promise.all([subject.start(), subject.start()])

    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(1)
  })

  it('is safe to stop when never started', async () => {
    await expect(consumer().stop()).resolves.toBeUndefined()
  })

  it('is safe to stop twice', async () => {
    const subject = consumer()
    await subject.start()

    await subject.stop()
    await expect(subject.stop()).resolves.toBeUndefined()
  })

  it('can be restarted after stopping', async () => {
    const subject = consumer()

    await subject.start()
    await subject.stop()
    await subject.start()

    expect(subject.isRunning).toBe(true)
  })

  it('emits started and stopped', async () => {
    const subject = consumer()
    const started = vi.fn()
    const stopped = vi.fn()
    subject.on('started', started)
    subject.on('stopped', stopped)

    await subject.start()
    await subject.stop()

    expect(started).toHaveBeenCalled()
    expect(stopped).toHaveBeenCalled()
  })

  it('resolves the queue URL without starting', async () => {
    await expect(consumer().queueUrl()).resolves.toBe(QUEUE_URL)
  })
})

describe('Consumer — acknowledgement', () => {
  it('deletes every message when all handlers succeed', async () => {
    sqs
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [message('a'), message('b')] })
      .resolves({ Messages: [] })

    const subject = consumer()
    await subject.start()

    await vi.waitFor(() => {
      expect(sqs.commandCalls(DeleteMessageBatchCommand).length).toBeGreaterThan(0)
    })

    const entries = sqs.commandCalls(DeleteMessageBatchCommand)[0]!.args[0].input
      .Entries!
    expect(entries.map(entry => entry.ReceiptHandle).sort()).toEqual([
      'receipt-a',
      'receipt-b',
    ])
  })

  it('deletes only the messages that succeeded', async () => {
    // Regression: the previous implementation ran the batch through Promise.all
    // and acknowledged nothing on failure, so the whole batch was redelivered
    // and every already-successful message was processed a second time.
    sqs
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [message('a'), message('b'), message('c')],
      })
      .resolves({ Messages: [] })

    const subject = consumer({
      handler: (received: Message) =>
        received.MessageId === 'b'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(),
    })
    const processingError = vi.fn()
    subject.on('processing_error', processingError)

    await subject.start()

    await vi.waitFor(() => {
      expect(sqs.commandCalls(DeleteMessageBatchCommand).length).toBeGreaterThan(0)
    })

    const entries = sqs.commandCalls(DeleteMessageBatchCommand)[0]!.args[0].input
      .Entries!
    expect(entries.map(entry => entry.ReceiptHandle).sort()).toEqual([
      'receipt-a',
      'receipt-c',
    ])
    expect(processingError).toHaveBeenCalledTimes(1)
  })

  it('deletes nothing when every handler fails', async () => {
    sqs
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [message('a')] })
      .resolves({ Messages: [] })

    const subject = consumer({
      handler: () => Promise.reject(new Error('boom')),
    })
    const processingError = vi.fn()
    subject.on('processing_error', processingError)

    await subject.start()
    await vi.waitFor(() => {
      expect(processingError).toHaveBeenCalled()
    })

    expect(sqs.commandCalls(DeleteMessageBatchCommand)).toHaveLength(0)
  })

  it('reports the original error to processing_error listeners', async () => {
    const failure = new Error('handler exploded')
    sqs
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [message('a')] })
      .resolves({ Messages: [] })

    const subject = consumer({ handler: () => Promise.reject(failure) })
    const processingError = vi.fn()
    subject.on('processing_error', processingError)

    await subject.start()
    await vi.waitFor(() => {
      expect(processingError).toHaveBeenCalled()
    })

    expect(processingError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ MessageId: 'a' }),
    )
  })

  it('does not crash when a handler fails and nobody listens for errors', async () => {
    // Node throws on an unhandled 'error' event; a consumer must not take the
    // process down because the caller did not subscribe.
    sqs
      .on(ReceiveMessageCommand)
      .resolvesOnce({ Messages: [message('a')] })
      .resolves({ Messages: [] })

    const subject = new Consumer({
      client,
      queue: { name: 'orders' },
      handler: () => Promise.reject(new Error('boom')),
      batchSize: 1,
      waitTimeSeconds: 0,
      pollingWaitTimeMs: 5,
    })
    running.push(subject)

    await subject.start()
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(subject.isRunning).toBe(true)
  })
})

describe('Consumer — FIFO queues', () => {
  beforeEach(() => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: FIFO_URL })
  })

  it('requests MessageGroupId so ordering can be preserved', async () => {
    const subject = consumer({ queue: { name: 'orders', fifo: true } })
    await subject.start()

    await vi.waitFor(() => {
      expect(sqs.commandCalls(ReceiveMessageCommand).length).toBeGreaterThan(0)
    })

    const input = sqs.commandCalls(ReceiveMessageCommand)[0]!.args[0].input
    expect(input.AttributeNames).toContain('MessageGroupId')
  })

  it('does not request MessageGroupId for a standard queue', async () => {
    const subject = consumer()
    await subject.start()

    await vi.waitFor(() => {
      expect(sqs.commandCalls(ReceiveMessageCommand).length).toBeGreaterThan(0)
    })

    const input = sqs.commandCalls(ReceiveMessageCommand)[0]!.args[0].input
    expect(input.AttributeNames ?? []).not.toContain('MessageGroupId')
  })

  it('keeps a failing group from blocking another group', async () => {
    sqs
      .on(ReceiveMessageCommand)
      .resolvesOnce({
        Messages: [
          message('a1', 'group-1'),
          message('a2', 'group-1'),
          message('b1', 'group-2'),
        ],
      })
      .resolves({ Messages: [] })

    const subject = consumer({
      queue: { name: 'orders', fifo: true },
      handler: (received: Message) =>
        received.MessageId === 'a1'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(),
    })
    subject.on('processing_error', () => undefined)

    await subject.start()
    await vi.waitFor(() => {
      expect(sqs.commandCalls(DeleteMessageBatchCommand).length).toBeGreaterThan(0)
    })

    // group-2 proceeds; a2 stays queued behind the failed a1 to keep order.
    const entries = sqs.commandCalls(DeleteMessageBatchCommand)[0]!.args[0].input
      .Entries!
    expect(entries.map(entry => entry.ReceiptHandle)).toEqual(['receipt-b1'])
  })
})
