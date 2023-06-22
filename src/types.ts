import { SendMessageCommandInput } from '@aws-sdk/client-sqs'
import { ConsumerOptions as BaseConsumerOptions } from 'sqs-consumer'

export type ProducerOptions = {
  sendMessageCommandInput: SendMessageCommandInput
} & QueueOptions

export type ConsumerOptions = {
  baseConsumerOptions: BaseConsumerOptions
} & QueueOptions

export type QueueOptions = {
  isFifo?: boolean
  createIfNotExists?: boolean
  enableDlq?: boolean
  maxReceiveCount?: number
}
