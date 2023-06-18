import {
  GetQueueUrlCommand,
  QueueDoesNotExist,
  SQSClient,
} from '@aws-sdk/client-sqs'
import { QueueOptions } from '../../types'
import { CreateQueue } from '../command/CreateQueue'

export class GetQueueUrl {
  constructor(private client: SQSClient) {}

  public async execute(
    queueName: string,
    options?: QueueOptions,
  ): Promise<string> {
    try {
      const command = new GetQueueUrlCommand({ QueueName: queueName })
      const result = await this.client.send(command)
      return result.QueueUrl as string
    } catch (err) {
      if (
        err instanceof QueueDoesNotExist &&
        options?.createIfNotExists === true
      ) {
        const createQueueCommand = new CreateQueue(this.client)
        return createQueueCommand.execute(queueName, options)
      }
      throw err
    }
  }
}
