import { SQSClientConfig } from '@aws-sdk/client-sqs'
import { Producer } from '../src/Producer'
import { ProducerOptions } from '../src/types'

describe('Producer', () => {
  let producer: Producer

  beforeAll(() => {
    const config: SQSClientConfig = {
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'ACCESS_KEY_ID',
        secretAccessKey: 'SECRET_ACCESS_KEY',
      },
    }
    producer = new Producer(config)
  })

  it('should send a message to the specified queue', async () => {
    const options: ProducerOptions = {
      sendMessageCommandInput: {
        MessageBody: 'Message',
        QueueUrl: 'queue-url',
        MessageGroupId: 'message-groupId',
      },
      isFifo: true,
      createIfNotExists: true,
      enableDlq: true,
      maxReceiveCount: 5,
    }
    const result = await producer.produce(options)
    expect(result).toBeDefined()
    expect(result.MessageId).toBeDefined()
  })
})
