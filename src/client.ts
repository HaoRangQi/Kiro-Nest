/**
 * Transport-agnostic Kiro client.
 *
 * This is the whole provider seam: connection facts arrive through a thunk
 * resolved once per stream call, and the bearer token through a per-request
 * resolver, so the gateway owns validation, layering, and credential policy.
 *
 * @module kiro-nest/client
 */

import { createHash, randomUUID } from 'node:crypto'
import { contentHasImage } from './chat.ts'
import type { ChatChunk, ChatRequest, ModelModality } from './chat.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from './connection.ts'
import { KiroError } from './errors.ts'
import { decodeFrames } from './eventstream.ts'
import type { KiroToken } from './auth.ts'
import { profileRegion } from './profile.ts'
import { serializeRequest } from './serialize.ts'
import { post } from './transport.ts'
import { translate } from './translate.ts'

/** Default maximum idle interval while an outstanding provider read is pending. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity for a Kiro model. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Timeout code distinguishing watchdog expiry from caller cancellation. */
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** User agent Kiro's own IDE sends; the service gates model access on it. */
export const KIRO_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE'
const CODEWHISPERER_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'

/**
 * Kiro's `ValidationException` reason for a request whose serialized content
 * exceeded the service bound. Kiro's own client maps exactly this reason to a
 * context-window-exceeded failure.
 */
const CONTEXT_OVERFLOW_REASON = 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
/**
 * Message wording Kiro's own client treats as context overflow, kept byte-for-byte
 * with the installed Kiro agent so the same recovery triggers here.
 */
const CONTEXT_OVERFLOW_MESSAGES = ['input is too long', 'prompt is too long'] as const
/**
 * Reasons that mean an allowance is spent rather than momentarily throttled,
 * taken from the service model's own enums rather than guessed.
 */
const QUOTA_REASONS = [
  'MONTHLY_REQUEST_COUNT',
  'DAILY_REQUEST_COUNT',
  'OVERAGE_REQUEST_LIMIT_EXCEEDED',
] as const
/**
 * A conversation the service will not extend further. The only lever is to make
 * the conversation smaller, so it is reported as overflow.
 */
const CONVERSATION_LIMIT_REASON = 'CONVERSATION_LIMIT_EXCEEDED'

/**
 * Models the verified account tier reaches, used when live discovery is
 * unavailable. Unlisted ids still pass through, so a tier that serves more
 * needs no code change.
 */
const VISION = ['text', 'image'] as const

/** Fallback catalog for a fresh installation or a failed discovery. */
export const DEFAULT_MODELS: KiroCatalogModel[] = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, thinking: true, inputModalities: [...VISION] },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, thinking: true, inputModalities: [...VISION] },
]

/** Human-readable name for one reasoning effort id. */
export function effortName(effort: string): string {
  if (effort === 'xhigh') return 'xHigh'
  return effort.length === 0 ? effort : `${effort[0]?.toUpperCase() ?? ''}${effort.slice(1)}`
}

/**
 * The context capacity a model is reported with.
 *
 * `maxContextWindow` is a ceiling rather than a default: it lowers whatever the
 * model claims and never raises it.
 */
export function contextCapacity(
  declared: number,
  connection: Pick<KiroConnectionOptions, 'maxContextWindow'>,
): number {
  const cap = connection.maxContextWindow
  return cap === undefined ? declared : Math.min(declared, cap)
}

/** One selectable reasoning level, provider-neutral. */
export interface KiroReasoningEffort {
  id: string
  name: string
}

/** One model resolved for a concrete request route. */
export interface KiroResolvedModel {
  id: string
  name: string
  description?: string
  inputModalities: readonly ModelModality[]
  contextWindow: number
  defaultMaxTokens?: number
  reasoningEfforts: readonly KiroReasoningEffort[]
  defaultReasoningEffort: string
}

/**
 * Recognize a Kiro HTTP 400 body that reports a context-window overflow rather
 * than an ordinary validation failure. Deliberately narrow.
 */
export function isKiroContextOverflow(body?: string): boolean {
  if (body === undefined || body.length === 0) return false
  if (body.includes(CONTEXT_OVERFLOW_REASON) || body.includes(CONVERSATION_LIMIT_REASON)) return true
  const normalized = body.toLowerCase()
  return CONTEXT_OVERFLOW_MESSAGES.some(phrase => normalized.includes(phrase))
}

/**
 * Recognize a body that reports an exhausted account allowance rather than a
 * transient throttle.
 */
export function isKiroQuotaExhausted(body?: string): boolean {
  if (body === undefined || body.length === 0) return false
  if (body.includes(CONVERSATION_LIMIT_REASON)) return false
  return QUOTA_REASONS.some(reason => body.includes(reason))
}

/**
 * Map a Kiro HTTP status and error body to a stable code.
 * @param status - status of a non-2xx response.
 * @param body - the response body text, when available.
 * @returns the normalized error code.
 */
export function httpErrorCode(status: number, body?: string): string {
  if (status === 401) return 'AUTH'
  if (status === 403) {
    if (body !== undefined && body.includes('bearer token')) return 'AUTH'
    return isKiroQuotaExhausted(body) ? 'QUOTA' : 'FORBIDDEN'
  }
  if (isKiroContextOverflow(body)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 402) return 'QUOTA'
  if (status === 429) return isKiroQuotaExhausted(body) ? 'QUOTA' : 'RATE_LIMIT'
  if (status === 400) {
    if (body !== undefined && body.includes('INVALID_MODEL_ID')) return 'INVALID_MODEL'
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Select the auth-specific upstream surface Kiro accepts. */
export function kiroRequestEndpoint(token: KiroToken, region: string): string {
  return token.authMethod === 'idc' || token.authMethod === 'external_idp'
    ? `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`
    : `https://q.${region}.amazonaws.com/generateAssistantResponse`
}

/** Add the token discriminator required by API-key and external-IdP auth. */
export function kiroTokenTypeHeaders(token: KiroToken): Record<string, string> {
  if (token.authMethod === 'api_key') return { TokenType: 'API_KEY' }
  if (token.authMethod === 'external_idp') return { TokenType: 'EXTERNAL_IDP' }
  return {}
}

/**
 * Derive a stable provider conversation id from a caller session id.
 *
 * Kiro correlates caching and diagnostics by `conversationId`, so a new random
 * id per turn presents one durable session as unrelated conversations. Hashed
 * rather than forwarded, so no caller identifier leaks upstream.
 */
export function conversationIdFor(sessionId?: string): string {
  if (sessionId === undefined || sessionId.length === 0) return randomUUID()
  const digest = createHash('sha256').update(`kiro-nest:conversation:${sessionId}`).digest()
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** Constructor dependencies owned by the caller. */
export interface KiroClientOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => KiroConnectionOptions
  /** Resolve a usable bearer token for one request's connection facts. */
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
  /** Resolve the current account catalog; failures should return configured fallback models. */
  discoverModels?: (
    connection: KiroConnectionOptions,
    signal: AbortSignal,
  ) => Promise<readonly KiroCatalogModel[]>
  /** Return the last discovered catalog synchronously for exact-model metadata. */
  currentModels?: (connection: KiroConnectionOptions) => readonly KiroCatalogModel[] | undefined
  /** Apply the caller-owned enabled-model selection before publishing the catalog. */
  selectModels?: (models: readonly KiroCatalogModel[]) => Promise<readonly KiroCatalogModel[]>
  /** Attribution appended to Kiro's `x-amz-user-agent` header. */
  userAgent?: string
}

/**
 * The Kiro `generateAssistantResponse` operation without an HTTP framework.
 *
 * One instance serves every route: the caller's model name is the wire
 * `modelId`, so adding a Kiro model is configuration rather than registration.
 */
export class KiroClient {
  private readonly config: KiroClientOptions

  constructor(config: KiroClientOptions) {
    this.config = config
  }

  /** List the models this account may reach. */
  async listModels(signal?: AbortSignal): Promise<readonly KiroCatalogModel[]> {
    const connection = this.config.options()
    const discovered = this.config.discoverModels === undefined
      ? connection.models
      : await this.config.discoverModels(connection, signal ?? AbortSignal.timeout(10_000))
    return this.config.selectModels === undefined
      ? discovered
      : await this.config.selectModels(discovered)
  }

  /** Resolve one model's metadata for routing and selectors. */
  resolveModel(model: string): KiroResolvedModel {
    const connection = this.config.options()
    const catalog = this.config.currentModels?.(connection) ?? connection.models
    const configured = catalog.find(entry => entry.id === model)
    const thinking = connection.defaults.thinking !== 'disabled' && (configured?.thinking ?? true)
    const efforts: readonly string[] = configured?.reasoningEfforts
      ?? (thinking ? ['off', 'low', 'medium', 'high'] : ['off'])
    const requestedDefault = connection.defaults.reasoningEffort
    const defaultEffort = requestedDefault !== undefined && efforts.includes(requestedDefault)
      ? requestedDefault
      : configured?.defaultReasoningEffort !== undefined
          && efforts.includes(configured.defaultReasoningEffort)
        ? configured.defaultReasoningEffort
        : efforts.includes('high') ? 'high' : efforts[0] ?? 'off'
    return {
      id: configured?.id ?? model,
      name: configured?.name ?? model,
      ...configured?.description === undefined ? {} : { description: configured.description },
      inputModalities: configured?.inputModalities ?? ['text'],
      contextWindow: contextCapacity(configured?.contextWindow ?? connection.defaultContextWindow, connection),
      ...configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens },
      reasoningEfforts: efforts.map(effort => ({ id: effort, name: effortName(effort) })),
      defaultReasoningEffort: defaultEffort,
    }
  }

  /**
   * Stream one request.
   *
   * One resolution per call: connection facts and the token freeze here and
   * hold for the whole request, so an in-flight stream never observes a
   * configuration change and the next call re-resolves.
   */
  async * stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const connection = this.config.options()
    const consumer = new AbortController()
    const upstream = request.signal === undefined
      ? consumer.signal
      : AbortSignal.any([request.signal, consumer.signal])
    let idleExpired = false
    const idle = (): void => {
      idleExpired = true
      consumer.abort(new KiroError(
        `Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
        'TIMEOUT',
      ))
    }
    let timer: ReturnType<typeof setTimeout> = setTimeout(idle, connection.streamIdleTimeoutMs)
    const onActivity = (): void => {
      clearTimeout(timer)
      timer = setTimeout(idle, connection.streamIdleTimeoutMs)
    }
    const iterator = this.request(request, upstream, connection, onActivity)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (idleExpired) {
        throw new KiroError(
          `Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (request.signal?.aborted) {
        throw new KiroError('Kiro request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof KiroError) throw error
      throw new KiroError('Kiro API stream failed', 'TRANSPORT', { cause: error })
    } finally {
      clearTimeout(timer)
      consumer.abort('Kiro stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return(undefined)
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async * request(
    request: ChatRequest,
    signal: AbortSignal,
    connection: KiroConnectionOptions,
    onActivity: () => void,
  ): AsyncGenerator<ChatChunk> {
    const token = await this.config.resolveToken(connection, signal)
    const profileArn = connection.profileArn ?? token.profileArn
    const region = profileArn === undefined
      ? connection.region ?? token.region
      : profileRegion(profileArn)
    const url = kiroRequestEndpoint(token, region)
    const catalog = this.config.currentModels?.(connection) ?? connection.models
    const selected = catalog.find(model => model.id === request.model)
    const nativeEffort = selected?.effortSchemaPath === undefined
      || selected.reasoningEfforts === undefined
      ? undefined
      : {
          schemaPath: selected.effortSchemaPath,
          levels: selected.reasoningEfforts,
          ...selected.defaultReasoningEffort === undefined
            ? {}
            : { defaultLevel: selected.defaultReasoningEffort },
        }
    // Capability before bytes: a text-only model must be refused here rather
    // than have the service reject the whole turn.
    const requestHasImages = request.messages.some(message => contentHasImage(message.content))
    if (requestHasImages && selected?.inputModalities?.includes('image') !== true) {
      throw new KiroError(
        `Kiro model "${request.model}" does not accept images.`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const body = JSON.stringify(serializeRequest(
      request,
      connection.defaults,
      conversationIdFor(request.sessionId),
      profileArn,
      nativeEffort,
      selected?.maxTokensBounds === undefined
        ? undefined
        : { maxTokensBounds: selected.maxTokensBounds },
    ))
    const attribution = this.config.userAgent === undefined ? '' : ` ${this.config.userAgent}`
    const response = await post({
      url,
      headers: {
        'content-type': 'application/json',
        accept: 'application/vnd.amazon.eventstream',
        authorization: `Bearer ${token.accessToken}`,
        ...url.includes('://codewhisperer.') ? { 'x-amz-target': CODEWHISPERER_TARGET } : {},
        ...kiroTokenTypeHeaders(token),
        'x-amzn-kiro-agent-mode': 'vibe',
        'user-agent': KIRO_USER_AGENT,
        'x-amz-user-agent': `${KIRO_USER_AGENT}${attribution}`,
      },
      body,
      signal,
      ...connection.proxyUrl === undefined ? {} : { proxyUrl: connection.proxyUrl },
    })

    if (response.status !== 200) {
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      let message = `Kiro API error (HTTP ${response.status})`
      try {
        const parsed = JSON.parse(text) as { message?: string }
        if (parsed.message !== undefined) message = parsed.message
      } catch {
        // Only swallow error-body parsing: the status still identifies the failure.
      }
      const id = response.headers['x-amzn-requestid']
      throw new KiroError(message, httpErrorCode(response.status, text), {
        status: response.status,
        ...typeof id === 'string' && id.length > 0 ? { requestId: id } : {},
      })
    }

    yield* translate(
      decodeFrames(response.body, onActivity),
      contextCapacity(selected?.contextWindow ?? connection.defaultContextWindow, connection),
    )
  }
}
