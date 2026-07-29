import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchSendError, InvalidMessageError } from '../src/errors'
import { Producer } from '../src/producer'
import type { SendBatchEntry } from '../src/types'

const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders'
const FIFO_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders.fifo'

const createSqsMock = () => mockClient(SQSClient)
let sqs: ReturnType<typeof createSqsMock>
let client: SQSClient

beforeEach(() => {
  sqs = createSqsMock()
  client = new SQSClient({ region: 'eu-west-1' })
  sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: QUEUE_URL })
  sqs.on(SendMessageCommand).resolves({ MessageId: 'id-1', MD5OfMessageBody: 'md5' })
})

afterEach(() => {
  sqs.restore()
})

function producer(fifo = false): Producer {
  return new Producer({ client, queue: { name: 'orders', fifo } })
}

describe('Producer.send', () => {
  it('sends the resolved queue URL, not the queue name', async () => {
    await producer().send({ body: 'hello' })

    const input = sqs.commandCalls(SendMessageCommand)[0]!.args[0].input
    expect(input.QueueUrl).toBe(QUEUE_URL)
    expect(input.MessageBody).toBe('hello')
  })

  it('returns the identifiers SQS assigned', async () => {
    sqs.on(SendMessageCommand).resolves({
      MessageId: 'id-9',
      SequenceNumber: '18',
      MD5OfMessageBody: 'abc',
    })

    await expect(producer().send({ body: 'hello' })).resolves.toEqual({
      messageId: 'id-9',
      sequenceNumber: '18',
      md5OfMessageBody: 'abc',
    })
  })

  it('does not mutate the caller-supplied message', async () => {
    // Regression: the previous implementation assigned the resolved queue URL
    // onto the caller's input object, so reusing one options object corrupted
    // every subsequent send.
    const message = { body: 'hello' }
    const snapshot = structuredClone(message)
    const subject = producer()

    await subject.send(message)
    await subject.send(message)

    expect(message).toEqual(snapshot)
    const calls = sqs.commandCalls(SendMessageCommand)
    expect(calls[0]!.args[0].input.QueueUrl).toBe(QUEUE_URL)
    expect(calls[1]!.args[0].input.QueueUrl).toBe(QUEUE_URL)
  })

  it('resolves the queue once no matter how many messages are sent', async () => {
    const subject = producer()

    await subject.send({ body: 'a' })
    await subject.send({ body: 'b' })
    await subject.send({ body: 'c' })

    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(1)
  })

  it('forwards message attributes and delay', async () => {
    await producer().send({
      body: 'hello',
      delaySeconds: 30,
      attributes: { source: { DataType: 'String', StringValue: 'api' } },
    })

    const input = sqs.commandCalls(SendMessageCommand)[0]!.args[0].input
    expect(input.DelaySeconds).toBe(30)
    expect(input.MessageAttributes).toEqual({
      source: { DataType: 'String', StringValue: 'api' },
    })
  })

  it('omits optional fields that were not supplied', async () => {
    await producer().send({ body: 'hello' })

    const input = sqs.commandCalls(SendMessageCommand)[0]!.args[0].input
    expect(input).not.toHaveProperty('MessageGroupId')
    expect(input).not.toHaveProperty('DelaySeconds')
    expect(input).not.toHaveProperty('MessageAttributes')
  })
})

describe('Producer.send — validation', () => {
  it.each([
    ['an empty body', ''],
    ['a non-string body', 42 as unknown as string],
  ])('rejects %s', async (_label, body) => {
    await expect(producer().send({ body })).rejects.toThrow(InvalidMessageError)
  })

  it('rejects a message larger than 256 KiB', async () => {
    await expect(producer().send({ body: 'x'.repeat(262_145) })).rejects.toThrow(
      /256 KiB/,
    )
  })

  it('counts attribute names and values toward the size limit', async () => {
    await expect(
      producer().send({
        body: 'x'.repeat(262_100),
        attributes: { k: { DataType: 'String', StringValue: 'y'.repeat(100) } },
      }),
    ).rejects.toThrow(InvalidMessageError)
  })

  it.each([-1, 901, 1.5])('rejects delaySeconds = %s', async delaySeconds => {
    await expect(producer().send({ body: 'a', delaySeconds })).rejects.toThrow(
      InvalidMessageError,
    )
  })

  it('requires a group id on a FIFO queue', async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: FIFO_URL })

    await expect(producer(true).send({ body: 'a' })).rejects.toThrow(/groupId/)
  })

  it('rejects a per-message delay on a FIFO queue', async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: FIFO_URL })

    await expect(
      producer(true).send({ body: 'a', groupId: 'g', delaySeconds: 10 }),
    ).rejects.toThrow(/do not support per-message delays/)
  })

  it('rejects FIFO-only fields on a standard queue', async () => {
    await expect(producer().send({ body: 'a', groupId: 'g' })).rejects.toThrow(
      /FIFO queues only/,
    )
  })

  it('accepts a FIFO message with a group id', async () => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: FIFO_URL })

    await producer(true).send({ body: 'a', groupId: 'g', deduplicationId: 'd' })

    const input = sqs.commandCalls(SendMessageCommand)[0]!.args[0].input
    expect(input.MessageGroupId).toBe('g')
    expect(input.MessageDeduplicationId).toBe('d')
  })
})

describe('Producer.sendBatch', () => {
  beforeEach(() => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: 'entry-0', MessageId: 'm-0', MD5OfMessageBody: 'md5' }],
      Failed: [],
    })
  })

  it('makes no calls for an empty batch', async () => {
    await expect(producer().sendBatch([])).resolves.toEqual({
      successful: [],
      failed: [],
    })
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0)
  })

  it('splits batches at the 10-entry limit', async () => {
    const entries: SendBatchEntry[] = Array.from({ length: 25 }, (_, i) => ({
      body: `message-${String(i)}`,
    }))

    await producer().sendBatch(entries, { throwOnFailure: false })

    const calls = sqs.commandCalls(SendMessageBatchCommand)
    expect(calls).toHaveLength(3)
    expect(calls[0]!.args[0].input.Entries).toHaveLength(10)
    expect(calls[2]!.args[0].input.Entries).toHaveLength(5)
  })

  it('splits batches that would exceed 256 KiB even with fewer than 10 entries', async () => {
    const entries: SendBatchEntry[] = Array.from({ length: 3 }, () => ({
      body: 'x'.repeat(100_000),
    }))

    await producer().sendBatch(entries, { throwOnFailure: false })

    const calls = sqs.commandCalls(SendMessageBatchCommand)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args[0].input.Entries).toHaveLength(2)
    expect(calls[1]!.args[0].input.Entries).toHaveLength(1)
  })

  it('derives unique entry ids from position', async () => {
    await producer().sendBatch([{ body: 'a' }, { body: 'b' }], {
      throwOnFailure: false,
    })

    const entries = sqs.commandCalls(SendMessageBatchCommand)[0]!.args[0].input.Entries!
    expect(entries.map(entry => entry.Id)).toEqual(['entry-0', 'entry-1'])
  })

  it('keeps caller-supplied ids', async () => {
    await producer().sendBatch([{ id: 'order-7', body: 'a' }], {
      throwOnFailure: false,
    })

    expect(
      sqs.commandCalls(SendMessageBatchCommand)[0]!.args[0].input.Entries![0]!.Id,
    ).toBe('order-7')
  })

  it('rejects duplicate entry ids before calling SQS', async () => {
    await expect(
      producer().sendBatch([
        { id: 'same', body: 'a' },
        { id: 'same', body: 'b' },
      ]),
    ).rejects.toThrow(/unique/)
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0)
  })

  it('rejects an entry id SQS would not accept', async () => {
    await expect(producer().sendBatch([{ id: 'bad id!', body: 'a' }])).rejects.toThrow(
      InvalidMessageError,
    )
  })
})

describe('Producer.sendBatch — partial failure', () => {
  beforeEach(() => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: 'entry-0', MessageId: 'm-0', MD5OfMessageBody: 'md5' }],
      Failed: [
        {
          Id: 'entry-1',
          Code: 'InternalError',
          Message: 'try again',
          SenderFault: false,
        },
      ],
    })
  })

  it('throws by default so a partial failure cannot pass unnoticed', async () => {
    await expect(producer().sendBatch([{ body: 'a' }, { body: 'b' }])).rejects.toThrow(
      BatchSendError,
    )
  })

  it('reports which entries failed and which already landed', async () => {
    // A blind retry of the whole batch would duplicate entry-0.
    const error = await producer()
      .sendBatch([{ body: 'a' }, { body: 'b' }])
      .catch((caught: unknown) => caught as BatchSendError)

    expect(error).toBeInstanceOf(BatchSendError)
    expect(error.failed).toEqual([
      {
        id: 'entry-1',
        code: 'InternalError',
        message: 'try again',
        senderFault: false,
      },
    ])
    expect(error.successful.map(entry => entry.id)).toEqual(['entry-0'])
  })

  it('returns the breakdown instead of throwing when asked', async () => {
    const result = await producer().sendBatch([{ body: 'a' }, { body: 'b' }], {
      throwOnFailure: false,
    })

    expect(result.successful).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
  })
})

describe('Producer — resilience', () => {
  it('re-resolves and retries once when the cached queue has gone', async () => {
    const gone = new Error('gone')
    gone.name = 'QueueDoesNotExist'
    sqs.reset()
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: QUEUE_URL })
    sqs.on(SendMessageCommand).rejectsOnce(gone).resolves({ MessageId: 'id-2' })

    await expect(producer().send({ body: 'only' })).resolves.toMatchObject({
      messageId: 'id-2',
    })

    // Resolved once up front, then again after the stale entry was dropped.
    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(2)
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(2)
  })

  it('gives up if the queue is still missing after re-resolving', async () => {
    const gone = new Error('gone')
    gone.name = 'QueueDoesNotExist'
    sqs.reset()
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: QUEUE_URL })
    sqs.on(SendMessageCommand).rejects(gone)

    await expect(producer().send({ body: 'only' })).rejects.toThrow(gone)
    // Retried exactly once — no unbounded loop.
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(2)
  })

  it('does not retry errors unrelated to a missing queue', async () => {
    sqs.on(SendMessageCommand).rejects(new Error('network down'))

    await expect(producer().send({ body: 'a' })).rejects.toThrow('network down')
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(1)
  })

  it('leaves a caller-provided client open on destroy', async () => {
    const destroy = vi.spyOn(client, 'destroy')

    await producer().destroy()

    expect(destroy).not.toHaveBeenCalled()
  })

  it('closes a client it created itself', async () => {
    const destroy = vi.spyOn(SQSClient.prototype, 'destroy')
    const subject = new Producer({
      clientConfig: { region: 'eu-west-1' },
      queue: { name: 'orders' },
    })

    await subject.destroy()

    expect(destroy).toHaveBeenCalled()
    destroy.mockRestore()
  })
})
