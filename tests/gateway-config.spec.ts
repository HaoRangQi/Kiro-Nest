import { describe, expect, it } from 'vitest'
import { mergeConfig, publicConfig } from '../src/gateway/config.ts'
import type { GatewayConfig } from '../src/gateway/config.ts'

const BASE: GatewayConfig = {
  port: 8787,
  host: '0.0.0.0',
  apiKey: 'secret-api-key',
  adminToken: 'secret-admin-token',
  proxyUrl: '',
  region: '',
  profileArn: '',
  defaultModel: '',
  reasoningEffort: '',
  thinking: 'enabled',
  maxContextWindow: null,
  defaultContextWindow: 200_000,
  streamIdleTimeoutMs: 300_000,
  tokenExpiryBufferMs: 300_000,
  dataDir: '/data',
}

describe('mergeConfig', () => {
  it('只覆盖补丁中出现的字段', () => {
    const merged = mergeConfig(BASE, { port: 9000, defaultModel: 'claude-sonnet-4.5' })
    expect(merged.port).toBe(9000)
    expect(merged.defaultModel).toBe('claude-sonnet-4.5')
    expect(merged.host).toBe('0.0.0.0')
    expect(merged.apiKey).toBe('secret-api-key')
    expect(merged.dataDir).toBe('/data')
  })

  it('空字符串可清除密钥', () => {
    const merged = mergeConfig(BASE, { apiKey: '', adminToken: '' })
    expect(merged.apiKey).toBe('')
    expect(merged.adminToken).toBe('')
  })

  it('null 表示清除上下文上限', () => {
    expect(mergeConfig({ ...BASE, maxContextWindow: 100_000 }, { maxContextWindow: null }).maxContextWindow)
      .toBeNull()
  })

  it('拒绝越界端口与非法思考策略', () => {
    expect(() => mergeConfig(BASE, { port: 0 })).toThrow()
    expect(() => mergeConfig(BASE, { port: 70_000 })).toThrow()
    expect(() => mergeConfig(BASE, { thinking: 'maybe' as 'enabled' })).toThrow()
  })

  it('保留未知字段之外的默认值', () => {
    const merged = mergeConfig(BASE, {})
    expect(merged).toEqual(BASE)
  })
})

describe('publicConfig', () => {
  it('不泄露密钥原文', () => {
    const value = publicConfig(BASE)
    expect(value.apiKeyConfigured).toBe(true)
    expect(value.adminTokenConfigured).toBe(true)
    expect(JSON.stringify(value)).not.toContain('secret-api-key')
    expect(JSON.stringify(value)).not.toContain('secret-admin-token')
  })

  it('未配置密钥时报告 false', () => {
    const value = publicConfig({ ...BASE, apiKey: '', adminToken: '' })
    expect(value.apiKeyConfigured).toBe(false)
    expect(value.adminTokenConfigured).toBe(false)
  })
})
