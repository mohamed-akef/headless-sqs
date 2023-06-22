import { Message, SQSClient, SQSClientConfig } from '@aws-sdk/client-sqs'
import { ConsumerOptions } from './types'
import { GetQueueUrl } from './Queue/query/GetQueueUrl'
import { generateFifoQueueName } from './Queue/utils'
import { Consumer as bbcConsumer } from 'sqs-consumer'

export class Consumer {
  private client: SQSClient
  constructor(config: SQSClientConfig) {
    this.client = new SQSClient(config)
  }

  public async start(
    options: ConsumerOptions,
    handler: (message: Message) => Promise<void>,
  ): Promise<void> {
    const consumer = await this.initConsumer(options, handler)
    consumer.start()
  }

  public async stop(
    options: ConsumerOptions,
    handler: (message: Message) => Promise<void>,
  ): Promise<void> {
    const consumer = await this.initConsumer(options, handler)
    consumer.stop()
  }

  private async initConsumer(
    options: ConsumerOptions,
    handler: (message: Message) => Promise<void>,
  ): Promise<bbcConsumer> {
    const sqsQueueName = options?.isFifo
      ? generateFifoQueueName(options.baseConsumerOptions.queueUrl)
      : options.baseConsumerOptions.queueUrl
    const getQueueUrl = new GetQueueUrl(this.client)
    const queueUrl = await getQueueUrl.execute(sqsQueueName, options)
    const consumer = bbcConsumer.create({
      ...options?.baseConsumerOptions,
      queueUrl: queueUrl,
      handleMessageBatch: async messages => {
        await Promise.all(messages.map(handler))
      },
      sqs: this.client,
    })
    consumer.on('error', err => {
      console.error('Error:', err.message)
    })
    consumer.on('processing_error', err => {
      console.error('Processing error:', err.message)
    })

    return consumer
  }
}
