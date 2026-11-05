import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatChunk, ChatRequest } from '../src/chat.ts'
import type { KiroCatalogModel } from '../src/connection.ts'
import type { GatewayConfig } from '../src/gateway/config.ts'
import { createGatewayServer } from '../src/gateway/server.ts'
import type { GatewayService } from '../src/gateway/service.ts'

const MODELS: KiroCatalogModel[] = [
  { id: 'claude-sonnet-4.5', name: 'Sonnet 4.5', contextWindow: 200_000 },
]

const CONFIG: GatewayConfig = {
  port: 0,
  host: '127.0.0.1',
  apiKey: '',
  adminToken: 'admin-secret',
  proxyUrl: '',
  region: '',
  profileArn: '',
  defaultModel: 'claude-sonnet-4.5',
  reasoningEffort: '',
  thinking: 'enabled',
  maxContextWindow: null,
  defaultContextWindow: 200_000,
  streamIdleTimeoutMs: 300_000,
  tokenExpiryBufferMs: 300_000,
  dataDir: '/tmp/kiro-nest-test',
}

/** 每次请求都返回同一段文本与用量。 */
async function* reply(request: ChatRequest): AsyncGenerator<ChatChunk> {
  expect(request.model).toBe('claude-sonnet-4.5')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'hello' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
  yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function modelPayload() {
  return {
    source: 'live' as const,
    fetchedAt: Date.now(),
    enabledModelIds: MODELS.map(model => model.id),
    models: MODELS.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      enabled: true,
      thinking: true,
      reasoningEfforts: ['off', 'low', 'medium', 'high'],
    })),
  }
}

const service = {
  currentConfig: CONFIG,
  connection: () => ({
    models: MODELS,
    defaults: {},
    defaultContextWindow: 200_000,
    streamIdleTimeoutMs: 300_000,
    tokenExpiryBufferMs: 300_000,
  }),
  client: {
    listModels: async () => MODELS,
    stream: (request: ChatRequest) => reply(request),
  },
  async status() {
    return {
      authenticated: true,
      credentialSource: 'gateway',
      accounts: { revision: 0, activeAccountId: null, accounts: [], migrated: false },
      activeAccountId: null,
      contextWindowCap: null,
      login: { status: 'idle' },
      models: await modelPayload(),
      gateway: {
        apiKeyConfigured: false,
        adminTokenConfigured: true,
        endpoints: { openai: '/v1', anthropic: '/anthropic' },
      },
    }
  },
  modelPayload,
  async updateConfig(patch: Partial<GatewayConfig>) {
    Object.assign(CONFIG, patch)
    return CONFIG
  },
  async setEnabledModels() {
    return modelPayload()
  },
  async refreshModels() {
    return modelPayload()
  },
  async getUsage() {
    return { plan: 'Pro', fetchedAt: Date.now(), rows: [] }
  },
  async startLogin() {
    return { status: 'pending' }
  },
  cancelLogin() {},
  async importCredential() {
    return service.status()
  },
  async logout() {
    return service.status()
  },
  async activateAccount() {
    return service.status()
  },
  async removeAccount() {
    return service.status()
  },
} as unknown as GatewayService

let server: Server
let base: string

beforeAll(async () => {
  server = createGatewayServer(service)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
})

describe('gateway HTTP', () => {
  it('提供健康检查与静态页面', async () => {
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Kiro-nest')
  })

  it('管理 API 需要管理令牌', async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401)
    const authorized = await fetch(`${base}/api/status`, {
      headers: { authorization: 'Bearer admin-secret' },
    })
    expect(authorized.status).toBe(200)
    const payload = await authorized.json() as any
    expect(payload.ok).toBe(true)
    expect(payload.value.authenticated).toBe(true)
  })

  it('OpenAI 模型列表与流式补全', async () => {
    const models = await fetch(`${base}/v1/models`)
    expect(models.status).toBe(200)
    const list = await models.json() as any
    expect(list.data[0]).toMatchObject({ id: 'claude-sonnet-4.5', object: 'model' })

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('"role":"assistant"')
    expect(body).toContain('"content":"hello"')
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain('"prompt_tokens":4')
    expect(body).toContain('[DONE]')
  })

  it('OpenAI 非流式补全', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as any
    expect(payload.object).toBe('chat.completion')
    expect(payload.choices[0].message.content).toBe('hello')
    expect(payload.usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 2 })
  })

  it('Anthropic 流式消息事件序列', async () => {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    for (const event of [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]) {
      expect(body).toContain(`event: ${event}`)
    }
    expect(body).toContain('"text":"hello"')
    expect(body).toContain('"output_tokens":2')
  })

  it('Anthropic 非流式消息', async () => {
    const response = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as any
    expect(payload.type).toBe('message')
    expect(payload.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(payload.stop_reason).toBe('end_turn')
  })

  it('非法请求返回对应协议的错误体', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as any
    expect(payload.error.type).toBe('invalid_request_error')
  })
})
