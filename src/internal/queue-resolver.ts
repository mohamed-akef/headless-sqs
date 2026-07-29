import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueAttributeName,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs'
import {
  isAwsErrorNamed,
  QUEUE_NOT_FOUND_ERROR_NAMES,
  QueueNotFoundError,
  QueueProvisioningError,
} from '../errors'
import type { Logger } from '../logger'
import type { DeadLetterQueueConfig, QueueConfig } from '../types'
import {
  buildQueueAttributes,
  DEFAULT_MAX_RECEIVE_COUNT,
  diffAttributes,
  validateMaxReceiveCount,
  type QueueAttributeMap,
  type RedrivePolicyInput,
} from './attributes'
import {
  deadLetterQueueName,
  resolveQueueName,
  type ResolvedQueueName,
} from './queue-name'

/** Error names meaning another caller created the queue first. */
const ALREADY_EXISTS_ERROR_NAMES = [
  'QueueNameExists',
  'QueueAlreadyExists',
  'AWS.SimpleQueueService.QueueNameExists',
]

/** Error name SQS uses within 60 seconds of a queue being deleted. */
const DELETED_RECENTLY_ERROR_NAMES = [
  'QueueDeletedRecently',
  'AWS.SimpleQueueService.QueueDeletedRecently',
]

/** A queue whose URL is known. */
export interface ResolvedQueue {
  readonly name: string
  readonly url: string
  readonly fifo: boolean
}

/**
 * Resolves queue names to URLs, provisioning queues on demand.
 *
 * Resolution is cached: a queue URL is derived from the account, region and
 * name, so it is stable for the lifetime of a queue and re-fetching it on every
 * publish would add a round trip and an extra billed request for nothing.
 *
 * Concurrent resolutions of the same queue share one in-flight promise, so a
 * burst of parallel `send()` calls at startup issues a single `GetQueueUrl`
 * rather than one per call.
 */
export class QueueResolver {
  private readonly urlCache = new Map<string, string>()
  private readonly arnCache = new Map<string, string>()
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(
    private readonly client: SQSClient,
    private readonly logger: Logger,
  ) {}

  /** Resolve (and if configured, create) the queue described by `config`. */
  async resolve(config: QueueConfig): Promise<ResolvedQueue> {
    const name = resolveQueueName(config.name, config.fifo)

    const cached = this.urlCache.get(name.name)
    if (cached !== undefined) {
      return { name: name.name, url: cached, fifo: name.fifo }
    }

    let pending = this.inFlight.get(name.name)
    if (pending === undefined) {
      pending = this.resolveUrl(name, config).finally(() => {
        this.inFlight.delete(name.name)
      })
      this.inFlight.set(name.name, pending)
    }

    const url = await pending
    this.urlCache.set(name.name, url)
    return { name: name.name, url, fifo: name.fifo }
  }

  /**
   * Drop cached state for a queue.
   *
   * Call this when SQS reports a cached queue as missing — it may have been
   * deleted and recreated — so the next resolve goes back to AWS.
   */
  invalidate(queueName: string): void {
    const url = this.urlCache.get(queueName)
    this.urlCache.delete(queueName)
    if (url !== undefined) {
      this.arnCache.delete(url)
    }
  }

  private async resolveUrl(
    name: ResolvedQueueName,
    config: QueueConfig,
  ): Promise<string> {
    const existing = await this.lookupUrl(name.name)

    if (existing !== undefined) {
      if (config.reconcileAttributes === true) {
        await this.reconcileAttributes(name, existing, config)
      }
      return existing
    }

    if (config.createIfNotExists !== true) {
      throw new QueueNotFoundError(name.name)
    }

    const redrive = await this.provisionDeadLetterQueue(name, config)
    const attributes = buildQueueAttributes({
      fifo: name.fifo,
      config: config.attributes,
      redrive,
    })
    return this.createQueue(name, attributes, config.tags)
  }

  /** Look up a queue URL, returning `undefined` when the queue does not exist. */
  private async lookupUrl(queueName: string): Promise<string | undefined> {
    let result
    try {
      result = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }))
    } catch (error) {
      if (isAwsErrorNamed(error, ...QUEUE_NOT_FOUND_ERROR_NAMES)) {
        return undefined
      }
      throw error
    }

    if (result.QueueUrl === undefined) {
      throw new QueueProvisioningError(
        queueName,
        `SQS returned no queue URL for "${queueName}".`,
      )
    }
    return result.QueueUrl
  }

  /**
   * Ensure the dead-letter queue exists and return the redrive policy pointing
   * at it.
   *
   * A dead-letter queue is never itself given a dead-letter queue — no redrive
   * policy is passed down, so the recursion terminates by construction.
   */
  private async provisionDeadLetterQueue(
    primary: ResolvedQueueName,
    config: QueueConfig,
  ): Promise<RedrivePolicyInput | undefined> {
    if (config.dlq === undefined || config.dlq === false) {
      return undefined
    }

    const dlqConfig: DeadLetterQueueConfig = config.dlq === true ? {} : config.dlq
    const name = deadLetterQueueName(primary, dlqConfig.name)
    const maxReceiveCount = validateMaxReceiveCount(
      dlqConfig.maxReceiveCount ?? DEFAULT_MAX_RECEIVE_COUNT,
    )

    const url =
      (await this.lookupUrl(name.name)) ??
      (await this.createQueue(
        name,
        buildQueueAttributes({ fifo: name.fifo, config: dlqConfig.attributes }),
        dlqConfig.tags,
      ))

    return {
      deadLetterTargetArn: await this.getArn(name.name, url),
      maxReceiveCount,
    }
  }

  private async createQueue(
    name: ResolvedQueueName,
    attributes: QueueAttributeMap,
    tags: Record<string, string> | undefined,
  ): Promise<string> {
    this.logger.debug('creating queue', { queue: name.name, fifo: name.fifo })

    let result
    try {
      result = await this.client.send(
        new CreateQueueCommand({
          QueueName: name.name,
          Attributes: attributes,
          ...(tags !== undefined ? { tags } : {}),
        }),
      )
    } catch (error) {
      // Another process created the queue between our lookup and this call.
      // The queue exists, which is all the caller asked for, so adopt it.
      if (isAwsErrorNamed(error, ...ALREADY_EXISTS_ERROR_NAMES)) {
        const url = await this.lookupUrl(name.name)
        if (url !== undefined) {
          this.logger.warn(
            'queue already existed when creating it; adopting the existing queue. ' +
              'Its attributes may differ from the ones configured here.',
            { queue: name.name },
          )
          return url
        }
      }

      if (isAwsErrorNamed(error, ...DELETED_RECENTLY_ERROR_NAMES)) {
        throw new QueueProvisioningError(
          name.name,
          `Queue "${name.name}" was deleted less than 60 seconds ago. SQS refuses ` +
            `to recreate a queue with the same name until that window has passed.`,
          { cause: error },
        )
      }

      throw new QueueProvisioningError(
        name.name,
        `Failed to create queue "${name.name}": ${describeError(error)}`,
        { cause: error },
      )
    }

    if (result.QueueUrl === undefined) {
      throw new QueueProvisioningError(
        name.name,
        `SQS accepted the creation of "${name.name}" but returned no queue URL.`,
      )
    }

    this.logger.info('created queue', { queue: name.name, url: result.QueueUrl })
    return result.QueueUrl
  }

  private async getArn(queueName: string, url: string): Promise<string> {
    const cached = this.arnCache.get(url)
    if (cached !== undefined) {
      return cached
    }

    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [QueueAttributeName.QueueArn],
      }),
    )

    const arn = result.Attributes?.[QueueAttributeName.QueueArn]
    if (arn === undefined) {
      throw new QueueProvisioningError(
        queueName,
        `Could not read the ARN of queue "${queueName}", which is required to ` +
          `wire up a dead-letter queue.`,
      )
    }

    this.arnCache.set(url, arn)
    return arn
  }

  /**
   * Align an existing queue's attributes with the configured ones.
   *
   * Only attributes explicitly set in the config are considered — library
   * defaults are excluded, so enabling reconciliation cannot silently rewrite a
   * live queue with an opinion the caller never expressed. `RedrivePolicy` is
   * also left alone, since replacing it could detach a dead-letter queue that
   * was configured elsewhere.
   */
  private async reconcileAttributes(
    name: ResolvedQueueName,
    url: string,
    config: QueueConfig,
  ): Promise<void> {
    if (config.attributes === undefined) {
      return
    }

    const desired = buildQueueAttributes({
      fifo: name.fifo,
      config: config.attributes,
      applyDefaults: false,
    })
    if (Object.keys(desired).length === 0) {
      return
    }

    const current = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [QueueAttributeName.All],
      }),
    )

    const drift = diffAttributes(desired, current.Attributes ?? {})
    const drifted = Object.keys(drift)
    if (drifted.length === 0) {
      return
    }

    this.logger.info('reconciling queue attributes', {
      queue: name.name,
      attributes: drifted,
    })
    await this.client.send(
      new SetQueueAttributesCommand({ QueueUrl: url, Attributes: drift }),
    )
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
