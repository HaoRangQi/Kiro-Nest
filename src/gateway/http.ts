/**
 * 网关 HTTP 公共工具：JSON 读写、SSE 编码、错误映射、图片 data URL 解析与
 * 流式结果聚合。
 *
 * @module kiro-nest/gateway/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  ChatChunk,
  ChatContentBlockResult,
  ChatFinishReason,
  ChatUsage,
} from '../chat.ts'
import { isKiroError } from '../errors.ts'

/** 请求体过大时抛出的 HTTP 错误。 */
export class HttpError extends Error {
  /** 返回给客户端的 HTTP 状态码。 */
  readonly status: number
  /** 机器可读的错误类型，例如 `invalid_request_error`。 */
  readonly type: string

  constructor(status: number, message: string, type = 'invalid_request_error') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.type = type
  }
}

/** 默认请求体上限：足够容纳多张 base64 图片。 */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * 读取并解析 JSON 请求体。
 * @param request - 传入请求。
 * @param maximumBytes - 允许的最大字节数。
 * @returns 解析后的 JSON 对象。
 * @throws `HttpError(400|413)` 当请求体不合法或过大时。
 */
export async function readJson(
  request: IncomingMessage,
  maximumBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
    bytes += chunk.byteLength
    if (bytes > maximumBytes) {
      throw new HttpError(413, 'Request body is too large', 'request_too_large')
    }
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error: unknown) {
    throw new HttpError(400, 'Request body is not valid JSON', 'invalid_request_error')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object', 'invalid_request_error')
  }
  return value as Record<string, unknown>
}

/**
 * 发送 JSON 响应。
 * @param response - 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可序列化的响应体。
 */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

/** 发送纯文本响应。 */
export function sendText(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** 写入 SSE 需要的响应头。 */
export function writeSseHead(response: ServerResponse): void {
  if (response.headersSent) return
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/** 把对象编码成一条 SSE `data:` 帧。 */
export function sseData(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
}

/** 把对象编码成一条带事件名的 SSE 帧。 */
export function sseEvent(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
}

/** 生成带前缀的随机 id。 */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 把错误映射成客户端可用的 HTTP 状态码。
 * @param error - 捕获的错误。
 * @returns 建议的状态码。
 */
export function statusForError(error: unknown): number {
  if (error instanceof HttpError) return error.status
  if (!isKiroError(error)) return 500
  switch (error.code) {
    case 'AUTH':
    case 'FORBIDDEN':
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
      // 上游凭据问题对客户端是网关错误，不是客户端未授权。
      return 502
    case 'QUOTA':
      return 402
    case 'RATE_LIMIT':
      return 429
    case 'INVALID_MODEL':
      return 404
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_CONTENT':
    case 'UNSUPPORTED_REASONING_EFFORT':
    case 'UNSUPPORTED_TOOL_NAME':
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 400
    case 'TIMEOUT':
      return 504
    case 'ABORTED':
      return 499
    default:
      return 502
  }
}

/**
 * 构造 OpenAI 风格的错误体。
 * @param error - 捕获的错误。
 * @param type - 错误类型。
 */
export function openAIErrorBody(
  error: unknown,
  type = 'api_error',
): { error: { message: string; type: string; code?: string } } {
  const status = statusForError(error)
  const message = error instanceof Error ? error.message : String(error)
  const code = isKiroError(error) ? error.code : error instanceof HttpError ? error.type : undefined
  return {
    error: {
      message,
      type: status === 400 ? 'invalid_request_error' : type,
      ...code === undefined ? {} : { code },
    },
  }
}

/**
 * 构造 Anthropic 风格的错误体。
 * @param error - 捕获的错误。
 */
export function anthropicErrorBody(
  error: unknown,
): { type: 'error'; error: { type: string; message: string } } {
  const status = statusForError(error)
  const message = error instanceof Error ? error.message : String(error)
  const type = status === 400 ? 'invalid_request_error'
    : status === 401 ? 'authentication_error'
      : status === 403 ? 'permission_error'
        : status === 404 ? 'not_found_error'
          : status === 429 ? 'rate_limit_error'
            : status === 413 ? 'request_too_large'
              : 'api_error'
  return { type: 'error', error: { type, message } }
}

/** Kiro 支持的图片媒体类型。 */
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([\s\S]+)$/u

/**
 * 解析 `data:` 形式的图片 URL。
 * @param url - OpenAI `image_url.url` 的值。
 * @returns 媒体类型与 base64 数据。
 * @throws `HttpError(400)` 当 URL 不是受支持的 data URL 时。
 */
export function parseImageDataUrl(url: string): { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } {
  const match = IMAGE_DATA_URL.exec(url.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new HttpError(
      400,
      'image_url must be a base64 data URL (data:image/png;base64,...); remote URLs are not fetched by the gateway',
      'invalid_request_error',
    )
  }
  const declared = match[1].toLowerCase()
  const mediaType = declared === 'image/jpg' ? 'image/jpeg' : declared
  return { mediaType: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: match[2] }
}

/**
 * 把 `stop` 字段规范成字符串数组。
 * @param value - OpenAI 的 `stop` 字段。
 */
export function stopSequences(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.length > 0) return [value]
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return items.length === 0 ? undefined : items
  }
  return undefined
}

/** 聚合后的完整响应。 */
export interface CollectedResponse {
  blocks: ChatContentBlockResult[]
  finish: ChatFinishReason
  usage?: ChatUsage
}

/**
 * 聚合一次流式响应，供非流式端点使用。
 * @param chunks - 核心流。
 * @returns 组装完成的块、结束原因与用量。
 */
export async function collectResponse(chunks: AsyncIterable<ChatChunk>): Promise<CollectedResponse> {
  const blocks = new Map<number, ChatContentBlockResult>()
  let finish: ChatFinishReason = { kind: 'stop' }
  let usage: ChatUsage | undefined
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-end':
        blocks.set(chunk.index, chunk.block)
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  return {
    blocks: [...blocks.entries()].sort((left, right) => left[0] - right[0]).map(entry => entry[1]),
    finish,
    ...usage === undefined ? {} : { usage },
  }
}

/**
 * 判断结束原因是否需要作为错误上报。
 * @param reason - 核心结束原因。
 */
export function finishFailure(reason: ChatFinishReason): { message: string; code: string; status?: number } | undefined {
  return reason.kind === 'error' || reason.kind === 'aborted' ? reason.failure : undefined
}
