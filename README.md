# headless-sqs

[![CI](https://github.com/mohamed-akef/headless-sqs/actions/workflows/ci.yml/badge.svg)](https://github.com/mohamed-akef/headless-sqs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/headless-sqs.svg)](https://www.npmjs.com/package/headless-sqs)
[![node](https://img.shields.io/node/v/headless-sqs.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/headless-sqs.svg)](./LICENSE)

A typed SQS producer and consumer that provisions queues — and their dead-letter queues — from declarative config.

You describe the queue you want. The library resolves it, optionally creates it, caches the URL, and gets the details right that are easy to get wrong: FIFO ordering, per-message acknowledgement, and shutdown.

```ts
import { Producer } from 'headless-sqs'

const producer = new Producer({
  clientConfig: { region: 'eu-west-1' },
  queue: { name: 'orders', createIfNotExists: true, dlq: true },
})

await producer.send({ body: JSON.stringify({ orderId: 42 }) })
```

## Why

Talking to SQS directly is not hard, but a handful of details bite almost everyone:

- **A failed message poisons its batch.** The obvious `handleMessageBatch` implementation acknowledges all-or-nothing, so one bad message out of ten redelivers the nine that already succeeded — and they get processed twice.
- **FIFO ordering is per message group, not per queue.** Serialising the whole batch is correct but slow; processing it in parallel is fast but reorders messages.
- **Standard and FIFO queues take different attributes.** Sending `FifoQueue: 'false'` or an empty `RedrivePolicy` makes `CreateQueue` fail.
- **`ContentBasedDeduplication` silently discards messages.** Two identical bodies within five minutes look exactly like message loss.
- **Dead-letter queues need a two-step dance** — create the DLQ, read its ARN, then create the real queue with a redrive policy pointing at it.

This package handles each of those, and explains itself when your config cannot work.

## Install

```sh
npm install headless-sqs @aws-sdk/client-sqs
```

`@aws-sdk/client-sqs` is a peer dependency so your application controls the SDK version and one client is shared, rather than a second copy being bundled in.

Requires **Node.js 22 or newer**.

## Producing

```ts
import { Producer } from 'headless-sqs'

const producer = new Producer({
  clientConfig: { region: 'eu-west-1' },
  queue: { name: 'orders' },
})

const { messageId } = await producer.send({
  body: JSON.stringify({ orderId: 42 }),
  attributes: {
    source: { DataType: 'String', StringValue: 'checkout' },
  },
})
```

Pass an existing client instead of `clientConfig` when you have one:

```ts
import { SQSClient } from '@aws-sdk/client-sqs'

const producer = new Producer({
  client: new SQSClient({ region: 'eu-west-1' }),
  queue: { name: 'orders' },
})
```

A client you pass in is yours: `producer.destroy()` leaves it open. A client built from `clientConfig` is owned by the producer and closed on `destroy()`.

The queue URL is resolved on first use and cached, so steady-state publishing is one SQS call per send. Call `await producer.queueUrl()` at startup if you would rather fail fast on a missing queue or bad credentials than on your first publish.

### Batches

`sendBatch` splits your messages across as many requests as SQS needs — respecting **both** the 10-entry limit and the 256 KiB total-payload limit:

```ts
await producer.sendBatch([
  { body: 'one' },
  { body: 'two' },
  { id: 'custom-id', body: 'three' },
])
```

Partial failure is normal for SQS batches: individual entries can fail inside an otherwise successful response. By default that raises `BatchSendError`, which tells you exactly what to retry:

```ts
import { BatchSendError } from 'headless-sqs'

try {
  await producer.sendBatch(messages)
} catch (error) {
  if (error instanceof BatchSendError) {
    // Retrying the whole batch would duplicate error.successful.
    await producer.sendBatch(error.failed.map(entry => byId[entry.id]))
  }
}
```

Prefer to inspect the outcome yourself? Pass `{ throwOnFailure: false }` and read `result.successful` / `result.failed`.

## Consuming

```ts
import { Consumer } from 'headless-sqs'

const consumer = new Consumer({
  clientConfig: { region: 'eu-west-1' },
  queue: { name: 'orders' },
  handler: async message => {
    await handleOrder(JSON.parse(message.Body ?? '{}'))
  },
})

consumer.on('processing_error', (error, message) => {
  reportToSentry(error, { messageId: message.MessageId })
})

await consumer.start()
```

A handler that resolves acknowledges its message. A handler that throws leaves that message — **and only that message** — in the queue, to be redelivered after the visibility timeout.

### Ordering

For a **standard** queue, messages in a batch are handled concurrently, up to `concurrency` (defaults to `batchSize`).

For a **FIFO** queue, messages are grouped by `MessageGroupId`. Groups run in parallel; messages within a group run in order. If one fails, the rest of _its_ group is left queued so ordering survives redelivery — other groups are unaffected.

`MessageGroupId` is requested automatically for FIFO queues, since it is what makes grouping possible.

### Graceful shutdown

```ts
process.once('SIGTERM', async () => {
  await consumer.stop() // resolves once in-flight handlers have finished
  await consumer.destroy()
})
```

`stop()` acts on the poller this instance started and resolves only once it has actually stopped, so awaiting it drains cleanly. Pass `{ abort: true }` to cut in-flight SQS requests short, or `{ timeoutMs }` to bound how long a shutdown path can block.

### Events

| Event                             | Payload             | Fired when                                |
| --------------------------------- | ------------------- | ----------------------------------------- |
| `processing_error`                | `(error, message)`  | your handler threw for a message          |
| `error`                           | `(error, context?)` | an error interacting with SQS             |
| `timeout_error`                   | `(error, message)`  | a handler exceeded `handleMessageTimeout` |
| `message_received`                | `(message)`         | a message arrived                         |
| `message_processed`               | `(message)`         | a message was handled and deleted         |
| `empty`                           | —                   | a poll returned no messages               |
| `response_processed`              | —                   | a batch finished                          |
| `started` / `stopped` / `aborted` | —                   | lifecycle transitions                     |

Unlike a bare `EventEmitter`, an `error` with no listener attached is logged rather than thrown, so a missing subscription cannot take your process down.

## Auto-provisioning

Set `createIfNotExists` to have the queue created on first use:

```ts
const producer = new Producer({
  clientConfig: { region: 'eu-west-1' },
  queue: {
    name: 'orders',
    createIfNotExists: true,
    dlq: { maxReceiveCount: 3 },
    attributes: {
      visibilityTimeout: 60,
      messageRetentionPeriod: 1_209_600,
      sseManaged: true,
    },
    tags: { team: 'payments' },
  },
})
```

This is **off by default**. Creating infrastructure is not something a library should do to your AWS account unless you ask.

When a dead-letter queue is requested, it is created first, its ARN is read, and the primary queue is created with a redrive policy pointing at it. The dead-letter queue never gets a dead-letter queue of its own.

Concurrent provisioning is safe: if another process wins the race, the existing queue is adopted rather than the call failing.

Queues we create get `ReceiveMessageWaitTimeSeconds: 20` (long polling) unless you say otherwise — short polling costs more requests and adds latency for no benefit.

### Reconciling an existing queue

`createIfNotExists` never modifies a queue that already exists. To converge attributes, opt in explicitly:

```ts
queue: {
  name: 'orders',
  reconcileAttributes: true,
  attributes: { visibilityTimeout: 60 },
}
```

Only attributes you actually listed are considered — library defaults are excluded, so turning this on cannot silently rewrite a setting you never expressed an opinion about. `RedrivePolicy` is left alone, since replacing it could detach a dead-letter queue configured elsewhere. Use it only on queues you own outright.

## FIFO queues

```ts
const producer = new Producer({
  clientConfig: { region: 'eu-west-1' },
  queue: {
    name: 'orders', // ".fifo" is appended for you
    fifo: true,
    createIfNotExists: true,
  },
})

await producer.send({
  body: JSON.stringify({ orderId: 42 }),
  groupId: 'customer-7', // required on FIFO queues
  deduplicationId: 'order-42-created',
})
```

Notes:

- The `.fifo` suffix is applied idempotently — `orders` and `orders.fifo` both resolve to `orders.fifo`. `fifo` is inferred when the name already carries the suffix.
- `contentBasedDeduplication` is **not** enabled by default (matching the AWS default). Supply a `deduplicationId`, or opt in with `attributes.contentBasedDeduplication: true` if your bodies are naturally unique.
- High-throughput mode is opt-in via `attributes.highThroughputFifo: true`, which sets `DeduplicationScope` and `FifoThroughputLimit` together.
- FIFO queues do not support per-message delays; set `attributes.delaySeconds` on the queue instead.

## Errors

Every deliberate failure is a `HeadlessSqsError` subclass carrying a stable `code`:

| Class                        | `code`                      | Meaning                                                  |
| ---------------------------- | --------------------------- | -------------------------------------------------------- |
| `InvalidQueueNameError`      | `INVALID_QUEUE_NAME`        | the name cannot be a valid SQS queue name                |
| `InvalidQueueAttributeError` | `INVALID_QUEUE_ATTRIBUTE`   | an attribute is out of range or wrong for the queue type |
| `InvalidMessageError`        | `INVALID_MESSAGE`           | the message is missing something SQS requires            |
| `QueueNotFoundError`         | `QUEUE_NOT_FOUND`           | the queue does not exist and auto-provisioning is off    |
| `QueueProvisioningError`     | `QUEUE_PROVISIONING_FAILED` | creating the queue or its DLQ failed                     |
| `BatchSendError`             | `BATCH_SEND_FAILED`         | at least one batch entry failed                          |
| `IllegalStateError`          | `ILLEGAL_STATE`             | the operation is not valid in the current state          |

Branch on `error.code` rather than matching messages — codes are part of the public API, wording is not. Unexpected AWS errors propagate unchanged, and wrapped ones keep the original on `error.cause`.

```ts
import { isHeadlessSqsError } from 'headless-sqs'

if (isHeadlessSqsError(error) && error.code === 'QUEUE_NOT_FOUND') {
  // ...
}
```

## Configuration

### `queue`

| Option                | Type                               | Default                        | Description                                |
| --------------------- | ---------------------------------- | ------------------------------ | ------------------------------------------ |
| `name`                | `string`                           | —                              | Queue name, not a URL.                     |
| `fifo`                | `boolean`                          | inferred from a `.fifo` suffix | Whether this is a FIFO queue.              |
| `createIfNotExists`   | `boolean`                          | `false`                        | Create the queue on first use.             |
| `dlq`                 | `boolean \| DeadLetterQueueConfig` | `undefined`                    | Attach a dead-letter queue.                |
| `attributes`          | `QueueAttributesConfig`            | `{}`                           | Attributes applied at creation.            |
| `tags`                | `Record<string, string>`           | `undefined`                    | Tags applied at creation.                  |
| `reconcileAttributes` | `boolean`                          | `false`                        | Align an existing queue with `attributes`. |

### `queue.dlq`

| Option            | Type                     | Default       | Description                         |
| ----------------- | ------------------------ | ------------- | ----------------------------------- |
| `name`            | `string`                 | `dlq-<queue>` | Dead-letter queue name.             |
| `maxReceiveCount` | `number`                 | `5`           | Receives before a message is moved. |
| `attributes`      | `QueueAttributesConfig`  | `{}`          | Attributes for the DLQ itself.      |
| `tags`            | `Record<string, string>` | `undefined`   | Tags for the DLQ itself.            |

### `queue.attributes`

| Option                          | Range       | Notes                                     |
| ------------------------------- | ----------- | ----------------------------------------- |
| `visibilityTimeout`             | 0–43200     |                                           |
| `messageRetentionPeriod`        | 60–1209600  |                                           |
| `delaySeconds`                  | 0–900       |                                           |
| `maximumMessageSize`            | 1024–262144 |                                           |
| `receiveMessageWaitTimeSeconds` | 0–20        | Defaults to `20` on queues we create.     |
| `contentBasedDeduplication`     | —           | FIFO only.                                |
| `highThroughputFifo`            | —           | FIFO only.                                |
| `sseManaged`                    | —           | Mutually exclusive with `kmsMasterKeyId`. |
| `kmsMasterKeyId`                | —           |                                           |
| `kmsDataKeyReusePeriodSeconds`  | 60–86400    |                                           |
| `policy`                        | —           | Object or JSON string.                    |
| `redriveAllowPolicy`            | —           | Object or JSON string.                    |

Out-of-range values are rejected locally, with the field name and the accepted range, instead of surfacing as an opaque AWS error.

### Consumer

| Option                       | Default       | Description                                                      |
| ---------------------------- | ------------- | ---------------------------------------------------------------- |
| `handler`                    | —             | Called per message.                                              |
| `batchSize`                  | `10`          | Messages per poll (1–10).                                        |
| `concurrency`                | `batchSize`   | Parallel handlers; parallel _groups_ on FIFO.                    |
| `visibilityTimeout`          | queue default | Per-receive override.                                            |
| `waitTimeSeconds`            | `20`          | Long-poll duration.                                              |
| `pollingWaitTimeMs`          | `0`           | Pause between polls.                                             |
| `heartbeatInterval`          | —             | Extends visibility while handling; requires `visibilityTimeout`. |
| `handleMessageTimeout`       | —             | Milliseconds before a handler is timed out.                      |
| `terminateVisibilityTimeout` | `false`       | Retry failures immediately.                                      |
| `shouldDeleteMessages`       | `true`        | Set `false` to delete messages yourself.                         |
| `attributeNames`             | `[]`          | Extra system attributes to fetch.                                |
| `messageAttributeNames`      | `[]`          | Message attributes to fetch.                                     |
| `authenticationErrorTimeout` | `10000`       | Backoff after an auth failure.                                   |

## Logging

Silent by default. Pass anything with `debug`/`info`/`warn`/`error` methods — the shape `pino`, `winston` and `console` already have:

```ts
import { consoleLogger } from 'headless-sqs'

new Producer({ queue: { name: 'orders' }, logger: consoleLogger })
```

## IAM permissions

Producing and consuming from an existing queue:

```json
{
  "Effect": "Allow",
  "Action": [
    "sqs:GetQueueUrl",
    "sqs:SendMessage",
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:ChangeMessageVisibility"
  ],
  "Resource": "arn:aws:sqs:eu-west-1:123456789012:orders"
}
```

`createIfNotExists` additionally needs `sqs:CreateQueue` and `sqs:GetQueueAttributes` (plus `sqs:TagQueue` when using `tags`); `reconcileAttributes` needs `sqs:SetQueueAttributes`.

## Testing

Both classes accept a `client`, so [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock) works without any special support:

```ts
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { mockClient } from 'aws-sdk-client-mock'

const sqs = mockClient(SQSClient)
sqs.on(GetQueueUrlCommand).resolves({ QueueUrl: 'https://sqs.../orders' })
sqs.on(SendMessageCommand).resolves({ MessageId: 'id-1' })
```

For an end-to-end check without AWS, point `clientConfig.endpoint` at [ElasticMQ](https://github.com/softwaremill/elasticmq) or LocalStack.

## Migrating from 0.1.x

0.2.0 reshapes the API. The old surface passed a queue _name_ in the `QueueUrl` field and mutated your input object; the new one separates queue configuration from the message.

```ts
// 0.1.x
const producer = new Producer({ region: 'eu-west-1' })
await producer.produce({
  sendMessageCommandInput: {
    MessageBody: 'hello',
    QueueUrl: 'orders', // actually a name
    MessageGroupId: 'g1',
  },
  isFifo: true,
  createIfNotExists: true,
  enableDlq: true,
  maxReceiveCount: 5,
})

// 0.2.0
const producer = new Producer({
  clientConfig: { region: 'eu-west-1' },
  queue: {
    name: 'orders',
    fifo: true,
    createIfNotExists: true,
    dlq: { maxReceiveCount: 5 },
  },
})
await producer.send({ body: 'hello', groupId: 'g1' })
```

| 0.1.x                                    | 0.2.0                                                         |
| ---------------------------------------- | ------------------------------------------------------------- |
| `new Producer(sqsClientConfig)`          | `new Producer({ clientConfig, queue })`                       |
| `producer.produce(options)`              | `producer.send(message)`                                      |
| `sendMessageCommandInput.QueueUrl`       | `queue.name`                                                  |
| `sendMessageCommandInput.MessageBody`    | `send({ body })`                                              |
| `sendMessageCommandInput.MessageGroupId` | `send({ groupId })`                                           |
| `isFifo`                                 | `queue.fifo`                                                  |
| `createIfNotExists`                      | `queue.createIfNotExists`                                     |
| `enableDlq: true`                        | `queue.dlq: true`                                             |
| `maxReceiveCount: n`                     | `queue.dlq: { maxReceiveCount: n }`                           |
| `consumer.start(options, handler)`       | `handler` moves into the constructor; `start()` takes nothing |
| `consumer.stop(options, handler)`        | `consumer.stop()`                                             |
| `baseConsumerOptions.queueUrl`           | `queue.name`                                                  |
| other `baseConsumerOptions`              | top-level consumer options                                    |

Behaviour that changed on purpose:

- `ContentBasedDeduplication` is no longer forced on. Set `attributes.contentBasedDeduplication: true` to keep the old behaviour — but note it silently drops duplicate bodies within five minutes.
- High-throughput FIFO is no longer forced on. Opt in with `attributes.highThroughputFifo: true`.
- `maxReceiveCount` now defaults to `5` instead of `2`.
- Created queues get long polling (`ReceiveMessageWaitTimeSeconds: 20`).
- `@aws-sdk/client-sqs` moved to a peer dependency — install it explicitly.
- Node 22 or newer is required.

See [CHANGELOG.md](./CHANGELOG.md) for the full list, including the bugs this release fixes.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

```sh
npm install
npm run check   # format, lint, typecheck, coverage, build
```

## License

[Apache-2.0](./LICENSE)
