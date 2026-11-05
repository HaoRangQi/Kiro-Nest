import { describe, expect, it } from 'vitest'
import type { ChatChunk } from '../src/chat.ts'
import type { KiroCatalogModel } from '../src/connection.ts'
import {
  anthropicMessage,
  AnthropicStreamEncoder,
  anthropicModelList,
  anthropicStopReason,
  toAnthropicChatRequest,
} from '../src/gateway/anthropic.ts'
import { collectResponse, HttpError } from '../src/gateway/http.ts'

const MODELS: KiroCatalogModel[] = [{ id: 'claude-sonnet-4.5', name: 'Sonnet 4.5' }]

/** 解析 Anthropic 的 `event:`/`data:` 帧。 */
function parseEvents(frames: readonly string[]): { event: string; data: Record<string, unknown> }[] {
  return frames
    .flatMap(frame => frame.split('\n\n'))
    .filter(block => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find(line => line.startsWith('event: '))?.slice(7) ?? ''
      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

describe('toAnthropicChatRequest', () => {
  it('映射 system、消息块、工具与 thinking 预算', () => {
    const request = toAnthropicChatRequest({
      model: 'claude-sonnet-4.5',
      system: [{ type: 'text', text: 'be brief' }, { type: 'text', text: 'answer in Chinese' }],
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 8000 },
      stop_sequences: ['STOP'],
      tools: [{ name: 'lookup', description: 'search', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpg', data: 'AAAA' } },
            { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'found' }] },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
          ],
        },
      ],
    }, { defaultModel: '', models: MODELS })

    expect(request.model).toBe('claude-sonnet-4.5')
    expect(request.system).toBe('be brief\nanswer in Chinese')
    expect(request.maxTokens).toBe(1024)
    expect(request.reasoningEffort).toBe('medium')
    expect(request.stop).toEqual(['STOP'])
    expect(request.tools).toEqual([
      { name: 'lookup', description: 'search', parameters: { type: 'object' } },
    ])
    // 工具结果先作为 tool 消息，再是同一 user 消息里的文本与图片。
    expect(request.messages[0]).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'found' }],
    })
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', image: { mediaType: 'image/jpeg', data: 'AAAA' } },
      ],
    })
    expect(request.messages[2]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })
  })

  it('拒绝非 base64 图片', () => {
    expect(() => toAnthropicChatRequest({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
      }],
    }, { defaultModel: '', models: MODELS })).toThrow(HttpError)
  })

  it('thinking disabled 映射为 off', () => {
    const request = toAnthropicChatRequest({
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, { defaultModel: '', models: MODELS })
    expect(request.reasoningEffort).toBe('off')
  })
})

describe('AnthropicStreamEncoder', () => {
  it('产生完整的 message 生命周期与文本增量', () => {
    const encoder = new AnthropicStreamEncoder('claude-sonnet-4.5')
    const events = parseEvents([
      ...encoder.start(),
      ...encoder.push({ type: 'block-start', index: 0, blockType: 'text' }),
      ...encoder.push({ type: 'text-delta', index: 0, text: '你好' }),
      ...encoder.push({ type: 'block-end', index: 0, block: { type: 'text', text: '你好' } }),
      ...encoder.push({ type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }),
      ...encoder.push({ type: 'finish', reason: { kind: 'stop' } }),
      ...encoder.end(),
    ]).map(item => item.event)

    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  it('工具块在拿到名字后才打开，并以 input_json_delta 传输参数', () => {
    const encoder = new AnthropicStreamEncoder('m')
    const events = parseEvents([
      ...encoder.start(),
      ...encoder.push({ type: 'block-start', index: 0, blockType: 'tool-call' }),
      ...encoder.push({
        type: 'tool-call-delta',
        index: 0,
        id: 'call_1',
        name: 'lookup',
        argumentsDelta: '{"q":',
      }),
      ...encoder.push({ type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '"x"}' }),
      ...encoder.push({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      }),
      ...encoder.push({ type: 'finish', reason: { kind: 'tool-calls' } }),
      ...encoder.end(),
    ])
    const start = events.find(item => item.event === 'content_block_start')
    expect(start?.data).toMatchObject({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
    })
    const deltas = events.filter(item => item.event === 'content_block_delta')
    expect(deltas.map(item => item.data.delta)).toEqual([
      { type: 'input_json_delta', partial_json: '{"q":' },
      { type: 'input_json_delta', partial_json: '"x"}' },
    ])
    const messageDelta = events.find(item => item.event === 'message_delta')
    expect(messageDelta?.data.delta).toMatchObject({ stop_reason: 'tool_use' })
  })

  it('结束后补齐未关闭块', () => {
    const encoder = new AnthropicStreamEncoder('m')
    const events = parseEvents([
      ...encoder.start(),
      ...encoder.push({ type: 'block-start', index: 0, blockType: 'text' }),
      ...encoder.push({ type: 'text-delta', index: 0, text: 'partial' }),
      ...encoder.end(),
    ]).map(item => item.event)
    expect(events).toContain('content_block_stop')
    expect(events.at(-1)).toBe('message_stop')
  })
})

describe('Anthropic 响应', () => {
  it('聚合 content 块并映射 stop_reason', async () => {
    async function* stream(): AsyncGenerator<ChatChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hello' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: 'call_1',
        name: 'lookup',
        argumentsDelta: '{"q":"x"}',
      }
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    const payload = anthropicMessage('claude-sonnet-4.5', await collectResponse(stream()))
    expect(payload.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
    ])
    expect(payload.stop_reason).toBe('tool_use')
    expect(payload.usage).toEqual({ input_tokens: 7, output_tokens: 3 })
  })

  it('映射 stop reason 与模型列表', () => {
    expect(anthropicStopReason({ kind: 'tool-calls' })).toBe('tool_use')
    expect(anthropicStopReason({ kind: 'max-tokens' })).toBe('max_tokens')
    expect(anthropicStopReason({ kind: 'stop' })).toBe('end_turn')
    expect(anthropicModelList(MODELS)).toMatchObject({
      data: [{ type: 'model', id: 'claude-sonnet-4.5', display_name: 'Sonnet 4.5' }],
      has_more: false,
    })
  })
})
