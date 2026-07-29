/**
 * Stable, machine-readable codes attached to every {@link HeadlessSqsError}.
 *
 * Branch on `error.code` rather than matching messages — messages may be
 * reworded in any release, codes are part of the public API.
 */
export type HeadlessSqsErrorCode =
  | 'INVALID_QUEUE_NAME'
  | 'INVALID_QUEUE_ATTRIBUTE'
  | 'INVALID_MESSAGE'
  | 'QUEUE_NOT_FOUND'
  | 'QUEUE_PROVISIONING_FAILED'
  | 'BATCH_SEND_FAILED'
  | 'ILLEGAL_STATE'

/** Base class for every error this package throws deliberately. */
export class HeadlessSqsError extends Error {
  readonly code: HeadlessSqsErrorCode

  constructor(
    code: HeadlessSqsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.code = code
    this.name = this.constructor.name
    // Trim the constructor frames so the stack points at the caller.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

/** The configured queue name cannot be a valid SQS queue name. */
export class InvalidQueueNameError extends HeadlessSqsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INVALID_QUEUE_NAME', message, options)
  }
}

/** A queue attribute is outside the range SQS accepts, or is not valid for this queue type. */
export class InvalidQueueAttributeError extends HeadlessSqsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INVALID_QUEUE_ATTRIBUTE', message, options)
  }
}

/** The outgoing message is missing something SQS requires (e.g. a FIFO group id). */
export class InvalidMessageError extends HeadlessSqsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INVALID_MESSAGE', message, options)
  }
}

/**
 * The queue does not exist and auto-provisioning was not enabled.
 *
 * Set `createIfNotExists: true` on the queue config to have it created on demand.
 */
export class QueueNotFoundError extends HeadlessSqsError {
  readonly queueName: string

  constructor(queueName: string, options?: { cause?: unknown }) {
    super(
      'QUEUE_NOT_FOUND',
      `Queue "${queueName}" does not exist. Create it up front, or set ` +
        `\`createIfNotExists: true\` to have headless-sqs provision it on demand.`,
      options,
    )
    this.queueName = queueName
  }
}

/** Provisioning a queue (or its dead-letter queue) failed. */
export class QueueProvisioningError extends HeadlessSqsError {
  readonly queueName: string

  constructor(queueName: string, message: string, options?: { cause?: unknown }) {
    super('QUEUE_PROVISIONING_FAILED', message, options)
    this.queueName = queueName
  }
}

/** One entry of a partially-failed batch send. */
export interface FailedBatchEntry {
  /** Batch entry id — matches the index-derived id unless you supplied your own. */
  id: string
  /** SQS error code, e.g. `InvalidParameterValue`. */
  code: string | undefined
  message: string | undefined
  /** Whether SQS attributed the failure to the sender. */
  senderFault: boolean
}

/**
 * Raised when {@link Producer.sendBatch} could not deliver every message and
 * `throwOnFailure` was left enabled.
 *
 * Inspect {@link BatchSendError.failed} to retry only what did not land — the
 * messages in {@link BatchSendError.successful} were accepted and would be
 * duplicated by a blind retry of the whole batch.
 */
export class BatchSendError extends HeadlessSqsError {
  readonly failed: readonly FailedBatchEntry[]
  readonly successful: readonly { id: string; messageId: string | undefined }[]

  constructor(
    failed: readonly FailedBatchEntry[],
    successful: readonly { id: string; messageId: string | undefined }[],
  ) {
    super(
      'BATCH_SEND_FAILED',
      `${failed.length} of ${failed.length + successful.length} messages failed to send. ` +
        `Retry only the entries in \`error.failed\` — the rest were accepted.`,
    )
    this.failed = failed
    this.successful = successful
  }
}

/** An operation was attempted in a state that does not allow it. */
export class IllegalStateError extends HeadlessSqsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ILLEGAL_STATE', message, options)
  }
}

/** Type guard for errors originating from this package. */
export function isHeadlessSqsError(error: unknown): error is HeadlessSqsError {
  return error instanceof HeadlessSqsError
}

/**
 * Error names SQS uses to report a queue that does not exist.
 *
 * The legacy `AWS.SimpleQueueService.*` form still appears from some endpoints
 * and SDK versions, so both are matched.
 */
export const QUEUE_NOT_FOUND_ERROR_NAMES: readonly string[] = [
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
]

/**
 * Match an AWS SDK error by its `name` rather than `instanceof`.
 *
 * `instanceof` silently returns `false` when more than one copy of
 * `@aws-sdk/client-sqs` is resolved in the dependency tree — which would make
 * auto-provisioning quietly stop working. Names are stable across copies.
 */
export function isAwsErrorNamed(error: unknown, ...names: string[]): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && names.includes(name)
}
