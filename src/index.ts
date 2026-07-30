export { Producer } from './producer'
export { Consumer, type StopOptions } from './consumer'

export {
  BatchSendError,
  HeadlessSqsError,
  IllegalStateError,
  InvalidMessageError,
  InvalidQueueAttributeError,
  InvalidQueueNameError,
  isHeadlessSqsError,
  QueueNotFoundError,
  QueueProvisioningError,
  type FailedBatchEntry,
  type HeadlessSqsErrorCode,
} from './errors'

export { consoleLogger, silentLogger, type Logger } from './logger'

export type {
  BaseConfig,
  ConsumerConfig,
  ConsumerEvents,
  DeadLetterQueueConfig,
  MessageAttributeMap,
  MessageHandler,
  MessageSystemAttributeMap,
  ProducerConfig,
  QueueAttributesConfig,
  QueueConfig,
  SendBatchEntry,
  SendBatchOptions,
  SendBatchResult,
  SendMessageInput,
  SendMessageResult,
  SqsClientOptions,
} from './types'
