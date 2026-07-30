import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueueNotFoundError, QueueProvisioningError } from '../src/errors'
import { QueueResolver } from '../src/internal/queue-resolver'
import { silentLogger } from '../src/logger'

const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders'
const DLQ_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/dlq-orders'
const DLQ_ARN = 'arn:aws:sqs:eu-west-1:123456789012:dlq-orders'

/**
 * A plain error carrying only the AWS error *name*.
 *
 * Deliberately not an instance of the SDK's `QueueDoesNotExist` class: that is
 * exactly the situation where `instanceof` fails (two copies of the SDK in one
 * dependency tree) and auto-provisioning silently stops working.
 */
function awsError(name: string): Error {
  const error = new Error(`${name} (simulated)`)
  error.name = name
  return error
}

const createSqsMock = () => mockClient(SQSClient)
let sqs: ReturnType<typeof createSqsMock>
let client: SQSClient

beforeEach(() => {
  sqs = createSqsMock()
  client = new SQSClient({ region: 'eu-west-1' })
})

afterEach(() => {
  sqs.restore()
})

function resolver(): QueueResolver {
  return new QueueResolver(client, silentLogger)
}

describe('QueueResolver — existing queues', () => {
  beforeEach(() => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: QUEUE_URL })
  })

  it('returns the URL of a queue that already exists', async () => {
    const resolved = await resolver().resolve({ name: 'orders' })

    expect(resolved).toEqual({ name: 'orders', url: QUEUE_URL, fifo: false })
    expect(sqs.commandCalls(CreateQueueCommand)).toHaveLength(0)
  })

  it('looks the queue up under its FIFO name', async () => {
    await resolver().resolve({ name: 'orders', fifo: true })

    expect(sqs.commandCalls(GetQueueUrlCommand)[0]!.args[0].input).toEqual({
      QueueName: 'orders.fifo',
    })
  })

  it('caches the URL so repeated resolves cost nothing', async () => {
    const subject = resolver()

    await subject.resolve({ name: 'orders' })
    await subject.resolve({ name: 'orders' })
    await subject.resolve({ name: 'orders' })

    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(1)
  })

  it('collapses concurrent resolves into one lookup', async () => {
    const subject = resolver()

    await Promise.all([
      subject.resolve({ name: 'orders' }),
      subject.resolve({ name: 'orders' }),
      subject.resolve({ name: 'orders' }),
    ])

    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(1)
  })

  it('goes back to AWS after the cache is invalidated', async () => {
    const subject = resolver()

    await subject.resolve({ name: 'orders' })
    subject.invalidate('orders')
    await subject.resolve({ name: 'orders' })

    expect(sqs.commandCalls(GetQueueUrlCommand)).toHaveLength(2)
  })

  it('retries the lookup when a resolve fails', async () => {
    sqs.reset()
    sqs
      .on(GetQueueUrlCommand)
      .rejectsOnce(awsError('ThrottlingException'))
      .resolves({ QueueUrl: QUEUE_URL })
    const subject = resolver()

    await expect(subject.resolve({ name: 'orders' })).rejects.toThrow()
    // A failure must not be cached as a permanent negative result.
    await expect(subject.resolve({ name: 'orders' })).resolves.toMatchObject({
      url: QUEUE_URL,
    })
  })
})

describe('QueueResolver — missing queues', () => {
  beforeEach(() => {
    sqs.on(GetQueueUrlCommand).rejects(awsError('QueueDoesNotExist'))
  })

  it('refuses to create a queue unless asked', async () => {
    await expect(resolver().resolve({ name: 'orders' })).rejects.toThrow(
      QueueNotFoundError,
    )
    expect(sqs.commandCalls(CreateQueueCommand)).toHaveLength(0)
  })

  it('names createIfNotExists in the error so the fix is obvious', async () => {
    await expect(resolver().resolve({ name: 'orders' })).rejects.toThrow(
      /createIfNotExists/,
    )
  })

  it('detects a missing queue by error name, not by instanceof', async () => {
    // The rejection above is a plain Error, so this only passes if detection is
    // name-based.
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: QUEUE_URL })

    const resolved = await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
    })

    expect(resolved.url).toBe(QUEUE_URL)
  })

  it('also recognises the legacy NonExistentQueue error name', async () => {
    sqs.reset()
    sqs
      .on(GetQueueUrlCommand)
      .rejects(awsError('AWS.SimpleQueueService.NonExistentQueue'))
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: QUEUE_URL })

    await expect(
      resolver().resolve({ name: 'orders', createIfNotExists: true }),
    ).resolves.toMatchObject({ url: QUEUE_URL })
  })

  it('creates a standard queue without any FIFO attributes', async () => {
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: QUEUE_URL })

    await resolver().resolve({ name: 'orders', createIfNotExists: true })

    const input = sqs.commandCalls(CreateQueueCommand)[0]!.args[0].input
    expect(input.QueueName).toBe('orders')
    expect(input.Attributes).not.toHaveProperty('FifoQueue')
    expect(input.Attributes).not.toHaveProperty('RedrivePolicy')
  })

  it('passes tags through on creation', async () => {
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: QUEUE_URL })

    await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
      tags: { team: 'payments' },
    })

    expect(sqs.commandCalls(CreateQueueCommand)[0]!.args[0].input.tags).toEqual({
      team: 'payments',
    })
  })

  it('surfaces a deleted-recently failure with the 60-second explanation', async () => {
    sqs.on(CreateQueueCommand).rejects(awsError('QueueDeletedRecently'))

    await expect(
      resolver().resolve({ name: 'orders', createIfNotExists: true }),
    ).rejects.toThrow(/60 seconds/)
  })

  it('wraps an unexpected creation failure as a provisioning error', async () => {
    sqs.on(CreateQueueCommand).rejects(awsError('AccessDenied'))

    await expect(
      resolver().resolve({ name: 'orders', createIfNotExists: true }),
    ).rejects.toThrow(QueueProvisioningError)
  })

  it('adopts the existing queue when it loses a creation race', async () => {
    // Another process created the queue between our lookup and our create.
    sqs.on(CreateQueueCommand).rejects(awsError('QueueNameExists'))
    sqs
      .on(GetQueueUrlCommand)
      .rejectsOnce(awsError('QueueDoesNotExist'))
      .resolves({ QueueUrl: QUEUE_URL })

    const resolved = await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
    })

    expect(resolved.url).toBe(QUEUE_URL)
  })

  it('fails when SQS reports success but returns no URL', async () => {
    sqs.on(CreateQueueCommand).resolves({})

    await expect(
      resolver().resolve({ name: 'orders', createIfNotExists: true }),
    ).rejects.toThrow(QueueProvisioningError)
  })
})

describe('QueueResolver — dead-letter queues', () => {
  beforeEach(() => {
    sqs.on(GetQueueUrlCommand).rejects(awsError('QueueDoesNotExist'))
    sqs
      .on(CreateQueueCommand, { QueueName: 'dlq-orders' })
      .resolves({ QueueUrl: DLQ_URL })
    sqs.on(CreateQueueCommand, { QueueName: 'orders' }).resolves({
      QueueUrl: QUEUE_URL,
    })
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: DLQ_ARN } })
  })

  it('creates the dead-letter queue and points the redrive policy at it', async () => {
    await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
      dlq: true,
    })

    const primary = sqs
      .commandCalls(CreateQueueCommand)
      .find(call => call.args[0].input.QueueName === 'orders')!

    expect(JSON.parse(primary.args[0].input.Attributes!.RedrivePolicy!)).toEqual({
      deadLetterTargetArn: DLQ_ARN,
      maxReceiveCount: 5,
    })
  })

  it('never gives the dead-letter queue a dead-letter queue of its own', async () => {
    await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
      dlq: true,
    })

    const dlq = sqs
      .commandCalls(CreateQueueCommand)
      .find(call => call.args[0].input.QueueName === 'dlq-orders')!

    expect(dlq.args[0].input.Attributes).not.toHaveProperty('RedrivePolicy')
    expect(sqs.commandCalls(CreateQueueCommand)).toHaveLength(2)
  })

  it('honours a custom threshold and name', async () => {
    sqs
      .on(CreateQueueCommand, { QueueName: 'orders-failures' })
      .resolves({ QueueUrl: DLQ_URL })

    await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
      dlq: { name: 'orders-failures', maxReceiveCount: 2 },
    })

    const primary = sqs
      .commandCalls(CreateQueueCommand)
      .find(call => call.args[0].input.QueueName === 'orders')!
    expect(
      JSON.parse(primary.args[0].input.Attributes!.RedrivePolicy!).maxReceiveCount,
    ).toBe(2)
  })

  it('reuses an existing dead-letter queue rather than recreating it', async () => {
    sqs.reset()
    sqs
      .on(GetQueueUrlCommand, { QueueName: 'orders' })
      .rejects(awsError('QueueDoesNotExist'))
    sqs.on(GetQueueUrlCommand, { QueueName: 'dlq-orders' }).resolves({
      QueueUrl: DLQ_URL,
    })
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { QueueArn: DLQ_ARN } })
    sqs.on(CreateQueueCommand).resolves({ QueueUrl: QUEUE_URL })

    await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
      dlq: true,
    })

    expect(sqs.commandCalls(CreateQueueCommand)).toHaveLength(1)
  })

  it('skips dead-letter provisioning when dlq is false', async () => {
    await resolver().resolve({
      name: 'orders',
      createIfNotExists: true,
      dlq: false,
    })

    expect(sqs.commandCalls(CreateQueueCommand)).toHaveLength(1)
  })

  it('fails clearly when the dead-letter queue ARN cannot be read', async () => {
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: {} })

    await expect(
      resolver().resolve({ name: 'orders', createIfNotExists: true, dlq: true }),
    ).rejects.toThrow(QueueProvisioningError)
  })
})

describe('QueueResolver — attribute reconciliation', () => {
  beforeEach(() => {
    sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: QUEUE_URL })
  })

  it('does nothing unless reconciliation is explicitly enabled', async () => {
    await resolver().resolve({
      name: 'orders',
      attributes: { visibilityTimeout: 60 },
    })

    expect(sqs.commandCalls(SetQueueAttributesCommand)).toHaveLength(0)
  })

  it('updates only the attributes that drifted', async () => {
    sqs.on(GetQueueAttributesCommand).resolves({
      Attributes: { VisibilityTimeout: '30', MessageRetentionPeriod: '3600' },
    })

    await resolver().resolve({
      name: 'orders',
      reconcileAttributes: true,
      attributes: { visibilityTimeout: 60, messageRetentionPeriod: 3600 },
    })

    const calls = sqs.commandCalls(SetQueueAttributesCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0].input.Attributes).toEqual({ VisibilityTimeout: '60' })
  })

  it('makes no call when nothing has drifted', async () => {
    sqs
      .on(GetQueueAttributesCommand)
      .resolves({ Attributes: { VisibilityTimeout: '60' } })

    await resolver().resolve({
      name: 'orders',
      reconcileAttributes: true,
      attributes: { visibilityTimeout: 60 },
    })

    expect(sqs.commandCalls(SetQueueAttributesCommand)).toHaveLength(0)
  })

  it('never writes its own long-polling default onto a live queue', async () => {
    // Enabling reconciliation must not silently change a setting the caller
    // never expressed an opinion about.
    sqs
      .on(GetQueueAttributesCommand)
      .resolves({ Attributes: { ReceiveMessageWaitTimeSeconds: '0' } })

    await resolver().resolve({
      name: 'orders',
      reconcileAttributes: true,
      attributes: { visibilityTimeout: 30 },
    })

    const calls = sqs.commandCalls(SetQueueAttributesCommand)
    for (const call of calls) {
      expect(call.args[0].input.Attributes).not.toHaveProperty(
        'ReceiveMessageWaitTimeSeconds',
      )
    }
  })

  it('does nothing when no attributes are configured', async () => {
    await resolver().resolve({ name: 'orders', reconcileAttributes: true })

    expect(sqs.commandCalls(GetQueueAttributesCommand)).toHaveLength(0)
    expect(sqs.commandCalls(SetQueueAttributesCommand)).toHaveLength(0)
  })
})
