import { describe, expect, it } from 'vitest'
import { InvalidQueueNameError } from '../src/errors'
import { deadLetterQueueName, resolveQueueName } from '../src/internal/queue-name'

describe('resolveQueueName', () => {
  it('passes a standard queue name through unchanged', () => {
    expect(resolveQueueName('orders', false)).toEqual({
      name: 'orders',
      base: 'orders',
      fifo: false,
    })
  })

  it('appends the FIFO suffix for a FIFO queue', () => {
    expect(resolveQueueName('orders', true).name).toBe('orders.fifo')
  })

  it('does not double the FIFO suffix when the name already has one', () => {
    // Regression: the previous implementation appended unconditionally, so a
    // resolved name fed back in became "orders.fifo.fifo".
    expect(resolveQueueName('orders.fifo', true).name).toBe('orders.fifo')
  })

  it('infers FIFO from the suffix when not stated', () => {
    const resolved = resolveQueueName('orders.fifo')
    expect(resolved.fifo).toBe(true)
    expect(resolved.base).toBe('orders')
  })

  it('infers standard when there is no suffix and nothing is stated', () => {
    expect(resolveQueueName('orders').fifo).toBe(false)
  })

  it('rejects a .fifo name explicitly marked as non-FIFO', () => {
    expect(() => resolveQueueName('orders.fifo', false)).toThrow(InvalidQueueNameError)
  })

  it('trims surrounding whitespace', () => {
    expect(resolveQueueName('  orders  ', false).name).toBe('orders')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
  ])('rejects an %s name (%s)', rawName => {
    expect(() => resolveQueueName(rawName, false)).toThrow(InvalidQueueNameError)
  })

  it.each(['orders queue', 'orders!', 'orders/one', 'orders.v2'])(
    'rejects the invalid name %s',
    rawName => {
      expect(() => resolveQueueName(rawName, false)).toThrow(InvalidQueueNameError)
    },
  )

  it('accepts a name that is exactly 80 characters including the suffix', () => {
    const base = 'a'.repeat(75)
    expect(resolveQueueName(base, true).name).toHaveLength(80)
  })

  it('rejects a name that exceeds 80 characters once the suffix is added', () => {
    const base = 'a'.repeat(76)
    expect(() => resolveQueueName(base, true)).toThrow(InvalidQueueNameError)
  })

  it('reports the byte count in the error so the limit is actionable', () => {
    expect(() => resolveQueueName('a'.repeat(81), false)).toThrow(/at most 80/)
  })
})

describe('deadLetterQueueName', () => {
  it('prefixes a standard queue name', () => {
    const primary = resolveQueueName('orders', false)
    expect(deadLetterQueueName(primary).name).toBe('dlq-orders')
  })

  it('keeps the FIFO suffix valid after prefixing', () => {
    const primary = resolveQueueName('orders', true)
    // Not "dlq-orders" and not "dlq-orders.fifo.fifo".
    expect(deadLetterQueueName(primary).name).toBe('dlq-orders.fifo')
  })

  it('honours an explicit dead-letter queue name', () => {
    const primary = resolveQueueName('orders', false)
    expect(deadLetterQueueName(primary, 'orders-failures').name).toBe('orders-failures')
  })

  it('makes an overridden name FIFO when the primary queue is FIFO', () => {
    // A FIFO queue's dead-letter queue must itself be FIFO.
    const primary = resolveQueueName('orders', true)
    expect(deadLetterQueueName(primary, 'failures').name).toBe('failures.fifo')
  })

  it('explains what to do when the derived name would be too long', () => {
    const primary = resolveQueueName('a'.repeat(78), false)
    expect(() => deadLetterQueueName(primary)).toThrow(/dlq\.name/)
  })
})
