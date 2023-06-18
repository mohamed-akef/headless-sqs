import { SendMessageCommandInput } from '@aws-sdk/client-sqs'

export type ProducerOptions = {
  sendMessageCommandInput: SendMessageCommandInput
} & QueueOptions

export type ConsumerOptions = { queueName: string } & QueueOptions

export type QueueOptions = {
  isFifo?: boolean
  createIfNotExists?: boolean
  enableDlq?: boolean
  maxReceiveCount?: number
}
