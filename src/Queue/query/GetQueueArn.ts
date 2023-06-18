import {
  GetQueueAttributesCommand,
  QueueAttributeName,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { QueueOptions } from '../../types'
import { GetQueueUrl } from './GetQueueUrl'

export class GetQueueArn {
  constructor(private client: SQSClient) {}

  public async execute(
    queueName: string,
    options?: QueueOptions,
  ): Promise<string> {
    const getQueueUrlQuery = new GetQueueUrl(this.client)
    const queueUrl = await getQueueUrlQuery.execute(queueName, options)

    const command = new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [QueueAttributeName.QueueArn],
    })
    const result = await this.client.send(command)

    if (
      result?.Attributes &&
      QueueAttributeName.QueueArn in result.Attributes
    ) {
      return result.Attributes[QueueAttributeName.QueueArn]
    }
    throw new Error("Can't get Queue Arn")
  }
}
