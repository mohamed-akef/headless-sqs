import type {
  Message,
  MessageSystemAttributeName,
  SQSClient,
} from '@aws-sdk/client-sqs'
import {
  ChangeMessageVisibilityBatchCommand,
  SQSClient as SqsClientCtor,
} from '@aws-sdk/client-sqs'
import { EventEmitter } from 'node:events'
import { Consumer as SqsConsumer, type ConsumerOptions } from 'sqs-consumer'
import { IllegalStateError, InvalidQueueAttributeError } from './errors'
import {
  processOrderedByGroup,
  processUnordered,
  type BatchOutcome,
} from './internal/process-batch'
import { QueueResolver, type ResolvedQueue } from './internal/queue-resolver'
import { silentLogger, type Logger } from './logger'
import type { ConsumerConfig, ConsumerEvents } from './types'

/** SQS quota: at most 10 messages per receive. */
const MAX_BATCH_SIZE = 10
const DEFAULT_BATCH_SIZE = 10

/** Attribute needed to group FIFO messages for ordered processing. */
const MESSAGE_GROUP_ID_ATTRIBUTE: MessageSystemAttributeName = 'MessageGroupId'

/** Options accepted by {@link Consumer.stop}. */
export interface StopOptions {
  /** Also abort in-flight requests to SQS rather than letting them finish. */
  abort?: boolean

  /**
   * Give up waiting after this many milliseconds and return anyway.
   *
   * Omitted by default, so `stop()` waits as long as the in-flight handlers
   * need. Set it when a shutdown path must not be able to block forever.
   */
  timeoutMs?: number
}

/**
 * Consumes messages from a single SQS queue.
 *
 * Compared with driving `sqs-consumer` directly, this adds three things that are
 * easy to get wrong:
 *
 * - **Per-message acknowledgement.** A batch where one message fails deletes the
 *   nine that succeeded and redelivers only the failure, instead of redelivering
 *   — and reprocessing — the whole batch.
 * - **FIFO ordering that still scales.** SQS only orders messages within a
 *   message group, so groups are processed in parallel and messages within a
 *   group in sequence. A failure halts just its own group.
 * - **A real `stop()`.** Stopping acts on the running poller and resolves once it
 *   has actually stopped.
 *
 * @example
 * ```ts
 * const consumer = new Consumer({
 *   clientConfig: { region: 'eu-west-1' },
 *   queue: { name: 'orders' },
 *   handler: async message => {
 *     await handleOrder(JSON.parse(message.Body ?? '{}'))
 *   },
 * })
 *
 * consumer.on('processing_error', error => reportToSentry(error))
 * await consumer.start()
 *
 * process.once('SIGTERM', () => void consumer.stop())
 * ```
 */
export class Consumer extends EventEmitter<ConsumerEvents> {
  private readonly config: ConsumerConfig
  private readonly client: SQSClient
  private readonly ownsClient: boolean
  private readonly resolver: QueueResolver
  private readonly logger: Logger
  private readonly batchSize: number
  private readonly concurrency: number

  private poller: SqsConsumer | undefined
  private starting: Promise<void> | undefined

  constructor(config: ConsumerConfig) {
    super()
    this.config = config
    this.logger = config.logger ?? silentLogger

    if (typeof config.handler !== 'function') {
      throw new IllegalStateError('`handler` must be a function.')
    }

    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > MAX_BATCH_SIZE
    ) {
      throw new InvalidQueueAttributeError(
        `\`batchSize\` must be an integer between 1 and ${MAX_BATCH_SIZE}, ` +
          `received ${String(config.batchSize)}.`,
      )
    }

    this.concurrency = config.concurrency ?? this.batchSize
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new InvalidQueueAttributeError(
        `\`concurrency\` must be a positive integer, received ${String(config.concurrency)}.`,
      )
    }

    if (
      config.waitTimeSeconds !== undefined &&
      (!Number.isInteger(config.waitTimeSeconds) ||
        config.waitTimeSeconds < 0 ||
        config.waitTimeSeconds > 20)
    ) {
      throw new InvalidQueueAttributeError(
        `\`waitTimeSeconds\` must be an integer between 0 and 20, received ` +
          `${String(config.waitTimeSeconds)}.`,
      )
    }

    // The heartbeat extends visibility by adding `visibilityTimeout`; if it fires
    // no more often than the timeout itself, messages can become visible again
    // mid-processing and be delivered to a second consumer.
    if (config.heartbeatInterval !== undefined) {
      if (config.visibilityTimeout === undefined) {
        throw new InvalidQueueAttributeError(
          '`heartbeatInterval` requires `visibilityTimeout` to be set as well.',
        )
      }
      if (config.heartbeatInterval >= config.visibilityTimeout) {
        throw new InvalidQueueAttributeError(
          `\`heartbeatInterval\` (${config.heartbeatInterval}) must be less than ` +
            `\`visibilityTimeout\` (${config.visibilityTimeout}).`,
        )
      }
    }

    if (config.client !== undefined) {
      this.client = config.client
      this.ownsClient = false
    } else {
      this.client = new SqsClientCtor(config.clientConfig ?? {})
      this.ownsClient = true
    }

    this.resolver = new QueueResolver(this.client, this.logger)
  }

  /** Whether the underlying poller is currently polling. */
  get isRunning(): boolean {
    return this.poller?.status.isRunning ?? false
  }

  /**
   * Resolve the queue URL, creating the queue first if configured to.
   */
  async queueUrl(): Promise<string> {
    return (await this.resolver.resolve(this.config.queue)).url
  }

  /**
   * Resolve the queue and begin polling.
   *
   * Idempotent: calling it while already running, or while a concurrent start is
   * in progress, does not create a second poller.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return
    }
    if (this.starting !== undefined) {
      return this.starting
    }

    this.starting = this.doStart().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /**
   * Stop polling and wait until the poller has actually stopped.
   *
   * The previous release created a *new* consumer inside `stop()` and stopped
   * that, leaving the running one polling forever; stopping now acts on the
   * poller this instance started.
   *
   * In-flight handlers are allowed to finish, so awaiting this is a graceful
   * drain. Pass `abort: true` to cut in-flight SQS requests short.
   */
  async stop(options?: StopOptions): Promise<void> {
    const poller = this.poller

    if (this.starting !== undefined) {
      // Let an in-progress start settle first, otherwise it would install a
      // poller moments after we finished stopping.
      await this.starting.catch(() => undefined)
    }

    const active = this.poller ?? poller
    if (active === undefined) {
      return
    }
    if (!active.status.isRunning) {
      this.poller = undefined
      return
    }

    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }

      const timer =
        options?.timeoutMs !== undefined
          ? setTimeout(() => {
              this.logger.warn('stop() timed out waiting for the poller to drain', {
                timeoutMs: options.timeoutMs,
              })
              finish()
            }, options.timeoutMs)
          : undefined

      // Registered before stop() because sqs-consumer may emit synchronously.
      active.once('stopped', finish)
      active.stop(options?.abort === true ? { abort: true } : {})
    })

    this.poller = undefined
    this.logger.debug('consumer stopped', { queue: this.config.queue.name })
  }

  /**
   * Stop the consumer and release the SQS client if this instance created it.
   */
  async destroy(options?: StopOptions): Promise<void> {
    await this.stop(options)
    if (this.ownsClient) {
      this.client.destroy()
    }
  }

  private async doStart(): Promise<void> {
    const queue = await this.resolver.resolve(this.config.queue)
    const poller = SqsConsumer.create(this.buildPollerOptions(queue))

    this.forwardEvents(poller)
    this.poller = poller
    poller.start()

    this.logger.info('consumer started', {
      queue: queue.name,
      fifo: queue.fifo,
      batchSize: this.batchSize,
      concurrency: this.concurrency,
    })
  }

  private buildPollerOptions(queue: ResolvedQueue): ConsumerOptions {
    const config = this.config

    return {
      queueUrl: queue.url,
      sqs: this.client,
      batchSize: this.batchSize,
      messageSystemAttributeNames: this.resolveSystemAttributeNames(queue),
      handleMessageBatch: messages => this.processBatch(messages, queue),
      ...(config.attributeNames !== undefined
        ? { attributeNames: config.attributeNames }
        : {}),
      ...(config.messageAttributeNames !== undefined
        ? { messageAttributeNames: config.messageAttributeNames }
        : {}),
      ...(config.visibilityTimeout !== undefined
        ? { visibilityTimeout: config.visibilityTimeout }
        : {}),
      ...(config.waitTimeSeconds !== undefined
        ? { waitTimeSeconds: config.waitTimeSeconds }
        : {}),
      ...(config.pollingWaitTimeMs !== undefined
        ? { pollingWaitTimeMs: config.pollingWaitTimeMs }
        : {}),
      ...(config.heartbeatInterval !== undefined
        ? { heartbeatInterval: config.heartbeatInterval }
        : {}),
      ...(config.handleMessageTimeout !== undefined
        ? { handleMessageTimeout: config.handleMessageTimeout }
        : {}),
      ...(config.terminateVisibilityTimeout !== undefined
        ? { terminateVisibilityTimeout: config.terminateVisibilityTimeout }
        : {}),
      ...(config.shouldDeleteMessages !== undefined
        ? { shouldDeleteMessages: config.shouldDeleteMessages }
        : {}),
      ...(config.authenticationErrorTimeout !== undefined
        ? { authenticationErrorTimeout: config.authenticationErrorTimeout }
        : {}),
    }
  }

  /**
   * FIFO queues always request `MessageGroupId`: without it messages cannot be
   * grouped, and processing falls back to serialising the entire batch.
   */
  private resolveSystemAttributeNames(
    queue: ResolvedQueue,
  ): MessageSystemAttributeName[] {
    const configured = this.config.messageSystemAttributeNames ?? []
    if (!queue.fifo) {
      return [...configured]
    }

    const alreadyRequested =
      configured.includes(MESSAGE_GROUP_ID_ATTRIBUTE) || configured.includes('All')
    return alreadyRequested
      ? [...configured]
      : [...configured, MESSAGE_GROUP_ID_ATTRIBUTE]
  }

  /**
   * Run the handler over a received batch and return only the messages that
   * succeeded.
   *
   * sqs-consumer deletes exactly what this returns, so returning the successes
   * acknowledges them individually and leaves everything else in the queue.
   * Returning `undefined` — which is what happens if a handler's result is not
   * an array — would delete the entire batch regardless of outcome.
   */
  private async processBatch(
    messages: Message[],
    queue: ResolvedQueue,
  ): Promise<Message[]> {
    const outcome: BatchOutcome = queue.fifo
      ? await processOrderedByGroup(messages, this.config.handler, this.concurrency)
      : await processUnordered(messages, this.config.handler, this.concurrency)

    for (const failure of outcome.failures) {
      const error = toError(failure.error)
      this.logger.error('message handler failed', {
        queue: queue.name,
        messageId: failure.message.MessageId,
        error: error.message,
      })
      this.safeEmit('processing_error', error, failure.message)
    }

    if (outcome.skipped.length > 0) {
      this.logger.debug(
        'left messages queued behind an earlier failure in their message group',
        { queue: queue.name, skipped: outcome.skipped.length },
      )
    }

    if (this.config.terminateVisibilityTimeout === true) {
      await this.makeVisibleAgain(
        [...outcome.failures.map(failure => failure.message), ...outcome.skipped],
        queue,
      )
    }

    return outcome.successful
  }

  /**
   * Drop the visibility timeout on messages that were not handled, so they are
   * redelivered immediately instead of after the full timeout.
   *
   * Done here rather than delegated to `sqs-consumer`: its own
   * `terminateVisibilityTimeout` only fires when the batch handler *throws*, and
   * ours never does — it catches each failure so successful messages can still be
   * acknowledged. Without this, the option would silently do nothing.
   */
  private async makeVisibleAgain(
    messages: readonly Message[],
    queue: ResolvedQueue,
  ): Promise<void> {
    const entries = messages.flatMap((message, index) =>
      message.ReceiptHandle === undefined
        ? []
        : [
            {
              Id: `retry-${String(index)}`,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            },
          ],
    )

    if (entries.length === 0) {
      return
    }

    try {
      await this.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: queue.url,
          Entries: entries,
        }),
      )
    } catch (error) {
      // Only the retry delay is affected — the messages are still in the queue
      // and will reappear once their original timeout lapses.
      this.logger.warn('could not reset visibility on unhandled messages', {
        queue: queue.name,
        error: toError(error).message,
      })
    }
  }

  private forwardEvents(poller: SqsConsumer): void {
    poller.on('error', (error, context) => {
      this.logger.error('sqs error', { error: error.message })
      this.safeEmit('error', error, context)
    })
    poller.on('timeout_error', (error, message) => {
      this.logger.error('handler timed out', { messageId: message.MessageId })
      this.safeEmit('timeout_error', error, message)
    })
    poller.on('processing_error', (error, message) => {
      // Handler failures are reported from processBatch, which knows which
      // message failed and why; re-emitting here would duplicate them.
      this.logger.debug('sqs-consumer processing_error', {
        messageId: message.MessageId,
        error: error.message,
      })
    })
    poller.on('message_received', message => {
      this.safeEmit('message_received', message)
    })
    poller.on('message_processed', message => {
      this.safeEmit('message_processed', message)
    })
    poller.on('response_processed', () => {
      this.safeEmit('response_processed')
    })
    poller.on('empty', () => {
      this.safeEmit('empty')
    })
    poller.on('started', () => {
      this.safeEmit('started')
    })
    poller.on('stopped', () => {
      this.safeEmit('stopped')
    })
    poller.on('aborted', () => {
      this.safeEmit('aborted')
    })
  }

  /**
   * Emit without the risk of taking the process down.
   *
   * Node throws on an `error` event with no listener. A queue consumer that
   * crashes its host process because nobody subscribed to errors is worse than
   * one that logs them, so unlistened errors go to the logger instead.
   */
  private safeEmit<E extends keyof ConsumerEvents>(
    event: E,
    ...args: ConsumerEvents[E]
  ): void {
    if (event === 'error' && this.listenerCount('error') === 0) {
      const [error] = args as [Error]
      this.logger.error('unhandled consumer error (no "error" listener attached)', {
        error: error.message,
      })
      return
    }

    // EventEmitter's generic `emit` types its arguments through a conditional
    // type that TypeScript cannot narrow from inside a generic method, so the
    // already-checked signature is restated here.
    const emit = this.emit.bind(this) as (
      event: E,
      ...args: ConsumerEvents[E]
    ) => boolean
    emit(event, ...args)
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : JSON.stringify(value))
}
