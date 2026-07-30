import { InvalidQueueNameError } from '../errors'

/** Suffix SQS reserves for FIFO queues. */
export const FIFO_SUFFIX = '.fifo'

/** SQS quota: queue names may be at most 80 characters, including any `.fifo` suffix. */
export const MAX_QUEUE_NAME_LENGTH = 80

/** SQS allows alphanumerics, hyphens and underscores in the base name. */
const BASE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/** Default prefix applied when deriving a dead-letter queue name. */
export const DEFAULT_DLQ_PREFIX = 'dlq-'

/**
 * A queue name that has been validated and had its FIFO suffix normalised.
 */
export interface ResolvedQueueName {
  /** The name to send to SQS, including `.fifo` when the queue is FIFO. */
  readonly name: string
  /** The name without any `.fifo` suffix. */
  readonly base: string
  /** Whether this resolves to a FIFO queue. */
  readonly fifo: boolean
}

/**
 * Validate a configured queue name and settle whether it is FIFO.
 *
 * Applying the `.fifo` suffix is idempotent: passing `"orders"` or
 * `"orders.fifo"` with `fifo: true` both yield `"orders.fifo"`, so a resolved
 * name can be fed back in without growing a second suffix.
 *
 * When `fifo` is omitted it is inferred from the presence of the suffix.
 * Passing `fifo: false` alongside a `.fifo` name is a contradiction and throws,
 * rather than silently creating a standard queue under a different name.
 */
export function resolveQueueName(rawName: string, fifo?: boolean): ResolvedQueueName {
  if (typeof rawName !== 'string') {
    throw new InvalidQueueNameError(
      `Queue name must be a string, received ${typeof rawName}.`,
    )
  }

  const trimmed = rawName.trim()
  if (trimmed.length === 0) {
    throw new InvalidQueueNameError('Queue name must not be empty.')
  }

  const hasSuffix = trimmed.endsWith(FIFO_SUFFIX)
  if (hasSuffix && fifo === false) {
    throw new InvalidQueueNameError(
      `Queue name "${trimmed}" ends with "${FIFO_SUFFIX}", which SQS reserves for ` +
        `FIFO queues, but \`fifo: false\` was set. Remove the suffix or set \`fifo: true\`.`,
    )
  }

  const isFifo = fifo ?? hasSuffix
  const base = hasSuffix ? trimmed.slice(0, -FIFO_SUFFIX.length) : trimmed

  if (!BASE_NAME_PATTERN.test(base)) {
    throw new InvalidQueueNameError(
      `Queue name "${trimmed}" is not valid. SQS accepts alphanumeric characters, ` +
        `hyphens and underscores${isFifo ? `, plus the "${FIFO_SUFFIX}" suffix` : ''}.`,
    )
  }

  const name = isFifo ? `${base}${FIFO_SUFFIX}` : base
  if (name.length > MAX_QUEUE_NAME_LENGTH) {
    throw new InvalidQueueNameError(
      `Queue name "${name}" is ${name.length} characters; SQS allows at most ` +
        `${MAX_QUEUE_NAME_LENGTH}${isFifo ? ` (the "${FIFO_SUFFIX}" suffix counts toward the limit)` : ''}.`,
    )
  }

  return { name, base, fifo: isFifo }
}

/**
 * Derive the dead-letter queue name for a primary queue.
 *
 * The suffix is re-applied after prefixing, so the DLQ for `orders.fifo`
 * is `dlq-orders.fifo` — a valid FIFO name — not `dlq-orders`.
 *
 * A FIFO queue's dead-letter queue must itself be FIFO (and a standard queue's
 * must be standard), so the queue type is always inherited.
 */
export function deadLetterQueueName(
  primary: ResolvedQueueName,
  override?: string,
): ResolvedQueueName {
  if (override !== undefined) {
    return resolveQueueName(override, primary.fifo)
  }

  const candidate = `${DEFAULT_DLQ_PREFIX}${primary.base}`
  try {
    return resolveQueueName(candidate, primary.fifo)
  } catch (cause) {
    throw new InvalidQueueNameError(
      `Cannot derive a dead-letter queue name for "${primary.name}": the default ` +
        `"${DEFAULT_DLQ_PREFIX}" prefix produces an invalid name. Set \`dlq.name\` explicitly.`,
      { cause },
    )
  }
}
