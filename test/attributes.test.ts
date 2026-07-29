import { describe, expect, it } from 'vitest'
import { InvalidQueueAttributeError } from '../src/errors'
import {
  buildQueueAttributes,
  diffAttributes,
  validateMaxReceiveCount,
} from '../src/internal/attributes'

const DLQ_ARN = 'arn:aws:sqs:eu-west-1:123456789012:dlq-orders'

describe('buildQueueAttributes — standard queues', () => {
  it('emits no FIFO-only attributes at all', () => {
    const attributes = buildQueueAttributes({ fifo: false })

    // Regression: the previous implementation always sent FifoQueue,
    // ContentBasedDeduplication, DeduplicationScope and FifoThroughputLimit,
    // which makes CreateQueue fail for a standard queue. Note that even
    // `FifoQueue: 'false'` is not accepted.
    expect(attributes).not.toHaveProperty('FifoQueue')
    expect(attributes).not.toHaveProperty('ContentBasedDeduplication')
    expect(attributes).not.toHaveProperty('DeduplicationScope')
    expect(attributes).not.toHaveProperty('FifoThroughputLimit')
  })

  it('never emits an empty RedrivePolicy', () => {
    // Regression: `RedrivePolicy: ''` was sent whenever no DLQ was configured,
    // and an empty string is not a valid attribute value.
    expect(buildQueueAttributes({ fifo: false })).not.toHaveProperty('RedrivePolicy')
  })

  it('rejects contentBasedDeduplication on a standard queue', () => {
    expect(() =>
      buildQueueAttributes({
        fifo: false,
        config: { contentBasedDeduplication: true },
      }),
    ).toThrow(InvalidQueueAttributeError)
  })

  it('rejects highThroughputFifo on a standard queue', () => {
    expect(() =>
      buildQueueAttributes({ fifo: false, config: { highThroughputFifo: true } }),
    ).toThrow(/FIFO queues only/)
  })
})

describe('buildQueueAttributes — FIFO queues', () => {
  it('marks the queue as FIFO', () => {
    expect(buildQueueAttributes({ fifo: true }).FifoQueue).toBe('true')
  })

  it('does not enable content-based deduplication implicitly', () => {
    // Regression: this used to be hardcoded to 'true', which silently discards
    // any two messages with identical bodies inside the 5-minute window.
    expect(buildQueueAttributes({ fifo: true })).not.toHaveProperty(
      'ContentBasedDeduplication',
    )
  })

  it('does not force high-throughput mode', () => {
    const attributes = buildQueueAttributes({ fifo: true })
    expect(attributes).not.toHaveProperty('DeduplicationScope')
    expect(attributes).not.toHaveProperty('FifoThroughputLimit')
  })

  it('enables content-based deduplication when asked', () => {
    const attributes = buildQueueAttributes({
      fifo: true,
      config: { contentBasedDeduplication: true },
    })
    expect(attributes.ContentBasedDeduplication).toBe('true')
  })

  it('moves the two high-throughput attributes together', () => {
    const on = buildQueueAttributes({
      fifo: true,
      config: { highThroughputFifo: true },
    })
    expect(on.DeduplicationScope).toBe('messageGroup')
    expect(on.FifoThroughputLimit).toBe('perMessageGroupId')

    const off = buildQueueAttributes({
      fifo: true,
      config: { highThroughputFifo: false },
    })
    expect(off.DeduplicationScope).toBe('queue')
    expect(off.FifoThroughputLimit).toBe('perQueue')
  })
})

describe('buildQueueAttributes — defaults and validation', () => {
  it('turns on long polling by default', () => {
    expect(buildQueueAttributes({ fifo: false }).ReceiveMessageWaitTimeSeconds).toBe(
      '20',
    )
  })

  it('respects an explicit long-poll duration', () => {
    const attributes = buildQueueAttributes({
      fifo: false,
      config: { receiveMessageWaitTimeSeconds: 5 },
    })
    expect(attributes.ReceiveMessageWaitTimeSeconds).toBe('5')
  })

  it('omits its own defaults when applyDefaults is false', () => {
    // Reconciliation must not write this library's opinions onto a live queue.
    const attributes = buildQueueAttributes({
      fifo: false,
      config: { visibilityTimeout: 45 },
      applyDefaults: false,
    })
    expect(attributes).not.toHaveProperty('ReceiveMessageWaitTimeSeconds')
    expect(attributes.VisibilityTimeout).toBe('45')
  })

  it.each([
    ['visibilityTimeout', 43_201],
    ['visibilityTimeout', -1],
    ['messageRetentionPeriod', 59],
    ['messageRetentionPeriod', 1_209_601],
    ['delaySeconds', 901],
    ['maximumMessageSize', 1_023],
    ['maximumMessageSize', 262_145],
    ['receiveMessageWaitTimeSeconds', 21],
    ['kmsDataKeyReusePeriodSeconds', 59],
  ])('rejects %s = %i as out of range', (field, value) => {
    expect(() =>
      buildQueueAttributes({ fifo: false, config: { [field]: value } }),
    ).toThrow(InvalidQueueAttributeError)
  })

  it('rejects a non-integer duration', () => {
    expect(() =>
      buildQueueAttributes({ fifo: false, config: { visibilityTimeout: 30.5 } }),
    ).toThrow(InvalidQueueAttributeError)
  })

  it('accepts the range boundaries', () => {
    const attributes = buildQueueAttributes({
      fifo: false,
      config: {
        visibilityTimeout: 0,
        messageRetentionPeriod: 60,
        delaySeconds: 900,
        maximumMessageSize: 262_144,
      },
    })
    expect(attributes.VisibilityTimeout).toBe('0')
    expect(attributes.MessageRetentionPeriod).toBe('60')
  })

  it('refuses both SQS-managed encryption and a KMS key', () => {
    expect(() =>
      buildQueueAttributes({
        fifo: false,
        config: { sseManaged: true, kmsMasterKeyId: 'alias/orders' },
      }),
    ).toThrow(/mutually exclusive/)
  })

  it('allows a KMS key when SQS-managed encryption is explicitly off', () => {
    const attributes = buildQueueAttributes({
      fifo: false,
      config: { sseManaged: false, kmsMasterKeyId: 'alias/orders' },
    })
    expect(attributes.KmsMasterKeyId).toBe('alias/orders')
    expect(attributes.SqsManagedSseEnabled).toBe('false')
  })

  it('stringifies an object policy', () => {
    const attributes = buildQueueAttributes({
      fifo: false,
      config: { policy: { Version: '2012-10-17' } },
    })
    expect(attributes.Policy).toBe('{"Version":"2012-10-17"}')
  })

  it('rejects a policy string that is not valid JSON', () => {
    expect(() =>
      buildQueueAttributes({ fifo: false, config: { policy: 'not json' } }),
    ).toThrow(/valid JSON/)
  })
})

describe('buildQueueAttributes — redrive policy', () => {
  it('writes the dead-letter target and threshold', () => {
    const attributes = buildQueueAttributes({
      fifo: false,
      redrive: { deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 3 },
    })
    expect(JSON.parse(attributes.RedrivePolicy!)).toEqual({
      deadLetterTargetArn: DLQ_ARN,
      maxReceiveCount: 3,
    })
  })

  it('validates the redrive threshold', () => {
    expect(() =>
      buildQueueAttributes({
        fifo: false,
        redrive: { deadLetterTargetArn: DLQ_ARN, maxReceiveCount: 0 },
      }),
    ).toThrow(InvalidQueueAttributeError)
  })
})

describe('validateMaxReceiveCount', () => {
  it.each([1, 500, 1000])('accepts %i', value => {
    expect(validateMaxReceiveCount(value)).toBe(value)
  })

  it.each([0, -1, 1001, 2.5])('rejects %s', value => {
    expect(() => validateMaxReceiveCount(value)).toThrow(InvalidQueueAttributeError)
  })
})

describe('diffAttributes', () => {
  it('returns only the attributes whose value differs', () => {
    const drift = diffAttributes(
      { VisibilityTimeout: '45', MessageRetentionPeriod: '3600' },
      { VisibilityTimeout: '30', MessageRetentionPeriod: '3600' },
    )
    expect(drift).toEqual({ VisibilityTimeout: '45' })
  })

  it('treats a missing current value as drift', () => {
    expect(diffAttributes({ VisibilityTimeout: '45' }, {})).toEqual({
      VisibilityTimeout: '45',
    })
  })

  it('never proposes changing FifoQueue, which SQS fixes at creation', () => {
    expect(diffAttributes({ FifoQueue: 'true' }, {})).toEqual({})
  })

  it('returns nothing when everything already matches', () => {
    expect(
      diffAttributes({ VisibilityTimeout: '30' }, { VisibilityTimeout: '30' }),
    ).toEqual({})
  })
})
