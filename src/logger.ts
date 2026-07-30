/**
 * Minimal structured-logging surface.
 *
 * Deliberately compatible with the common shape of `pino`, `winston`, `bunyan`
 * and `console`, so most projects can pass their logger straight in.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

/**
 * Discards everything. The default — a library should not write to a host
 * application's stdout unless asked to.
 */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Routes to the matching `console` method. Handy in development. */
export const consoleLogger: Logger = {
  debug: (message, context) =>
    console.debug(`[headless-sqs] ${message}`, context ?? ''),
  info: (message, context) => console.info(`[headless-sqs] ${message}`, context ?? ''),
  warn: (message, context) => console.warn(`[headless-sqs] ${message}`, context ?? ''),
  error: (message, context) =>
    console.error(`[headless-sqs] ${message}`, context ?? ''),
}
