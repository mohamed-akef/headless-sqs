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
      ? generateFifoQueueName(options.queueName)
      : options.queueName
    const getQueueUrl = new GetQueueUrl(this.client)
    const queueUrl = await getQueueUrl.execute(sqsQueueName, options)
    return bbcConsumer.create({
      queueUrl: queueUrl,
      handleMessage: handler,
      sqs: this.client,
    })
  }
}
