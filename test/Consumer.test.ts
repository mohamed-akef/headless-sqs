import { SQSClientConfig } from '@aws-sdk/client-sqs'
import { Consumer } from '../src/Consumer'
import { ConsumerOptions } from '../src/types'

describe('Consumer', () => {
  let consumer: Consumer

  beforeAll(() => {
    const config: SQSClientConfig = {
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'ACCESS_KEY_ID',
        secretAccessKey: 'SECRET_ACCESS_KEY',
      },
    }
    consumer = new Consumer(config)
  })

  it('should consume messages', async () => {
    const options: ConsumerOptions = {
      queueName: 'consumer',
      isFifo: true,
      createIfNotExists: true,
      enableDlq: true,
      maxReceiveCount: 5,
    }
    await consumer.start(options, async message => {
      expect(message).toBeDefined()
      expect(message.Body).toBeDefined()
      console.log(message.Body)
    })
  })
})
