# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

A correctness-focused rewrite. The API changed shape — see
[Migrating from 0.1.x](./README.md#migrating-from-01x). `0.1.x` was published as
alpha, so no compatibility layer is provided.

### Fixed

- **Standard queues could not be created.** `CreateQueue` was always sent the
  FIFO-only attributes `FifoQueue`, `ContentBasedDeduplication`,
  `DeduplicationScope` and `FifoThroughputLimit`. `DeduplicationScope` and
  `FifoThroughputLimit` are rejected outright on a standard queue. Attributes are
  now built conditionally, so FIFO-only keys are never sent for a standard queue.
- **`RedrivePolicy: ''` was always sent.** An empty string is not a valid
  attribute value, so creating a queue without a dead-letter queue passed SQS an
  invalid attribute. A redrive policy is now emitted only when a dead-letter
  target actually exists.
- **`Consumer.stop()` did not stop anything.** It constructed a _new_ consumer
  from the supplied options and called `stop()` on that, leaving the running
  poller polling forever. The consumer now holds its poller, and `stop()`
  resolves once that poller has actually stopped.
- **One failed message reprocessed its whole batch.** The batch handler ran
  `Promise.all` and returned nothing, which tells `sqs-consumer` to delete every
  message. A single rejection meant nothing was deleted, so the messages that
  had already succeeded were redelivered and handled a second time. Messages are
  now acknowledged individually: successes are deleted, failures are left queued.
- **FIFO ordering was not preserved.** Batches were handled fully concurrently.
  Messages are now grouped by `MessageGroupId`, with groups running in parallel
  and messages within a group in order; a failure halts only its own group.
  `MessageGroupId` is requested automatically for FIFO queues.
- **`Producer` mutated the caller's input.** The resolved queue URL was assigned
  onto `sendMessageCommandInput.QueueUrl`, so reusing one options object silently
  corrupted every later send — and re-appended `.fifo`. Each send now builds a
  fresh command input and never writes to your object.
- **The `.fifo` suffix could be doubled.** It was appended unconditionally, so an
  already-suffixed name became `orders.fifo.fifo`. Suffix handling is now
  idempotent.
- **Missing-queue detection broke with duplicate SDK copies.** Detection used
  `err instanceof QueueDoesNotExist`, which silently returns `false` when more
  than one copy of `@aws-sdk/client-sqs` is resolved — auto-provisioning would
  stop working with no error. AWS errors are now matched by `name`.
- **`ContentBasedDeduplication` was hardcoded to `true`.** Any two messages with
  identical bodies inside the five-minute deduplication window were silently
  discarded, which is indistinguishable from message loss. It is now off unless
  requested, matching the AWS default.
- **High-throughput FIFO was forced on every queue.** Both high-throughput
  attributes were always set, scoping deduplication to the message group rather
  than the whole queue. Now opt-in via `attributes.highThroughputFifo`.
- **Queue URLs were re-fetched on every operation**, costing an extra billed SQS
  call and a round trip per publish. They are now resolved once and cached, with
  concurrent resolutions sharing a single lookup.
- Removed `as string` casts that hid `undefined` queue URLs and ARNs behind the
  type system; missing values now raise a descriptive error.
- The test suite could not run: `jest` was never a declared dependency and there
  was no `test` script.

### Added

- `Producer.sendBatch()`, chunking across SQS's 10-entry **and** 256 KiB limits,
  with `BatchSendError` reporting exactly which entries failed and which already
  landed — so a retry cannot duplicate accepted messages.
- Full queue provisioning: visibility timeout, retention, delay, maximum message
  size, long-poll duration, SSE (SQS-managed or KMS), access policy, redrive
  allow policy and tags. Values are range-checked locally with the field name and
  accepted range, rather than surfacing as opaque AWS errors.
- Opt-in `reconcileAttributes` to align an existing queue with its configuration.
  Only explicitly configured attributes are considered, so it cannot write
  library defaults onto a live queue.
- A typed error hierarchy (`HeadlessSqsError` and subclasses) with stable `code`
  values and `cause` preservation, plus an `isHeadlessSqsError` guard.
- Pluggable `Logger` (`silentLogger` by default, `consoleLogger` provided)
  replacing hardcoded `console.error` calls.
- Typed consumer events, with an unlistened `error` routed to the logger instead
  of crashing the process the way a bare `EventEmitter` would.
- Graceful shutdown: `stop({ abort, timeoutMs })` and `destroy()`, which closes
  the SQS client only when the library created it.
- Idempotent `start()`, and safe concurrent queue provisioning that adopts an
  existing queue rather than failing when it loses a creation race.
- A clear error for `QueueDeletedRecently`, explaining SQS's 60-second window.
- Automatic recovery when a cached queue URL becomes stale: the entry is dropped
  and the operation retried once.
- `terminateVisibilityTimeout` resets visibility on failed and skipped messages
  directly. Delegating it to `sqs-consumer` would have made it a no-op, because
  that only triggers when the batch handler throws and ours deliberately does not.
- Message validation before the call: non-empty body, 256 KiB size accounting
  including attributes, `groupId` required on FIFO queues, per-message delay
  rejected on FIFO queues, and unique batch entry ids.
- Dual ESM and CommonJS builds with an `exports` map and separate type
  declarations for each.
- 162 tests covering every fix above, ESLint with type-aware rules, and CI across
  Node 22 and 24.

### Changed

- **Breaking:** `@aws-sdk/client-sqs` is now a peer dependency. Install it
  alongside this package.
- **Breaking:** requires Node.js 22 or newer (was 16, long past end of life).
- **Breaking:** `Producer.produce()` is now `Producer.send()`, taking a message
  rather than a raw `SendMessageCommandInput`.
- **Breaking:** the consumer handler moves into the constructor; `start()` and
  `stop()` take no handler.
- **Breaking:** `isFifo`, `createIfNotExists`, `enableDlq` and `maxReceiveCount`
  move under a `queue` object; `enableDlq` becomes `dlq`.
- `maxReceiveCount` now defaults to `5` (was `2`).
- Queues created by this library get `ReceiveMessageWaitTimeSeconds: 20`, since
  short polling bills more requests and adds latency for no benefit.
- `sqs-consumer` upgraded from `^7.1.0` to `^15.0.3`; its options are now exposed
  through this package's own types instead of a `baseConsumerOptions` passthrough.
  Following that upgrade, `attributeNames` means _queue_ attributes and the new
  `messageSystemAttributeNames` carries per-message system attributes such as
  `MessageGroupId` — the two were a single field in v7.
- The published tarball is now defined by an explicit `files` allowlist. It
  previously depended on npm's `.gitignore` fallback and shipped `src/`, `test/`,
  `tsconfig.json` and `jest.config.js`.

## [0.1.0-alpha.4] - 2023-06-16

- Added `ConsumerOptions` support.

## [0.1.0-alpha.3] - 2023-06-16

- Added consumer support.

## [0.1.0-alpha.1] - 2023-06-15

- Initial release: producer with queue auto-creation and optional dead-letter queue.

[0.2.0]: https://github.com/mohamed-akef/headless-sqs/compare/v0.1.0-alpha.4...HEAD
