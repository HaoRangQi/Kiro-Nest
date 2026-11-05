/**
 * Kiro provider errors that carry a stable machine-routable code.
 *
 * This module deliberately has no dependency on an HTTP framework: the gateway
 * maps these errors to OpenAI/Anthropic protocol vocabulary at its boundary.
 */

/** Serializable failure facts retained beside the live error. */
export interface KiroErrorOptions extends ErrorOptions {
  /** HTTP status observed at the provider boundary, when any. */
  status?: number
  /** Opaque provider request identifier for diagnostics. */
  requestId?: string
  /** Provider-requested retry delay in milliseconds. */
  providerRetryAfterMs?: number
}

/** Typed error for every Kiro credential, transport, and protocol failure. */
export class KiroError extends Error {
  /** Stable machine-routable failure class (e.g. `AUTH`, `RATE_LIMIT`). */
  readonly code: string
  /** HTTP status observed at the provider boundary, when any. */
  readonly status: number | undefined
  /** Opaque provider request identifier, when any. */
  readonly requestId: string | undefined
  /** Provider-requested retry delay in milliseconds, when any. */
  readonly providerRetryAfterMs: number | undefined

  constructor(message: string, code: string, options: KiroErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KiroError'
    this.code = code
    this.status = options.status
    this.requestId = options.requestId
    this.providerRetryAfterMs = options.providerRetryAfterMs
  }
}

/** Narrow an unknown thrown value to a {@link KiroError}. */
export function isKiroError(value: unknown): value is KiroError {
  return value instanceof KiroError
}

/** Canonical code for a request rejected because its context window was exceeded. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
/** Canonical code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'
/** Canonical code for a response that completed without any content. */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
