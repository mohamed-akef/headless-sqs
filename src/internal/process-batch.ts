import type { Message } from '@aws-sdk/client-sqs'
import type { MessageHandler } from '../types'

/** A message whose handler rejected. */
export interface BatchFailure {
  message: Message
  error: unknown
}

/** What happened to each message in a received batch. */
export interface BatchOutcome {
  /** Handled successfully — safe to delete from the queue. */
  successful: Message[]
  /** The handler rejected. Left in the queue for redelivery. */
  failures: BatchFailure[]
  /**
   * Never handed to the handler, because an earlier message in the same FIFO
   * message group failed. Left in the queue so ordering survives redelivery.
   */
  skipped: Message[]
}

/**
 * Run `worker` over `items`, at most `limit` at a time.
 *
 * `worker` must not reject — callers record outcomes rather than throwing, so
 * one bad message cannot abort the pool.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item === undefined) continue
      await worker(item)
    }
  })

  await Promise.all(runners)
}

/**
 * Process a batch with no ordering constraints, up to `concurrency` at a time.
 *
 * Each message succeeds or fails on its own, so a single bad message does not
 * force its whole batch to be redelivered and reprocessed.
 */
export async function processUnordered(
  messages: readonly Message[],
  handler: MessageHandler,
  concurrency: number,
): Promise<BatchOutcome> {
  const successful: Message[] = []
  const failures: BatchFailure[] = []

  await runPool(messages, concurrency, async message => {
    try {
      await handler(message)
      successful.push(message)
    } catch (error) {
      failures.push({ message, error })
    }
  })

  return { successful, failures, skipped: [] }
}

/**
 * Process a FIFO batch: message groups run in parallel, messages within a group
 * run in order.
 *
 * SQS only guarantees ordering *within* a message group, so serialising the
 * whole batch would give up throughput for nothing. When a message fails, the
 * rest of its group is skipped — processing them would deliver messages out of
 * order — while other groups continue unaffected.
 */
export async function processOrderedByGroup(
  messages: readonly Message[],
  handler: MessageHandler,
  concurrency: number,
): Promise<BatchOutcome> {
  const successful: Message[] = []
  const failures: BatchFailure[] = []
  const skipped: Message[] = []

  await runPool(groupByMessageGroupId(messages), concurrency, async group => {
    for (let index = 0; index < group.length; index += 1) {
      const message = group[index]
      if (message === undefined) continue

      try {
        await handler(message)
        successful.push(message)
      } catch (error) {
        failures.push({ message, error })
        skipped.push(...group.slice(index + 1))
        return
      }
    }
  })

  return { successful, failures, skipped }
}

/**
 * Split a batch into per-message-group sequences, preserving both the order
 * groups were first seen and the order of messages within each group.
 *
 * If any message arrives without a `MessageGroupId` — typically because the
 * attribute was not requested — the batch is treated as a single ordered
 * sequence. That is slower but never reorders messages, which is the safer way
 * to be wrong.
 */
function groupByMessageGroupId(messages: readonly Message[]): Message[][] {
  const groups = new Map<string, Message[]>()

  for (const message of messages) {
    const groupId = message.Attributes?.MessageGroupId
    if (groupId === undefined) {
      return [[...messages]]
    }

    const existing = groups.get(groupId)
    if (existing === undefined) {
      groups.set(groupId, [message])
    } else {
      existing.push(message)
    }
  }

  return [...groups.values()]
}
