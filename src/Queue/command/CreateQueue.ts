import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs'
import { QueueOptions } from '../../types'
import { GetQueueArn } from '../query/GetQueueArn'
import { generateDlQueueName } from '../utils'

export class CreateQueue {
  constructor(private client: SQSClient) {}

  public async execute(
    queueName: string,
    options?: QueueOptions,
  ): Promise<string> {
    const command = new CreateQueueCommand({
      QueueName: queueName,
      Attributes: await this.buildAttributes(queueName, options),
    })
    const result = await this.client.send(command)
    return result.QueueUrl as string
  }

  private async buildAttributes(queueName: string, options?: QueueOptions) {
    const attributes = {
      FifoQueue: options?.isFifo === true ? 'true' : 'false',
      ContentBasedDeduplication: 'true',
      DeduplicationScope: 'messageGroup',
      FifoThroughputLimit: 'perMessageGroupId',
      RedrivePolicy: '',
    }
    if (options?.enableDlq === true) {
      const getQueueArnQuery = new GetQueueArn(this.client)
      const dlqArn = await getQueueArnQuery.execute(
        generateDlQueueName(queueName),
        {
          isFifo: options?.isFifo,
          createIfNotExists: options?.createIfNotExists,
        },
      )
      attributes.RedrivePolicy = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: options?.maxReceiveCount ?? 2,
      })
    }
    return attributes
  }
}
