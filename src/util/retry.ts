export interface RetryConfig {
  maxRetries: number
  baseDelay: number
  maxDelay: number
  retryableErrors: string[]
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  retryableErrors: ["rate_limit", "timeout", "connection_error", "5"],
}

function isRetryable(error: Error, patterns: string[]): boolean {
  const msg = error.message.toLowerCase()
  return patterns.some(
    (p) => msg.includes(p.toLowerCase()),
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config }
  let lastError: Error = new Error("Unknown error")

  for (let i = 0; i <= cfg.maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (!isRetryable(lastError, cfg.retryableErrors)) {
        throw lastError
      }

      if (i < cfg.maxRetries) {
        const jitter = Math.random() * cfg.baseDelay
        const delay = Math.min(
          cfg.baseDelay * Math.pow(2, i) + jitter,
          cfg.maxDelay,
        )
        await sleep(delay)
      }
    }
  }

  throw lastError
}
