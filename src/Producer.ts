import {
  SendMessageCommand,
  SQSClient,
  SQSClientConfig,
} from '@aws-sdk/client-sqs'
import { ProducerOptions } from './types'
import { GetQueueUrl } from './Queue/query/GetQueueUrl'
import { generateFifoQueueName } from './Queue/utils'

export class Producer {
  private client: SQSClient
  constructor(config: SQSClientConfig) {
    this.client = new SQSClient(config)
  }

  public async produce(options: ProducerOptions) {
    const sqsQueueName = options?.isFifo
      ? generateFifoQueueName(
          options.sendMessageCommandInput.QueueUrl as string,
        )
      : (options.sendMessageCommandInput.QueueUrl as string)
    const getQueueUrl = new GetQueueUrl(this.client)
    options.sendMessageCommandInput.QueueUrl = await getQueueUrl.execute(
      sqsQueueName,
      options,
    )
    const command = new SendMessageCommand(options.sendMessageCommandInput)
    return await this.client.send(command)
  }
}
