import type { Message } from '@aws-sdk/client-sqs'
import { describe, expect, it } from 'vitest'
import { processOrderedByGroup, processUnordered } from '../src/internal/process-batch'

function message(id: string, groupId?: string): Message {
  return {
    MessageId: id,
    Body: id,
    ReceiptHandle: `receipt-${id}`,
    ...(groupId !== undefined ? { Attributes: { MessageGroupId: groupId } } : {}),
  }
}

/** Resolves on the next macrotask, so interleaving is observable. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1))

describe('processUnordered', () => {
  it('returns every message when all handlers succeed', async () => {
    const messages = [message('a'), message('b'), message('c')]

    const outcome = await processUnordered(messages, () => Promise.resolve(), 10)

    expect(outcome.successful).toHaveLength(3)
    expect(outcome.failures).toHaveLength(0)
    expect(outcome.skipped).toHaveLength(0)
  })

  it('isolates a failure to the message that caused it', async () => {
    // Regression: the previous implementation used Promise.all, so one rejection
    // meant the whole batch went undeleted and every message — including the
    // nine that succeeded — was redelivered and processed a second time.
    const messages = [message('a'), message('b'), message('c')]

    const outcome = await processUnordered(
      messages,
      m =>
        m.MessageId === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve(),
      10,
    )

    expect(outcome.successful.map(m => m.MessageId)).toEqual(['a', 'c'])
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]!.message.MessageId).toBe('b')
  })

  it('reports a failure for every message when all fail', async () => {
    const outcome = await processUnordered(
      [message('a'), message('b')],
      () => Promise.reject(new Error('boom')),
      10,
    )

    expect(outcome.successful).toEqual([])
    expect(outcome.failures).toHaveLength(2)
  })

  it('never exceeds the concurrency limit', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(String(i)))
    let active = 0
    let peak = 0

    await processUnordered(
      messages,
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
      },
      3,
    )

    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('handles an empty batch', async () => {
    const outcome = await processUnordered([], () => Promise.resolve(), 5)
    expect(outcome.successful).toEqual([])
  })
})

describe('processOrderedByGroup', () => {
  it('processes a single group strictly in order', async () => {
    const messages = ['a', 'b', 'c'].map(id => message(id, 'group-1'))
    const seen: string[] = []

    await processOrderedByGroup(
      messages,
      async m => {
        await tick()
        seen.push(m.MessageId!)
      },
      10,
    )

    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('runs separate message groups in parallel', async () => {
    // SQS only guarantees ordering within a group, so different groups must not
    // be serialised behind each other.
    const messages = [
      message('a1', 'group-1'),
      message('b1', 'group-2'),
      message('a2', 'group-1'),
      message('b2', 'group-2'),
    ]
    let active = 0
    let peak = 0

    await processOrderedByGroup(
      messages,
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
      },
      10,
    )

    expect(peak).toBe(2)
  })

  it('stops a group at its first failure and leaves the rest queued', async () => {
    const messages = ['a', 'b', 'c'].map(id => message(id, 'group-1'))
    const attempted: string[] = []

    const outcome = await processOrderedByGroup(
      messages,
      m => {
        attempted.push(m.MessageId!)
        return m.MessageId === 'b'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve()
      },
      10,
    )

    // 'c' must never run: processing it after 'b' failed would deliver the
    // group out of order.
    expect(attempted).toEqual(['a', 'b'])
    expect(outcome.successful.map(m => m.MessageId)).toEqual(['a'])
    expect(outcome.failures.map(f => f.message.MessageId)).toEqual(['b'])
    expect(outcome.skipped.map(m => m.MessageId)).toEqual(['c'])
  })

  it('keeps a failure in one group from affecting another', async () => {
    const messages = [
      message('a1', 'group-1'),
      message('a2', 'group-1'),
      message('b1', 'group-2'),
      message('b2', 'group-2'),
    ]

    const outcome = await processOrderedByGroup(
      messages,
      m =>
        m.MessageId === 'a1' ? Promise.reject(new Error('boom')) : Promise.resolve(),
      10,
    )

    expect(outcome.successful.map(m => m.MessageId).sort()).toEqual(['b1', 'b2'])
    expect(outcome.failures.map(f => f.message.MessageId)).toEqual(['a1'])
    expect(outcome.skipped.map(m => m.MessageId)).toEqual(['a2'])
  })

  it('caps how many groups run at once', async () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      message(String(i), `group-${String(i)}`),
    )
    let active = 0
    let peak = 0

    await processOrderedByGroup(
      messages,
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
      },
      2,
    )

    expect(peak).toBeLessThanOrEqual(2)
  })

  it('serialises the whole batch when group ids are missing', async () => {
    // Without a group id there is no way to know which messages share ordering
    // constraints, so the safe fallback is one ordered sequence.
    const messages = [message('a'), message('b'), message('c')]
    let active = 0
    let peak = 0
    const seen: string[] = []

    await processOrderedByGroup(
      messages,
      async m => {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        seen.push(m.MessageId!)
        active -= 1
      },
      10,
    )

    expect(peak).toBe(1)
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})
