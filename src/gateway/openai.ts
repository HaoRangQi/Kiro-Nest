/**
 * OpenAI Chat Completions 兼容层。
 *
 * 负责把 `/v1/chat/completions` 请求翻译成核心 `ChatRequest`，并把核心流式
 * 块编码成 OpenAI 的 SSE chunk；非流式端点复用同一套聚合结果。
 *
 * @module kiro-nest/gateway/openai
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
  sseData,
  stopSequences,
} from './http.ts'

/** 组装 `ChatRequest` 需要的网关上下文。 */
export interface OpenAIRequestOptions {
  /** 配置的默认模型；请求未指定时使用。 */
  defaultModel: string
  /** 当前可用模型；默认模型与请求都为空时取第一个。 */
  models: readonly KiroCatalogModel[]
  /** 由请求头传入的会话标识。 */
  sessionId?: string
}

/** 把 OpenAI content 字段解析成核心内容块。 */
function contentBlocks(content: unknown): ChatContentBlock[] {
  if (content === null || content === undefined) return []
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) {
    throw new HttpError(400, 'message.content must be a string or an array of content parts')
  }
  const blocks: ChatContentBlock[] = []
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const part = raw as Record<string, unknown>
    if (part['type'] === 'text' || part['type'] === 'input_text') {
      if (typeof part['text'] === 'string' && part['text'].length > 0) {
        blocks.push({ type: 'text', text: part['text'] })
      }
      continue
    }
    if (part['type'] === 'image_url' || part['type'] === 'input_image') {
      const imageValue = part['image_url'] ?? part['image']
      const url = typeof imageValue === 'string'
        ? imageValue
        : typeof imageValue === 'object' && imageValue !== null
          ? (imageValue as Record<string, unknown>)['url']
          : undefined
      if (typeof url !== 'string') {
        throw new HttpError(400, 'image_url content part requires a url')
      }
      blocks.push({ type: 'image', image: parseImageDataUrl(url) })
      continue
    }
    // 未知 part 类型直接拒绝，避免静默丢失客户端内容。
    throw new HttpError(400, `Unsupported content part type ${String(part['type'])}`)
  }
  return blocks
}

/** 把 OpenAI `tool_calls` 解析成核心工具调用块。 */
function toolCallBlocks(value: unknown): ChatContentBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: ChatContentBlock[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const call = raw as Record<string, unknown>
    const fn = typeof call['function'] === 'object' && call['function'] !== null
      ? call['function'] as Record<string, unknown>
      : undefined
    const name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
    if (name.length === 0) continue
    const args = typeof fn?.['arguments'] === 'string'
      ? fn['arguments']
      : JSON.stringify(fn?.['arguments'] ?? {})
    blocks.push({
      type: 'tool-call',
      id: typeof call['id'] === 'string' && call['id'].length > 0 ? call['id'] : newId('call_'),
      name,
      arguments: args,
    })
  }
  return blocks
}

/** 把 OpenAI 工具声明解析成核心工具声明。 */
function toolSchemas(value: unknown): ChatToolSchema[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools: ChatToolSchema[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const tool = raw as Record<string, unknown>
    if (tool['type'] !== 'function') continue
    const fn = typeof tool['function'] === 'object' && tool['function'] !== null
      ? tool['function'] as Record<string, unknown>
      : undefined
    const name = typeof fn?.['name'] === 'string' ? fn['name'].trim() : ''
    if (name.length === 0) continue
    tools.push({
      name,
      description: typeof fn?.['description'] === 'string' ? fn['description'] : '',
      parameters: typeof fn?.['parameters'] === 'object' && fn['parameters'] !== null
        ? fn['parameters'] as Record<string, unknown>
        : { type: 'object', properties: {} },
    })
  }
  return tools.length === 0 ? undefined : tools
}

/**
 * 选择本次请求实际发往 Kiro 的模型。
 * @param body - OpenAI 请求体。
 * @param options - 网关上下文。
 */
export function selectModel(body: Record<string, unknown>, options: OpenAIRequestOptions): string {
  const requested = typeof body['model'] === 'string' ? body['model'].trim() : ''
  return requested.length > 0
    ? requested
    : options.defaultModel.length > 0
      ? options.defaultModel
      : options.models[0]?.id ?? 'auto'
}

/**
 * 把 OpenAI 请求翻译成核心请求。
 * @param body - 已解析的请求体。
 * @param options - 网关上下文。
 * @returns 核心请求。
 * @throws `HttpError(400)` 当字段结构不合法时。
 */
export function toChatRequest(body: Record<string, unknown>, options: OpenAIRequestOptions): ChatRequest {
  const rawMessages = body['messages']
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new HttpError(400, 'messages must be a non-empty array')
  }
  const messages: ChatMessage[] = []
  const systemParts: string[] = []
  for (const raw of rawMessages) {
    if (typeof raw !== 'object' || raw === null) {
      throw new HttpError(400, 'each message must be an object')
    }
    const message = raw as Record<string, unknown>
    const role = message['role']
    if (role === 'system' || role === 'developer') {
      // Kiro 只有一个 system 槽，没有 system 角色消息；合并到请求级 system。
      const blocks = contentBlocks(message['content'])
      if (blocks.some(block => block.type === 'image')) {
        throw new HttpError(400, 'system messages cannot contain images')
      }
      const text = blocks
        .filter((block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: contentBlocks(message['content']) })
      continue
    }
    if (role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [...contentBlocks(message['content']), ...toolCallBlocks(message['tool_calls'])],
      })
      continue
    }
    if (role === 'tool') {
      if (typeof message['tool_call_id'] !== 'string' || message['tool_call_id'].length === 0) {
        throw new HttpError(400, 'tool messages require tool_call_id')
      }
      messages.push({
        role: 'tool',
        toolCallId: message['tool_call_id'],
        content: contentBlocks(message['content']),
      })
      continue
    }
    throw new HttpError(400, `Unsupported message role ${String(role)}`)
  }
  if (messages.length === 0) {
    throw new HttpError(400, 'messages must contain at least one user, assistant, or tool message')
  }
  const maxTokens = typeof body['max_completion_tokens'] === 'number'
    ? body['max_completion_tokens']
    : typeof body['max_tokens'] === 'number'
      ? body['max_tokens']
      : undefined
  const reasoningEffort = typeof body['reasoning_effort'] === 'string' && body['reasoning_effort'].length > 0
    ? body['reasoning_effort']
    : undefined
  const tools = toolSchemas(body['tools'])
  const stop = stopSequences(body['stop'])
  const sessionId = options.sessionId
    ?? (typeof body['user'] === 'string' && body['user'].length > 0 ? body['user'] : undefined)
  const system = [
    ...typeof body['system'] === 'string' && body['system'].length > 0 ? [body['system']] : [],
    ...systemParts,
  ].join('\n\n')
  return {
    model: selectModel(body, options),
    messages,
    ...system.length === 0 ? {} : { system },
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...stop === undefined ? {} : { stop },
    ...sessionId === undefined ? {} : { sessionId },
  }
}

/** OpenAI finish_reason 词汇。 */
export function openAIFinishReason(reason: ChatFinishReason): 'stop' | 'tool_calls' | 'length' | 'content_filter' {
  switch (reason.kind) {
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    default:
      return 'stop'
  }
}

/** OpenAI usage 对象。 */
export function openAIUsage(usage: ChatUsage | undefined): Record<string, unknown> | undefined {
  if (usage === undefined) return undefined
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    ...usage.cacheReadTokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } },
  }
}

/** 流式编码器的状态。 */
export class OpenAIStreamEncoder {
  /** 本次补全 id。 */
  readonly id = newId('chatcmpl-')
  /** 创建时间（秒）。 */
  readonly created = Math.floor(Date.now() / 1000)
  private readonly model: string
  private roleSent = false
  private usage: ChatUsage | undefined
  private readonly toolIndexes = new Map<string, number>()

  constructor(model: string) {
    this.model = model
  }

  /** 构造一个 chunk 外壳。 */
  private chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
  }

  /**
   * 编码一个核心块。
   * @param chunk - 核心流式块。
   * @returns 需要写出的 SSE 帧；不需要输出时为空数组。
   */
  push(chunk: ChatChunk): string[] {
    switch (chunk.type) {
      case 'block-start':
        // OpenAI 客户端期望第一个 delta 带 role。
        if (this.roleSent) return []
        this.roleSent = true
        return [sseData(this.chunk({ role: 'assistant', content: '' }, null))]
      case 'text-delta':
        if (chunk.text.length === 0) return []
        return [sseData(this.chunk({ content: chunk.text }, null))]
      case 'reasoning-delta':
        if (chunk.text.length === 0) return []
        // reasoning_content 是 DeepSeek/OpenRouter 等客户端广泛识别的扩展字段。
        return [sseData(this.chunk({ reasoning_content: chunk.text }, null))]
      case 'tool-call-delta': {
        let toolIndex = this.toolIndexes.get(chunk.id)
        const first = toolIndex === undefined
        if (toolIndex === undefined) {
          toolIndex = this.toolIndexes.size
          this.toolIndexes.set(chunk.id, toolIndex)
        }
        return [sseData(this.chunk({
          tool_calls: [{
            index: toolIndex,
            ...first ? { id: chunk.id, type: 'function' } : {},
            function: {
              ...first && chunk.name !== undefined ? { name: chunk.name } : {},
              ...chunk.argumentsDelta.length === 0 ? {} : { arguments: chunk.argumentsDelta },
            },
          }],
        }, null))]
      }
      case 'usage':
        this.usage = chunk.usage
        return []
      case 'finish': {
        const failure = finishFailure(chunk.reason)
        if (failure !== undefined) {
          // 流已经打开，只能把错误作为一条 SSE 数据发出。
          return [sseData({
            error: {
              message: failure.message,
              type: 'api_error',
              code: failure.code,
            },
          }), sseData('[DONE]')]
        }
        return [sseData(this.chunk({}, openAIFinishReason(chunk.reason)))]
      }
      default:
        return []
    }
  }

  /**
   * 结束流：按需补 finish 帧、usage 帧与 `[DONE]`。
   * @param includeUsage - 是否输出 usage（`stream_options.include_usage`）。
   */
  end(includeUsage: boolean, finished: boolean): string[] {
    const frames: string[] = []
    if (!finished) {
      frames.push(sseData(this.chunk({}, 'stop')))
    }
    const usage = openAIUsage(this.usage)
    if (includeUsage && usage !== undefined) {
      frames.push(sseData({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage,
      }))
    }
    frames.push(sseData('[DONE]'))
    return frames
  }
}

/**
 * 构造非流式 OpenAI 响应。
 * @param model - 实际使用的模型。
 * @param response - 聚合后的核心响应。
 */
export function openAICompletion(
  model: string,
  response: CollectedResponse,
): Record<string, unknown> {
  const text = response.blocks
    .filter((block): block is Extract<ChatContentBlockResult, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const reasoning = response.blocks
    .filter((block): block is Extract<ChatContentBlockResult, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = response.blocks
    .filter((block): block is Extract<ChatContentBlockResult, { type: 'tool-call' }> => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
  const usage = openAIUsage(response.usage)
  return {
    id: newId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
      },
      finish_reason: openAIFinishReason(response.finish),
    }],
    ...usage === undefined ? {} : { usage },
  }
}

/**
 * 聚合一次核心流并构造非流式响应；结束原因是错误时抛出。
 * @param model - 实际使用的模型。
 * @param chunks - 核心流。
 */
export async function openAICompletionFromStream(
  model: string,
  chunks: AsyncIterable<ChatChunk>,
): Promise<Record<string, unknown>> {
  const response = await collectResponse(chunks)
  const failure = finishFailure(response.finish)
  if (failure !== undefined) {
    throw new HttpError(failure.status ?? 502, failure.message, failure.code)
  }
  return openAICompletion(model, response)
}
