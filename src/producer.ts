import {
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
  type SendMessageBatchRequestEntry,
  type SendMessageCommandInput,
} from '@aws-sdk/client-sqs'
import {
  BatchSendError,
  InvalidMessageError,
  isAwsErrorNamed,
  QUEUE_NOT_FOUND_ERROR_NAMES,
} from './errors'
import { MAX_BATCH_ENTRIES, MAX_MESSAGE_SIZE_BYTES } from './internal/attributes'
import { QueueResolver, type ResolvedQueue } from './internal/queue-resolver'
import { silentLogger, type Logger } from './logger'
import type {
  ProducerConfig,
  SendBatchEntry,
  SendBatchOptions,
  SendBatchResult,
  SendMessageInput,
  SendMessageResult,
} from './types'

/** SQS constraint on batch entry ids. */
const BATCH_ENTRY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/

/** SQS range for a per-message delay, in seconds. */
const MAX_DELAY_SECONDS = 900

/** A prepared entry, sized once so chunking does not recompute it. */
interface PreparedEntry {
  id: string
  entry: SendBatchEntry
  size: number
}

/**
 * Publishes messages to a single SQS queue, provisioning it on first use when
 * `createIfNotExists` is set.
 *
 * The queue URL is resolved once and cached, so steady-state publishing costs
 * exactly one SQS call per send.
 *
 * @example
 * ```ts
 * const producer = new Producer({
 *   clientConfig: { region: 'eu-west-1' },
 *   queue: { name: 'orders', createIfNotExists: true, dlq: true },
 * })
 *
 * await producer.send({ body: JSON.stringify({ id: 1 }) })
 * ```
 */
export class Producer {
  private readonly client: SQSClient
  private readonly ownsClient: boolean
  private readonly resolver: QueueResolver
  private readonly logger: Logger
  private readonly config: ProducerConfig

  constructor(config: ProducerConfig) {
    this.config = config
    this.logger = config.logger ?? silentLogger

    if (config.client !== undefined) {
      this.client = config.client
      this.ownsClient = false
    } else {
      this.client = new SQSClient(config.clientConfig ?? {})
      this.ownsClient = true
    }

    this.resolver = new QueueResolver(this.client, this.logger)
  }

  /**
   * Resolve the queue URL, creating the queue first if configured to.
   *
   * Call this at startup to fail fast on a missing queue or bad credentials,
   * rather than on the first publish.
   */
  async queueUrl(): Promise<string> {
    return (await this.resolver.resolve(this.config.queue)).url
  }

  /** Publish a single message. */
  async send(message: SendMessageInput): Promise<SendMessageResult> {
    const queue = await this.resolver.resolve(this.config.queue)
    this.validateMessage(message, queue, 'message')

    const result = await this.withStaleQueueRetry(queue, url =>
      this.client.send(new SendMessageCommand(buildSendInput(url, message))),
    )

    return {
      messageId: result.MessageId,
      sequenceNumber: result.SequenceNumber,
      md5OfMessageBody: result.MD5OfMessageBody,
    }
  }

  /**
   * Publish many messages, splitting them across as many `SendMessageBatch`
   * calls as needed.
   *
   * Batches are bounded by both of SQS's limits — 10 entries and 256 KiB of
   * combined payload — so a large batch is chunked rather than rejected.
   *
   * Partial failure is normal for SQS batches: entries can fail individually
   * within a successful response. By default any failure raises
   * {@link BatchSendError}, which carries the per-entry breakdown so a retry can
   * target only what did not land instead of duplicating what did.
   */
  async sendBatch(
    entries: readonly SendBatchEntry[],
    options?: SendBatchOptions,
  ): Promise<SendBatchResult> {
    const result: SendBatchResult = { successful: [], failed: [] }
    if (entries.length === 0) {
      return result
    }

    const queue = await this.resolver.resolve(this.config.queue)
    const prepared = entries.map((entry, index) => {
      const id = entry.id ?? `entry-${index}`
      if (!BATCH_ENTRY_ID_PATTERN.test(id)) {
        throw new InvalidMessageError(
          `Batch entry id "${id}" is not valid. SQS accepts up to 80 alphanumeric ` +
            `characters, hyphens and underscores.`,
        )
      }
      this.validateMessage(entry, queue, `entry "${id}"`)
      return { id, entry, size: messageByteSize(entry) } satisfies PreparedEntry
    })

    assertUniqueIds(prepared)

    for (const chunk of chunkEntries(prepared)) {
      const response = await this.withStaleQueueRetry(queue, url =>
        this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: url,
            Entries: chunk.map(item => buildBatchEntry(item.id, item.entry)),
          }),
        ),
      )

      for (const success of response.Successful ?? []) {
        result.successful.push({
          id: success.Id ?? '',
          messageId: success.MessageId,
          sequenceNumber: success.SequenceNumber,
        })
      }
      for (const failure of response.Failed ?? []) {
        result.failed.push({
          id: failure.Id ?? '',
          code: failure.Code,
          message: failure.Message,
          senderFault: failure.SenderFault ?? false,
        })
      }
    }

    if (result.failed.length > 0) {
      this.logger.warn('batch send completed with failures', {
        queue: queue.name,
        failed: result.failed.length,
        successful: result.successful.length,
      })

      if (options?.throwOnFailure ?? true) {
        throw new BatchSendError(result.failed, result.successful)
      }
    }

    return result
  }

  /**
   * Release the underlying SQS client.
   *
   * Only closes a client this producer created — one passed in via `client`
   * belongs to the caller and is left open.
   */
  destroy(): Promise<void> {
    if (this.ownsClient) {
      this.client.destroy()
    }
    return Promise.resolve()
  }

  /**
   * Retry once against a freshly resolved URL if SQS says the queue is gone.
   *
   * A cached URL can outlive the queue it points at — someone deletes and
   * recreates it, or a test tears its queue down between runs. Re-resolving
   * turns a hard failure into a transparent recovery, and recreates the queue
   * when `createIfNotExists` is set.
   */
  private async withStaleQueueRetry<T>(
    queue: ResolvedQueue,
    operation: (queueUrl: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(queue.url)
    } catch (error) {
      if (!isAwsErrorNamed(error, ...QUEUE_NOT_FOUND_ERROR_NAMES)) {
        throw error
      }

      this.logger.warn('cached queue URL is no longer valid; re-resolving', {
        queue: queue.name,
      })
      this.resolver.invalidate(queue.name)
      const refreshed = await this.resolver.resolve(this.config.queue)
      return operation(refreshed.url)
    }
  }

  /**
   * Reject messages SQS would reject, naming the actual problem.
   *
   * Deliberately does *not* require `deduplicationId` on FIFO queues: whether a
   * queue has content-based deduplication enabled is only known for queues this
   * library created, so inferring it risks refusing a message SQS would accept.
   * SQS's own error for that case already says what to do.
   */
  private validateMessage(
    message: SendMessageInput,
    queue: ResolvedQueue,
    label: string,
  ): void {
    if (typeof message.body !== 'string' || message.body.length === 0) {
      throw new InvalidMessageError(`${label}: \`body\` must be a non-empty string.`)
    }

    const size = messageByteSize(message)
    if (size > MAX_MESSAGE_SIZE_BYTES) {
      throw new InvalidMessageError(
        `${label}: message is ${size} bytes; SQS accepts at most ` +
          `${MAX_MESSAGE_SIZE_BYTES} (256 KiB). Store the payload elsewhere and send ` +
          `a reference to it.`,
      )
    }

    if (
      message.delaySeconds !== undefined &&
      (!Number.isInteger(message.delaySeconds) ||
        message.delaySeconds < 0 ||
        message.delaySeconds > MAX_DELAY_SECONDS)
    ) {
      throw new InvalidMessageError(
        `${label}: \`delaySeconds\` must be an integer between 0 and ${MAX_DELAY_SECONDS}.`,
      )
    }

    if (queue.fifo) {
      if (message.groupId === undefined) {
        throw new InvalidMessageError(
          `${label}: "${queue.name}" is a FIFO queue, so every message needs a ` +
            `\`groupId\`. Messages sharing a group id are delivered in order; use ` +
            `separate group ids for streams that may proceed independently.`,
        )
      }
      if (message.delaySeconds !== undefined) {
        throw new InvalidMessageError(
          `${label}: FIFO queues do not support per-message delays. Set ` +
            `\`attributes.delaySeconds\` on the queue config instead.`,
        )
      }
    } else if (message.groupId !== undefined || message.deduplicationId !== undefined) {
      throw new InvalidMessageError(
        `${label}: \`groupId\` and \`deduplicationId\` apply to FIFO queues only. ` +
          `Set \`fifo: true\` on the queue config if "${queue.name}" is meant to be FIFO.`,
      )
    }
  }
}

/**
 * Build a fresh `SendMessage` input.
 *
 * Nothing from the caller's object is reused or written back. An earlier version
 * of this package assigned the resolved queue URL onto the caller's input, so
 * reusing one options object across sends silently corrupted every later call.
 */
function buildSendInput(
  queueUrl: string,
  message: SendMessageInput,
): SendMessageCommandInput {
  return {
    QueueUrl: queueUrl,
    MessageBody: message.body,
    ...(message.groupId !== undefined ? { MessageGroupId: message.groupId } : {}),
    ...(message.deduplicationId !== undefined
      ? { MessageDeduplicationId: message.deduplicationId }
      : {}),
    ...(message.delaySeconds !== undefined
      ? { DelaySeconds: message.delaySeconds }
      : {}),
    ...(message.attributes !== undefined
      ? { MessageAttributes: message.attributes }
      : {}),
    ...(message.systemAttributes !== undefined
      ? { MessageSystemAttributes: message.systemAttributes }
      : {}),
  }
}

function buildBatchEntry(
  id: string,
  message: SendBatchEntry,
): SendMessageBatchRequestEntry {
  return {
    Id: id,
    MessageBody: message.body,
    ...(message.groupId !== undefined ? { MessageGroupId: message.groupId } : {}),
    ...(message.deduplicationId !== undefined
      ? { MessageDeduplicationId: message.deduplicationId }
      : {}),
    ...(message.delaySeconds !== undefined
      ? { DelaySeconds: message.delaySeconds }
      : {}),
    ...(message.attributes !== undefined
      ? { MessageAttributes: message.attributes }
      : {}),
    ...(message.systemAttributes !== undefined
      ? { MessageSystemAttributes: message.systemAttributes }
      : {}),
  }
}

/**
 * Approximate the size SQS accounts for: the UTF-8 body plus each attribute's
 * name, data type and value.
 */
function messageByteSize(message: SendMessageInput): number {
  let size = Buffer.byteLength(message.body, 'utf8')

  for (const [name, value] of Object.entries(message.attributes ?? {})) {
    size += Buffer.byteLength(name, 'utf8')
    size += Buffer.byteLength(value.DataType ?? '', 'utf8')
    if (value.StringValue !== undefined) {
      size += Buffer.byteLength(value.StringValue, 'utf8')
    }
    if (value.BinaryValue !== undefined) {
      size += value.BinaryValue.byteLength
    }
  }

  return size
}

/**
 * Split entries into batches within both SQS limits: 10 entries and 256 KiB of
 * combined payload.
 *
 * Individually oversized entries are rejected during validation, so every entry
 * reaching here fits in a batch of its own.
 */
function chunkEntries(entries: readonly PreparedEntry[]): PreparedEntry[][] {
  const chunks: PreparedEntry[][] = []
  let current: PreparedEntry[] = []
  let currentSize = 0

  for (const entry of entries) {
    const overflowsSize =
      current.length > 0 && currentSize + entry.size > MAX_MESSAGE_SIZE_BYTES
    const overflowsCount = current.length >= MAX_BATCH_ENTRIES

    if (overflowsSize || overflowsCount) {
      chunks.push(current)
      current = []
      currentSize = 0
    }

    current.push(entry)
    currentSize += entry.size
  }

  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

function assertUniqueIds(entries: readonly PreparedEntry[]): void {
  const seen = new Set<string>()
  for (const { id } of entries) {
    if (seen.has(id)) {
      throw new InvalidMessageError(
        `Duplicate batch entry id "${id}". SQS requires entry ids to be unique ` +
          `within a batch.`,
      )
    }
    seen.add(id)
  }
}
