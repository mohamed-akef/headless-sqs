import { QueueAttributeName } from '@aws-sdk/client-sqs'
import { InvalidQueueAttributeError } from '../errors'
import type { QueueAttributesConfig } from '../types'

/** Attribute map in the shape `CreateQueue` / `SetQueueAttributes` expect. */
export type QueueAttributeMap = Partial<Record<QueueAttributeName, string>>

/** SQS quota: a single message (body plus attributes) may not exceed 256 KiB. */
export const MAX_MESSAGE_SIZE_BYTES = 262_144

/** SQS quota: at most 10 entries per batch request. */
export const MAX_BATCH_ENTRIES = 10

/** Long polling, applied to queues we create unless overridden. */
export const DEFAULT_RECEIVE_WAIT_TIME_SECONDS = 20

/** Redrive threshold used when a dead-letter queue is requested without one. */
export const DEFAULT_MAX_RECEIVE_COUNT = 5

/** Inclusive bounds SQS enforces on each numeric attribute. */
const NUMERIC_RANGES = {
  visibilityTimeout: [0, 43_200],
  messageRetentionPeriod: [60, 1_209_600],
  delaySeconds: [0, 900],
  maximumMessageSize: [1_024, MAX_MESSAGE_SIZE_BYTES],
  receiveMessageWaitTimeSeconds: [0, 20],
  kmsDataKeyReusePeriodSeconds: [60, 86_400],
} as const satisfies Record<string, readonly [number, number]>

type NumericField = keyof typeof NUMERIC_RANGES

const NUMERIC_ATTRIBUTES: readonly {
  field: NumericField
  attribute: QueueAttributeName
}[] = [
  { field: 'visibilityTimeout', attribute: QueueAttributeName.VisibilityTimeout },
  {
    field: 'messageRetentionPeriod',
    attribute: QueueAttributeName.MessageRetentionPeriod,
  },
  { field: 'delaySeconds', attribute: QueueAttributeName.DelaySeconds },
  { field: 'maximumMessageSize', attribute: QueueAttributeName.MaximumMessageSize },
  {
    field: 'receiveMessageWaitTimeSeconds',
    attribute: QueueAttributeName.ReceiveMessageWaitTimeSeconds,
  },
  {
    field: 'kmsDataKeyReusePeriodSeconds',
    attribute: QueueAttributeName.KmsDataKeyReusePeriodSeconds,
  },
]

/** Attributes valid only on FIFO queues, with the config field that sets each. */
const FIFO_ONLY_FIELDS = [
  'contentBasedDeduplication',
  'highThroughputFifo',
] as const satisfies readonly (keyof QueueAttributesConfig)[]

function requireIntInRange(
  field: string,
  value: number,
  [min, max]: readonly [number, number],
): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidQueueAttributeError(
      `\`${field}\` must be an integer between ${min} and ${max}, received ${String(value)}.`,
    )
  }
  return String(value)
}

function stringifyPolicy(
  field: string,
  value: string | Record<string, unknown>,
): string {
  if (typeof value !== 'string') {
    return JSON.stringify(value)
  }
  // Fail here with a pointer at the offending field rather than letting SQS
  // reject the whole CreateQueue call with a generic message.
  try {
    JSON.parse(value)
  } catch (cause) {
    throw new InvalidQueueAttributeError(
      `\`${field}\` must be valid JSON when given as a string.`,
      { cause },
    )
  }
  return value
}

/** Validate a redrive threshold against SQS's 1–1000 range. */
export function validateMaxReceiveCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new InvalidQueueAttributeError(
      `\`maxReceiveCount\` must be an integer between 1 and 1000, received ${String(value)}.`,
    )
  }
  return value
}

/** Redrive policy inputs, resolved once the dead-letter queue ARN is known. */
export interface RedrivePolicyInput {
  deadLetterTargetArn: string
  maxReceiveCount: number
}

/**
 * Build the attribute map for a `CreateQueue` call.
 *
 * Every attribute is conditional. In particular:
 *
 * - FIFO-only attributes (`FifoQueue`, `ContentBasedDeduplication`,
 *   `DeduplicationScope`, `FifoThroughputLimit`) are emitted **only** for FIFO
 *   queues; `DeduplicationScope` and `FifoThroughputLimit` in particular make
 *   SQS reject the creation of a standard queue.
 * - `RedrivePolicy` is emitted only when a dead-letter target exists. An empty
 *   string is not a valid attribute value.
 * - Attributes the caller did not set are omitted so the AWS defaults apply,
 *   rather than being pinned to this library's opinion.
 */
export function buildQueueAttributes(params: {
  fifo: boolean
  config?: QueueAttributesConfig | undefined
  redrive?: RedrivePolicyInput | undefined
  /**
   * Apply this library's create-time defaults (currently long polling).
   *
   * Pass `false` when diffing against a queue that already exists, so
   * reconciliation only ever touches attributes the caller actually asked for
   * — otherwise a default would be silently written over the live value.
   */
  applyDefaults?: boolean | undefined
}): QueueAttributeMap {
  const { fifo, redrive } = params
  const config = params.config ?? {}
  const applyDefaults = params.applyDefaults ?? true
  const attributes: QueueAttributeMap = {}

  if (fifo) {
    attributes[QueueAttributeName.FifoQueue] = 'true'

    if (config.contentBasedDeduplication !== undefined) {
      attributes[QueueAttributeName.ContentBasedDeduplication] = String(
        config.contentBasedDeduplication,
      )
    }

    if (config.highThroughputFifo !== undefined) {
      // These two must move together: SQS rejects `perMessageGroupId` unless
      // the deduplication scope is also `messageGroup`.
      attributes[QueueAttributeName.DeduplicationScope] = config.highThroughputFifo
        ? 'messageGroup'
        : 'queue'
      attributes[QueueAttributeName.FifoThroughputLimit] = config.highThroughputFifo
        ? 'perMessageGroupId'
        : 'perQueue'
    }
  } else {
    for (const field of FIFO_ONLY_FIELDS) {
      if (config[field] !== undefined) {
        throw new InvalidQueueAttributeError(
          `\`${field}\` applies to FIFO queues only. Set \`fifo: true\` on the ` +
            `queue config, or remove the attribute.`,
        )
      }
    }
  }

  for (const { field, attribute } of NUMERIC_ATTRIBUTES) {
    const value = config[field]
    if (value !== undefined) {
      attributes[attribute] = requireIntInRange(field, value, NUMERIC_RANGES[field])
    }
  }

  // Long polling by default: short polling bills more requests and adds
  // latency, and forgetting to enable it is a common SQS mistake.
  if (applyDefaults && config.receiveMessageWaitTimeSeconds === undefined) {
    attributes[QueueAttributeName.ReceiveMessageWaitTimeSeconds] = String(
      DEFAULT_RECEIVE_WAIT_TIME_SECONDS,
    )
  }

  if (config.sseManaged === true && config.kmsMasterKeyId !== undefined) {
    throw new InvalidQueueAttributeError(
      '`sseManaged` and `kmsMasterKeyId` are mutually exclusive: SQS-managed ' +
        'encryption and a customer-managed KMS key cannot both be enabled.',
    )
  }
  if (config.sseManaged !== undefined) {
    attributes[QueueAttributeName.SqsManagedSseEnabled] = String(config.sseManaged)
  }
  if (config.kmsMasterKeyId !== undefined) {
    attributes[QueueAttributeName.KmsMasterKeyId] = config.kmsMasterKeyId
  }

  if (config.policy !== undefined) {
    attributes[QueueAttributeName.Policy] = stringifyPolicy('policy', config.policy)
  }
  if (config.redriveAllowPolicy !== undefined) {
    attributes[QueueAttributeName.RedriveAllowPolicy] = stringifyPolicy(
      'redriveAllowPolicy',
      config.redriveAllowPolicy,
    )
  }

  if (redrive !== undefined) {
    attributes[QueueAttributeName.RedrivePolicy] = JSON.stringify({
      deadLetterTargetArn: redrive.deadLetterTargetArn,
      maxReceiveCount: validateMaxReceiveCount(redrive.maxReceiveCount),
    })
  }

  return attributes
}

/**
 * Attributes that cannot be changed after a queue is created, and so are
 * excluded from reconciliation.
 */
const IMMUTABLE_ATTRIBUTES: readonly QueueAttributeName[] = [
  QueueAttributeName.FifoQueue,
]

/**
 * Return the subset of `desired` whose value differs from `actual`.
 *
 * Used by attribute reconciliation so `SetQueueAttributes` is called only when
 * something genuinely drifted, and never for attributes SQS treats as
 * create-time only.
 */
export function diffAttributes(
  desired: QueueAttributeMap,
  actual: Record<string, string | undefined>,
): QueueAttributeMap {
  const drifted: QueueAttributeMap = {}

  for (const [key, value] of Object.entries(desired) as [
    QueueAttributeName,
    string,
  ][]) {
    if (IMMUTABLE_ATTRIBUTES.includes(key)) continue
    if (actual[key] !== value) {
      drifted[key] = value
    }
  }

  return drifted
}
