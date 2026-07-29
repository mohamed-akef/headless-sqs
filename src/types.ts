import type {
  Message,
  SendMessageCommandInput,
  SQSClient,
  SQSClientConfig,
} from '@aws-sdk/client-sqs'
import type { Logger } from './logger'

/**
 * Message attribute map, derived from the AWS SDK's own input type so it stays
 * correct across SDK releases.
 */
export type MessageAttributeMap = NonNullable<
  SendMessageCommandInput['MessageAttributes']
>

/** System attribute map (e.g. `AWSTraceHeader`), derived from the AWS SDK input type. */
export type MessageSystemAttributeMap = NonNullable<
  SendMessageCommandInput['MessageSystemAttributes']
>

/**
 * Attributes applied to a queue **at creation time**.
 *
 * These are only used when headless-sqs provisions the queue. An existing
 * queue is never modified unless you opt into
 * {@link QueueConfig.reconcileAttributes}.
 */
export interface QueueAttributesConfig {
  /**
   * Seconds a received message stays hidden from other consumers.
   * SQS range: 0–43200 (12 hours). AWS default: 30.
   */
  visibilityTimeout?: number

  /**
   * Seconds SQS keeps a message before discarding it.
   * SQS range: 60–1209600 (14 days). AWS default: 345600 (4 days).
   */
  messageRetentionPeriod?: number

  /**
   * Seconds to delay every message on this queue.
   * SQS range: 0–900. AWS default: 0.
   */
  delaySeconds?: number

  /**
   * Largest accepted message, in bytes.
   * SQS range: 1024–262144 (256 KiB).
   */
  maximumMessageSize?: number

  /**
   * Seconds a receive call waits for a message before returning empty —
   * i.e. long polling. SQS range: 0–20.
   *
   * headless-sqs defaults this to `20` on queues it creates, because short
   * polling costs more and adds latency for no benefit.
   */
  receiveMessageWaitTimeSeconds?: number

  /**
   * **FIFO only.** Let SQS deduplicate on a SHA-256 of the message body
   * instead of requiring an explicit deduplication id.
   *
   * Left unset (matching the AWS default of `false`), because enabling it
   * means two messages with identical bodies inside the 5-minute
   * deduplication window are **silently discarded** — which is
   * indistinguishable from message loss. Only turn it on when your bodies are
   * naturally unique.
   */
  contentBasedDeduplication?: boolean

  /**
   * **FIFO only.** Opt into high-throughput mode
   * (`DeduplicationScope: messageGroup` + `FifoThroughputLimit: perMessageGroupId`),
   * which raises throughput but scopes deduplication to each message group
   * rather than the whole queue.
   */
  highThroughputFifo?: boolean

  /** Enable SQS-managed server-side encryption. Mutually exclusive with {@link kmsMasterKeyId}. */
  sseManaged?: boolean

  /** Customer-managed KMS key id or alias. Mutually exclusive with {@link sseManaged}. */
  kmsMasterKeyId?: string

  /**
   * Seconds SQS may reuse a data key before calling KMS again.
   * SQS range: 60–86400.
   */
  kmsDataKeyReusePeriodSeconds?: number

  /** Queue access policy. Objects are JSON-stringified for you. */
  policy?: string | Record<string, unknown>

  /** Controls which source queues may use this queue as a dead-letter target. */
  redriveAllowPolicy?: string | Record<string, unknown>
}

/** Dead-letter queue provisioning. */
export interface DeadLetterQueueConfig {
  /**
   * Name of the dead-letter queue.
   * Defaults to the primary queue's name prefixed with `dlq-`.
   */
  name?: string

  /**
   * Receives after which SQS moves a message to the dead-letter queue.
   * SQS range: 1–1000. Defaults to `5`.
   */
  maxReceiveCount?: number

  /** Attributes for the dead-letter queue itself. */
  attributes?: QueueAttributesConfig

  /** Tags for the dead-letter queue itself. */
  tags?: Record<string, string>
}

/**
 * Declarative description of the queue a producer or consumer talks to.
 */
export interface QueueConfig {
  /**
   * Queue name — not a URL. The `.fifo` suffix is added automatically for FIFO
   * queues, and supplying it yourself is fine (it is not doubled).
   */
  name: string

  /**
   * Whether this is a FIFO queue. Inferred from a `.fifo` suffix on
   * {@link name} when omitted.
   */
  fifo?: boolean

  /**
   * Create the queue (and its dead-letter queue) if it does not exist.
   *
   * Off by default: provisioning infrastructure is not something a library
   * should do to an AWS account unless explicitly asked.
   */
  createIfNotExists?: boolean

  /**
   * Attach a dead-letter queue. `true` uses all defaults; an object customises
   * the name, redrive threshold and the DLQ's own attributes.
   *
   * Only applied when the primary queue is created by headless-sqs.
   */
  dlq?: boolean | DeadLetterQueueConfig

  /** Attributes used when creating the queue. */
  attributes?: QueueAttributesConfig

  /** Tags applied when creating the queue. */
  tags?: Record<string, string>

  /**
   * Bring an **existing** queue's attributes in line with {@link attributes}
   * by calling `SetQueueAttributes` on first resolve.
   *
   * Off by default and never implied by {@link createIfNotExists}, because it
   * mutates a queue that already exists — possibly one this application does
   * not own. Enable it only for queues you are the sole owner of.
   */
  reconcileAttributes?: boolean
}

/** How to obtain an SQS client. */
export interface SqsClientOptions {
  /**
   * An existing client to use. Takes precedence over {@link clientConfig}.
   *
   * A client you pass in is yours: `destroy()` will not close it.
   */
  client?: SQSClient

  /** Config for a client constructed and owned by headless-sqs. */
  clientConfig?: SQSClientConfig
}

/** Shared configuration for producers and consumers. */
export interface BaseConfig extends SqsClientOptions {
  /** The queue to talk to. */
  queue: QueueConfig

  /** Where diagnostics go. Defaults to a silent logger. */
  logger?: Logger
}

/** Producer configuration. */
export type ProducerConfig = BaseConfig

/** A message to publish. */
export interface SendMessageInput {
  /** Message body. */
  body: string

  /**
   * FIFO message group. Required for FIFO queues — messages sharing a group id
   * are delivered in order, and different groups proceed independently.
   */
  groupId?: string

  /**
   * FIFO deduplication id. Required for FIFO queues unless the queue has
   * `contentBasedDeduplication` enabled.
   */
  deduplicationId?: string

  /** Delay for this message, in seconds (0–900). Not supported on FIFO queues. */
  delaySeconds?: number

  /** User-defined message attributes. */
  attributes?: MessageAttributeMap

  /** System attributes, e.g. `AWSTraceHeader`. */
  systemAttributes?: MessageSystemAttributeMap
}

/** Result of a single send. */
export interface SendMessageResult {
  messageId: string | undefined
  /** Present for FIFO queues only. */
  sequenceNumber: string | undefined
  md5OfMessageBody: string | undefined
}

/** One message in a batch send. */
export interface SendBatchEntry extends SendMessageInput {
  /**
   * Batch entry id, unique within the batch. Generated from the entry's
   * position when omitted.
   */
  id?: string
}

/** Options for `Producer.sendBatch`. */
export interface SendBatchOptions {
  /**
   * Throw `BatchSendError` when any entry fails.
   *
   * Defaults to `true`: a partial failure that is not surfaced is silent
   * message loss. Set to `false` to inspect the result instead.
   */
  throwOnFailure?: boolean
}

/** Outcome of a batch send, aggregated across all underlying requests. */
export interface SendBatchResult {
  successful: {
    id: string
    messageId: string | undefined
    sequenceNumber: string | undefined
  }[]
  failed: {
    id: string
    code: string | undefined
    message: string | undefined
    senderFault: boolean
  }[]
}

/**
 * Handles one message. Throwing (or rejecting) marks the message as failed, so
 * it stays in the queue and is redelivered after the visibility timeout.
 */
export type MessageHandler = (message: Message) => void | Promise<void>

/** Consumer configuration. */
export interface ConsumerConfig extends BaseConfig {
  /** Called for each received message. */
  handler: MessageHandler

  /** Messages to request per poll. SQS allows 1–10. Defaults to `10`. */
  batchSize?: number

  /**
   * Maximum handlers running at once within a batch.
   *
   * For FIFO queues this caps how many **message groups** run in parallel;
   * ordering within a group is always preserved. Defaults to {@link batchSize}.
   */
  concurrency?: number

  /** Per-receive visibility timeout override, in seconds. */
  visibilityTimeout?: number

  /** Long-poll duration, in seconds (0–20). Defaults to `20`. */
  waitTimeSeconds?: number

  /** Pause between polls, in milliseconds. */
  pollingWaitTimeMs?: number

  /**
   * Interval, in seconds, at which in-flight messages have their visibility
   * extended. Must be less than {@link visibilityTimeout}.
   */
  heartbeatInterval?: number

  /** Milliseconds before a handler is considered timed out. */
  handleMessageTimeout?: number

  /**
   * Make unhandled messages visible again immediately, instead of after their
   * visibility timeout, so a failure is retried without delay.
   *
   * Applies to messages whose handler failed and to messages skipped behind an
   * earlier failure in the same FIFO message group.
   */
  terminateVisibilityTimeout?: boolean

  /** Set to `false` to take over deleting messages yourself. Defaults to `true`. */
  shouldDeleteMessages?: boolean

  /**
   * Queue attributes to fetch with each message.
   *
   * `MessageGroupId` is requested automatically for FIFO queues, since it is
   * what makes per-group ordering possible.
   */
  attributeNames?: string[]

  /** Message attributes to fetch with each message. */
  messageAttributeNames?: string[]

  /** Milliseconds to back off after an authentication failure. */
  authenticationErrorTimeout?: number
}

/** Events emitted by `Consumer`. */
export interface ConsumerEvents {
  started: []
  stopped: []
  empty: []
  aborted: []
  message_received: [Message]
  message_processed: [Message]
  response_processed: []
  /** An error interacting with SQS. */
  error: [Error, (Message | Message[])?]
  /** A handler threw for a specific message. */
  processing_error: [Error, Message]
  /** A handler exceeded {@link ConsumerConfig.handleMessageTimeout}. */
  timeout_error: [Error, Message]
}
