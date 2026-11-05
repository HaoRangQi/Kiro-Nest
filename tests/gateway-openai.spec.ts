import { describe, expect, it } from 'vitest'
import type { ChatChunk } from '../src/chat.ts'
import type { KiroCatalogModel } from '../src/connection.ts'
import {
  openAICompletion,
  OpenAIStreamEncoder,
  openAIFinishReason,
  selectModel,
  toChatRequest,
} from '../src/gateway/openai.ts'
import { collectResponse, HttpError } from '../src/gateway/http.ts'

const MODELS: KiroCatalogModel[] = [
  { id: 'claude-sonnet-4.5', name: 'Sonnet 4.5' },
  { id: 'claude-opus-4.5', name: 'Opus 4.5' },
]

/** 解析 `data:` 帧为 JSON；`[DONE]` 保留为字符串。 */
function parseFrames(frames: readonly string[]): (Record<string, unknown> | string)[] {
  return frames
    .flatMap(frame => frame.split('\n\n'))
    .filter(block => block.trim().length > 0)
    .map((block) => {
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .join('\n')
      return data === '[DONE]' ? data : JSON.parse(data) as Record<string, unknown>
    })
}

describe('toChatRequest', () => {
  it('把 OpenAI 消息与采样参数映射到核心请求', () => {
    const request = toChatRequest({
      model: 'claude-opus-4.5',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      max_completion_tokens: 512,
      reasoning_effort: 'high',
      stop: 'END',
      user: 'session-1',
    }, { defaultModel: '', models: MODELS })

    expect(request.model).toBe('claude-opus-4.5')
    expect(request.system).toBe('be brief')
    expect(request.maxTokens).toBe(512)
    expect(request.reasoningEffort).toBe('high')
    expect(request.stop).toEqual(['END'])
    expect(request.sessionId).toBe('session-1')
    expect(request.tools).toEqual([
      { name: 'lookup', description: '', parameters: { type: 'object' } },
    ])
    expect(request.messages).toHaveLength(3)
    expect(request.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })
    expect(request.messages[2]).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'result' }],
    })
  })

  it('只有 system 消息时拒绝请求', () => {
    expect(() => toChatRequest({
      messages: [{ role: 'system', content: 'only instructions' }],
    }, { defaultModel: '', models: MODELS })).toThrow(HttpError)
  })

  it('接受 base64 图片并拒绝远程 URL', () => {
    const request = toChatRequest({
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AAAA' },
        }],
      }],
    }, { defaultModel: '', models: MODELS })
    expect(request.messages[0]?.content).toEqual([
      { type: 'image', image: { mediaType: 'image/png', data: 'AAAA' } },
    ])
    expect(() => toChatRequest({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }],
    }, { defaultModel: '', models: MODELS })).toThrow(HttpError)
  })

  it('默认模型按配置、目录顺序回退', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    expect(selectModel(body, { defaultModel: 'claude-opus-4.5', models: MODELS })).toBe('claude-opus-4.5')
    expect(selectModel(body, { defaultModel: '', models: MODELS })).toBe('claude-sonnet-4.5')
    expect(selectModel(body, { defaultModel: '', models: [] })).toBe('auto')
  })
})

describe('OpenAIStreamEncoder', () => {
  it('输出 role、文本、结束原因与 [DONE]', () => {
    const encoder = new OpenAIStreamEncoder('claude-sonnet-4.5')
    const frames = [
      ...encoder.push({ type: 'block-start', index: 0, blockType: 'text' }),
      ...encoder.push({ type: 'text-delta', index: 0, text: '你好' }),
      ...encoder.push({ type: 'block-end', index: 0, block: { type: 'text', text: '你好' } }),
      ...encoder.push({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }),
      ...encoder.push({ type: 'finish', reason: { kind: 'stop' } }),
      ...encoder.end(true, true),
    ]
    const parsed = parseFrames(frames)
    const chunks = parsed.filter((item): item is Record<string, unknown> => typeof item === 'object')

    expect((chunks[0]?.choices as any)[0].delta).toEqual({ role: 'assistant', content: '' })
    expect((chunks[1]?.choices as any)[0].delta).toEqual({ content: '你好' })
    expect((chunks[2]?.choices as any)[0].finish_reason).toBe('stop')
    expect(chunks[3]?.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    })
    expect(parsed.at(-1)).toBe('[DONE]')
  })

  it('把工具调用编码成增量 tool_calls', () => {
    const encoder = new OpenAIStreamEncoder('m')
    const frames = [
      ...encoder.push({ type: 'block-start', index: 0, blockType: 'tool-call' }),
      ...encoder.push({
        type: 'tool-call-delta',
        index: 0,
        id: 'call_1',
        name: 'lookup',
        argumentsDelta: '{"q":',
      }),
      ...encoder.push({
        type: 'tool-call-delta',
        index: 0,
        id: 'call_1',
        argumentsDelta: '"x"}',
      }),
      ...encoder.push({ type: 'finish', reason: { kind: 'tool-calls' } }),
      ...encoder.end(false, true),
    ]
    const chunks = parseFrames(frames)
      .filter((item): item is Record<string, unknown> => typeof item === 'object')
    // 第一帧是 role 增量，之后才是工具调用增量。
    const toolChunks = chunks.filter(chunk =>
      (chunk.choices as any)[0]?.delta?.tool_calls !== undefined)
    const first = (toolChunks[0]?.choices as any)[0].delta.tool_calls[0]
    const second = (toolChunks[1]?.choices as any)[0].delta.tool_calls[0]
    expect(first).toMatchObject({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":' },
    })
    expect(second).toEqual({ index: 0, function: { arguments: '"x"}' } })
    const finish = chunks.find(chunk =>
      (chunk.choices as any)[0]?.finish_reason !== null
      && (chunk.choices as any)[0]?.finish_reason !== undefined)
    expect((finish?.choices as any)[0].finish_reason).toBe('tool_calls')
  })

  it('把上游错误写进流并结束', () => {
    const encoder = new OpenAIStreamEncoder('m')
    const frames = encoder.push({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'boom', code: 'QUOTA' } },
    })
    expect(frames.join('')).toContain('"code":"QUOTA"')
    expect(frames.join('')).toContain('[DONE]')
  })
})

describe('openAICompletion', () => {
  it('聚合文本、推理与工具调用', async () => {
    async function* stream(): AsyncGenerator<ChatChunk> {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'think' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: 'answer' }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } }
      yield { type: 'block-start', index: 2, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 2,
        id: 'call_9',
        name: 'lookup',
        argumentsDelta: '{"q":"x"}',
      }
      yield {
        type: 'block-end',
        index: 2,
        block: { type: 'tool-call', id: 'call_9', name: 'lookup', arguments: '{"q":"x"}' },
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    const collected = await collectResponse(stream())
    const payload = openAICompletion('m', collected)
    const message = (payload.choices as any)[0].message
    expect(message).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'think',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    })
    expect((payload.choices as any)[0].finish_reason).toBe('tool_calls')
    expect(payload.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  })

  it('映射结束原因', () => {
    expect(openAIFinishReason({ kind: 'stop' })).toBe('stop')
    expect(openAIFinishReason({ kind: 'max-tokens' })).toBe('length')
    expect(openAIFinishReason({ kind: 'tool-calls' })).toBe('tool_calls')
  })
})
