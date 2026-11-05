/**
 * Anthropic Messages API 兼容层。
 *
 * 让 Claude Code、Claude 官方 SDK 等使用 Anthropic 协议的客户端也能把 Kiro
 * 当作模型后端。请求在 `toAnthropicChatRequest` 中翻译成核心请求，流式响应
 * 由 `AnthropicStreamEncoder` 编码成 Anthropic 的事件序列。
 *
 * @module kiro-nest/gateway/anthropic
 */

import type {
  ChatChunk,
  ChatContentBlock,
  ChatContentBlockResult,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolSchema,
  ChatUsage,
} from '../chat.ts'
import type { KiroCatalogModel } from '../connection.ts'
import type { CollectedResponse } from './http.ts'
import {
  collectResponse,
  finishFailure,
  HttpError,
  newId,
  parseImageDataUrl,
  sseEvent,
} from './http.ts'

/** 组装 Anthropic 请求需要的网关上下文。 */
export interface AnthropicRequestOptions {
  /** 配置的默认模型。 */
  defaultModel: string
  /** 当前可用模型。 */
  models: readonly KiroCatalogModel[]
  /** 由请求头传入的会话标识。 */
  sessionId?: string
  /** 请求头覆盖的推理强度。 */
  reasoningEffort?: string
}

/** Anthropic 图片块。 */
interface AnthropicImage {
  type: 'image'
  source?: { type?: string; media_type?: string; data?: string }
}

/** 解析 Anthropic 的 content 字段。 */
function systemText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!Array.isArray(value)) return undefined
  const text = value
    .filter((part): part is { type: string; text: string } =>
      typeof part === 'object' && part !== null
      && (part as Record<string, unknown>)['type'] === 'text'
      && typeof (part as Record<string, unknown>)['text'] === 'string')
    .map(part => part.text)
    .join('\n')
  return text.length === 0 ? undefined : text
}

/** 把 Anthropic 的 thinking 预算映射成 Kiro 的推理强度。 */
function effortFromThinking(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const thinking = value as Record<string, unknown>
  if (thinking['type'] === 'disabled') return 'off'
  const budget = thinking['budget_tokens']
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return undefined
  if (budget <= 4_000) return 'low'
  if (budget <= 12_000) return 'medium'
  return 'high'
}

/** 解析 Anthropic 的图片块。 */
function imageBlock(block: Record<string, unknown>): ChatContentBlock {
  const source = typeof block['source'] === 'object' && block['source'] !== null
    ? block['source'] as { type?: unknown; media_type?: unknown; data?: unknown }
    : undefined
  if (source === undefined || source.type !== 'base64'
    || typeof source.media_type !== 'string' || typeof source.data !== 'string') {
    throw new HttpError(400, 'Anthropic image blocks must use base64 sources')
  }
  const mediaType = source.media_type.toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : source.media_type.toLowerCase()
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg'
    && mediaType !== 'image/gif' && mediaType !== 'image/webp') {
    throw new HttpError(400, `Unsupported image media type ${source.media_type}`)
  }
  return { type: 'image', image: { mediaType, data: source.data } }
}

/** 解析工具结果的内容为文本。 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const value = part as Record<string, unknown>
      return value['type'] === 'text' && typeof value['text'] === 'string' ? value['text'] : ''
    })
    .join('\n')
}

/** 解析 Anthropic 的工具声明。 */
function toolSchemas(value: unknown): ChatToolSchema[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools: ChatToolSchema[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const tool = raw as Record<string, unknown>
    const name = typeof tool['name'] === 'string' ? tool['name'].trim() : ''
    if (name.length === 0) continue
    tools.push({
      name,
      description: typeof tool['description'] === 'string' ? tool['description'] : '',
      parameters: typeof tool['input_schema'] === 'object' && tool['input_schema'] !== null
        ? tool['input_schema'] as Record<string, unknown>
        : { type: 'object', properties: {} },
    })
  }
  return tools.length === 0 ? undefined : tools
}

/**
 * 选择实际使用的模型。
 * @param body - Anthropic 请求体。
 * @param options - 网关上下文。
 */
export function selectAnthropicModel(
  body: Record<string, unknown>,
  options: AnthropicRequestOptions,
): string {
  const requested = typeof body['model'] === 'string' ? body['model'].trim() : ''
  return requested.length > 0
    ? requested
    : options.defaultModel.length > 0
      ? options.defaultModel
      : options.models[0]?.id ?? 'auto'
}

/**
 * 把 Anthropic Messages 请求翻译成核心请求。
 * @param body - 已解析的请求体。
 * @param options - 网关上下文。
 * @returns 核心请求。
 * @throws `HttpError(400)` 当字段结构不合法时。
 */
export function toAnthropicChatRequest(
  body: Record<string, unknown>,
  options: AnthropicRequestOptions,
): ChatRequest {
  const rawMessages = body['messages']
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new HttpError(400, 'messages must be a non-empty array')
  }
  const messages: ChatMessage[] = []
  for (const raw of rawMessages) {
    if (typeof raw !== 'object' || raw === null) {
      throw new HttpError(400, 'each message must be an object')
    }
    const message = raw as Record<string, unknown>
    const role = message['role']
    const content = message['content']
    if (role === 'assistant') {
      const blocks: ChatContentBlock[] = []
      if (typeof content === 'string') {
        if (content.length > 0) blocks.push({ type: 'text', text: content })
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part !== 'object' || part === null) continue
          const block = part as Record<string, unknown>
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            blocks.push({ type: 'text', text: block['text'] })
          } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
            blocks.push({ type: 'reasoning', text: block['thinking'] })
          } else if (block['type'] === 'tool_use'
            && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
            blocks.push({
              type: 'tool-call',
              id: block['id'],
              name: block['name'],
              arguments: JSON.stringify(block['input'] ?? {}),
            })
          }
          // redacted_thinking 等块没有 Kiro 表示，忽略。
        }
      } else if (content !== null && content !== undefined) {
        throw new HttpError(400, 'assistant content must be a string or array')
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    if (role !== 'user') {
      throw new HttpError(400, `Unsupported message role ${String(role)}`)
    }
    if (typeof content === 'string') {
      messages.push({ role: 'user', content: content.length === 0 ? [] : [{ type: 'text', text: content }] })
      continue
    }
    if (!Array.isArray(content)) {
      throw new HttpError(400, 'user content must be a string or array')
    }
    const userBlocks: ChatContentBlock[] = []
    const toolMessages: ChatMessage[] = []
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const block = part as Record<string, unknown>
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        userBlocks.push({ type: 'text', text: block['text'] })
      } else if (block['type'] === 'image') {
        userBlocks.push(imageBlock(block))
      } else if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        toolMessages.push({
          role: 'tool',
          toolCallId: block['tool_use_id'],
          content: [{ type: 'text', text: toolResultText(block['content']) }],
          ...block['is_error'] === true ? { isError: true } : {},
        })
      }
    }
    // Anthropic 把工具结果放在 user 消息里；核心协议把它们表示为 tool 角色，
    // 顺序上先给结果，再给同一消息里的文本。
    messages.push(...toolMessages)
    if (userBlocks.length > 0) messages.push({ role: 'user', content: userBlocks })
  }
  const maxTokens = typeof body['max_tokens'] === 'number' ? body['max_tokens'] : undefined
  const thinkingEffort = effortFromThinking(body['thinking'])
  const reasoningEffort = options.reasoningEffort
    ?? thinkingEffort
    ?? (typeof body['reasoning_effort'] === 'string' && body['reasoning_effort'].length > 0
      ? body['reasoning_effort']
      : undefined)
  const tools = toolSchemas(body['tools'])
  const stop = Array.isArray(body['stop_sequences'])
    ? body['stop_sequences'].filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined
  const sessionId = options.sessionId
    ?? (typeof body['metadata'] === 'object' && body['metadata'] !== null
      ? (body['metadata'] as Record<string, unknown>)['user_id']
      : undefined)
  return {
    model: selectAnthropicModel(body, options),
    messages,
    ...systemText(body['system']) === undefined
      ? {}
      : { system: systemText(body['system']) as string },
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...stop === undefined || stop.length === 0 ? {} : { stop },
    ...typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {},
  }
}

/** Anthropic stop_reason 词汇。 */
export function anthropicStopReason(
  reason: ChatFinishReason,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  switch (reason.kind) {
    case 'tool-calls':
      return 'tool_use'
    case 'max-tokens':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

/** Anthropic usage 对象。 */
function anthropicUsage(usage: ChatUsage | undefined): Record<string, number> | undefined {
  if (usage === undefined) return undefined
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  }
}

/** 把工具参数 JSON 解析成 Anthropic 需要的对象。 */
function toolInput(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** 把聚合结果转换成 Anthropic content 块。 */
function anthropicContent(blocks: readonly ChatContentBlockResult[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) content.push({ type: 'thinking', thinking: block.text })
      continue
    }
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
      continue
    }
    content.push({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: toolInput(block.arguments),
    })
  }
  // Anthropic 不接受空 content 数组。
  return content.length === 0 ? [{ type: 'text', text: '' }] : content
}

/**
 * 构造非流式 Anthropic 响应。
 * @param model - 实际使用的模型。
 * @param response - 聚合后的核心响应。
 */
export function anthropicMessage(
  model: string,
  response: CollectedResponse,
): Record<string, unknown> {
  const usage = anthropicUsage(response.usage)
  return {
    id: newId('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content: anthropicContent(response.blocks),
    stop_reason: anthropicStopReason(response.finish),
    stop_sequence: null,
    ...usage === undefined ? {} : { usage },
  }
}

/**
 * 聚合一次核心流并构造非流式响应；结束原因是错误时抛出。
 * @param model - 实际使用的模型。
 * @param chunks - 核心流。
 */
export async function anthropicMessageFromStream(
  model: string,
  chunks: AsyncIterable<ChatChunk>,
): Promise<Record<string, unknown>> {
  const response = await collectResponse(chunks)
  const failure = finishFailure(response.finish)
  if (failure !== undefined) {
    throw new HttpError(failure.status ?? 502, failure.message, failure.code)
  }
  return anthropicMessage(model, response)
}

/**
 * Anthropic 流式事件编码器。
 *
 * 维护核心 block index 到 Anthropic content block index 的映射，并保证每个块
 * 都有配对的 start/stop 事件。
 */
export class AnthropicStreamEncoder {
  /** 消息 id。 */
  readonly id = newId('msg_')
  private readonly model: string
  private started = false
  private finished = false
  private readonly blockIndexes = new Map<number, number>()
  /** 已发送 start 的工具块。 */
  private readonly startedTools = new Set<number>()
  /** 已通过 block-end 关闭的块。 */
  private readonly closedBlocks = new Set<number>()
  /** 工具块在收到 name 之前不发送 start。 */
  private readonly pendingTools = new Map<number, { id: string; name?: string }>()
  private usage: ChatUsage | undefined

  constructor(model: string) {
    this.model = model
  }

  /** 分配下一个 Anthropic content block index。 */
  private nextIndex(blockIndex: number): number {
    const existing = this.blockIndexes.get(blockIndex)
    if (existing !== undefined) return existing
    const next = this.blockIndexes.size
    this.blockIndexes.set(blockIndex, next)
    return next
  }

  /** 消息开始事件。 */
  start(): string[] {
    if (this.started) return []
    this.started = true
    return [sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })]
  }

  /**
   * 编码一个核心块。
   * @param chunk - 核心流式块。
   * @returns Anthropic SSE 事件。
   */
  push(chunk: ChatChunk): string[] {
    const events: string[] = []
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType === 'tool-call') {
          // 工具名要等第一个 delta 才知道；先记录，等 delta 再开块。
          this.pendingTools.set(chunk.index, { id: '' })
          return []
        }
        const index = this.nextIndex(chunk.index)
        events.push(sseEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: chunk.blockType === 'reasoning'
            ? { type: 'thinking', thinking: '' }
            : { type: 'text', text: '' },
        }))
        return events
      }
      case 'text-delta': {
        if (chunk.text.length === 0) return []
        const index = this.nextIndex(chunk.index)
        events.push(sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: chunk.text },
        }))
        return events
      }
      case 'reasoning-delta': {
        if (chunk.text.length === 0) return []
        const index = this.nextIndex(chunk.index)
        events.push(sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: chunk.text },
        }))
        return events
      }
      case 'tool-call-delta': {
        let pending = this.pendingTools.get(chunk.index)
        if (pending === undefined) {
          pending = { id: chunk.id }
          this.pendingTools.set(chunk.index, pending)
        }
        if (pending.id.length === 0) pending.id = chunk.id
        if (chunk.name !== undefined) pending.name = chunk.name
        const index = this.nextIndex(chunk.index)
        if (!this.startedTools.has(chunk.index)) {
          this.startedTools.add(chunk.index)
          events.push(sseEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: pending.id,
              name: pending.name ?? 'unknown',
              input: {},
            },
          }))
        }
        if (chunk.argumentsDelta.length > 0) {
          events.push(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta },
          }))
        }
        return events
      }
      case 'block-end': {
        const index = this.blockIndexes.get(chunk.index)
        if (index === undefined) return []
        this.closedBlocks.add(chunk.index)
        events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }))
        return events
      }
      case 'usage':
        this.usage = chunk.usage
        return []
      case 'finish': {
        const failure = finishFailure(chunk.reason)
        if (failure !== undefined) {
          events.push(sseEvent('error', {
            type: 'error',
            error: { type: 'api_error', message: failure.message },
          }))
          return events
        }
        events.push(sseEvent('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: anthropicStopReason(chunk.reason),
            stop_sequence: null,
          },
          usage: {
            input_tokens: this.usage?.inputTokens ?? 0,
            output_tokens: this.usage?.outputTokens ?? 0,
          },
        }))
        events.push(sseEvent('message_stop', { type: 'message_stop' }))
        this.finished = true
        return events
      }
      default:
        return []
    }
  }

  /** 某个块是否已经打开。 */
  isOpen(blockIndex: number): boolean {
    return this.blockIndexes.has(blockIndex)
  }

  /**
   * 结束流：补齐未关闭的块，并在上游没有发 finish 时补一个正常结束。
   * @returns 剩余的 Anthropic SSE 事件。
   */
  end(): string[] {
    const events: string[] = []
    for (const [blockIndex, index] of this.blockIndexes) {
      if (this.closedBlocks.has(blockIndex)) continue
      this.closedBlocks.add(blockIndex)
      events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }))
    }
    if (!this.finished) {
      this.finished = true
      events.push(sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: this.usage?.inputTokens ?? 0,
          output_tokens: this.usage?.outputTokens ?? 0,
        },
      }))
      events.push(sseEvent('message_stop', { type: 'message_stop' }))
    }
    return events
  }
}

/**
 * Anthropic 模型列表响应。
 * @param models - 当前可用模型。
 */
export function anthropicModelList(models: readonly KiroCatalogModel[]): Record<string, unknown> {
  const data = models.map(model => ({
    type: 'model',
    id: model.id,
    display_name: model.name ?? model.id,
    created_at: new Date(0).toISOString(),
  }))
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  }
}
