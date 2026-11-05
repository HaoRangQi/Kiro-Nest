/**
 * 网关配置：持久化到 `<dataDir>/config.json`，环境变量优先。
 *
 * 配置按请求读取，因此页面修改代理、区域、默认模型等会立即生效；
 * 端口与监听地址的修改需要重启监听，由服务器层负责。
 *
 * @module kiro-nest/gateway/config
 */

import { mkdir, chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 网关的完整配置。 */
export interface GatewayConfig {
  /** HTTP 监听端口。 */
  port: number
  /** HTTP 监听地址；`0.0.0.0` 允许容器外访问。 */
  host: string
  /** 模型 API 的访问密钥；空字符串表示不鉴权。 */
  apiKey: string
  /** 管理 API 的访问密钥；空字符串表示不鉴权。 */
  adminToken: string
  /** Kiro 请求的出站代理，例如 `http://user:pass@host:8080`。 */
  proxyUrl: string
  /** 强制使用的 AWS 区域；空字符串跟随令牌。 */
  region: string
  /** 强制使用的 CodeWhisperer profile ARN；空字符串使用账号默认。 */
  profileArn: string
  /** `/v1/chat/completions` 未指定模型时使用的模型。 */
  defaultModel: string
  /** 覆盖所有模型的推理强度；空字符串跟随模型默认。 */
  reasoningEffort: string
  /** 部署级思考策略。 */
  thinking: 'enabled' | 'disabled'
  /** 上下文上限；`null` 表示跟随各模型。 */
  maxContextWindow: number | null
  /** 模型没有精确值时的上下文容量。 */
  defaultContextWindow: number
  /** 单次流式读取允许的最长空闲时间。 */
  streamIdleTimeoutMs: number
  /** 访问令牌提前刷新的时间窗口。 */
  tokenExpiryBufferMs: number
  /** 数据目录；仅启动时读取，页面不可修改。 */
  dataDir: string
}

/** 页面可读的配置视图：密钥只报告是否已设置。 */
export interface PublicGatewayConfig {
  port: number
  host: string
  apiKeyConfigured: boolean
  adminTokenConfigured: boolean
  dataDir: string
  proxyUrl: string
  region: string
  profileArn: string
  defaultModel: string
  reasoningEffort: string
  thinking: 'enabled' | 'disabled'
  maxContextWindow: number | null
  defaultContextWindow: number
  streamIdleTimeoutMs: number
  tokenExpiryBufferMs: number
}

/** 页面提交的配置补丁。密钥字段缺省表示保持不变，空字符串表示清除。 */
export interface GatewayConfigPatch {
  port?: number
  host?: string
  apiKey?: string
  adminToken?: string
  proxyUrl?: string
  region?: string
  profileArn?: string
  defaultModel?: string
  reasoningEffort?: string
  thinking?: 'enabled' | 'disabled'
  maxContextWindow?: number | null
  defaultContextWindow?: number
  streamIdleTimeoutMs?: number
  tokenExpiryBufferMs?: number
}

/** 配置文件名。 */
const CONFIG_FILE = 'config.json'
/** 默认监听端口。 */
export const DEFAULT_PORT = 8787
/** 默认监听地址。 */
export const DEFAULT_HOST = '0.0.0.0'
/** 默认上下文容量。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** 默认流空闲超时。 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** 默认令牌提前刷新窗口。 */
const DEFAULT_TOKEN_EXPIRY_BUFFER_MS = 300_000

/**
 * 解析数据目录。
 * @param value - 显式传入的目录，或环境变量。
 * @returns 绝对路径。
 */
export function resolveDataDir(value?: string): string {
  const selected = value
    ?? process.env['KIRO_NEST_DATA_DIR']
    ?? process.env['DATA_DIR']
    ?? join(process.cwd(), 'data')
  return resolve(selected)
}

/** 读取一个可选的正整数环境变量。 */
function envInteger(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/** 读取一个可选的字符串环境变量。 */
function envString(name: string): string | undefined {
  const raw = process.env[name]
  return raw === undefined ? undefined : raw.trim()
}

/** 默认配置。 */
function defaults(dataDir: string): GatewayConfig {
  return {
    port: envInteger('KIRO_NEST_PORT') ?? envInteger('PORT') ?? DEFAULT_PORT,
    host: envString('KIRO_NEST_HOST') ?? DEFAULT_HOST,
    apiKey: envString('KIRO_NEST_API_KEY') ?? '',
    adminToken: envString('KIRO_NEST_ADMIN_TOKEN') ?? '',
    proxyUrl: envString('KIRO_NEST_PROXY_URL') ?? envString('KIRO_PROXY_URL') ?? '',
    region: envString('KIRO_NEST_REGION') ?? envString('KIRO_REGION') ?? '',
    profileArn: envString('KIRO_NEST_PROFILE_ARN') ?? '',
    defaultModel: envString('KIRO_NEST_DEFAULT_MODEL') ?? '',
    reasoningEffort: envString('KIRO_NEST_REASONING_EFFORT') ?? '',
    thinking: envString('KIRO_NEST_THINKING') === 'disabled' ? 'disabled' : 'enabled',
    maxContextWindow: envInteger('KIRO_NEST_MAX_CONTEXT_WINDOW') ?? null,
    defaultContextWindow: envInteger('KIRO_NEST_DEFAULT_CONTEXT_WINDOW') ?? DEFAULT_CONTEXT_WINDOW,
    streamIdleTimeoutMs: envInteger('KIRO_NEST_STREAM_IDLE_TIMEOUT_MS') ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    tokenExpiryBufferMs: envInteger('KIRO_NEST_TOKEN_EXPIRY_BUFFER_MS') ?? DEFAULT_TOKEN_EXPIRY_BUFFER_MS,
    dataDir,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, name: string, max = 4096): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (value.length > max) throw new Error(`${name} is too long`)
  return value.trim()
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/**
 * 校验并合并一个配置补丁。
 * @param current - 当前配置。
 * @param patch - 页面提交的补丁。
 * @returns 合并后的配置。
 * @throws 当字段类型或范围不合法时。
 */
export function mergeConfig(current: GatewayConfig, patch: GatewayConfigPatch): GatewayConfig {
  const port = boundedInteger(patch.port, 'port', 1, 65_535) ?? current.port
  const host = boundedString(patch.host, 'host', 255) ?? current.host
  if (host.length === 0) throw new Error('host is required')
  const apiKey = boundedString(patch.apiKey, 'apiKey', 512) ?? current.apiKey
  const adminToken = boundedString(patch.adminToken, 'adminToken', 512) ?? current.adminToken
  const proxyUrl = boundedString(patch.proxyUrl, 'proxyUrl') ?? current.proxyUrl
  const region = boundedString(patch.region, 'region', 64) ?? current.region
  const profileArn = boundedString(patch.profileArn, 'profileArn', 2048) ?? current.profileArn
  const defaultModel = boundedString(patch.defaultModel, 'defaultModel', 256) ?? current.defaultModel
  const reasoningEffort = boundedString(patch.reasoningEffort, 'reasoningEffort', 32) ?? current.reasoningEffort
  const thinking = patch.thinking ?? current.thinking
  if (thinking !== 'enabled' && thinking !== 'disabled') throw new Error('thinking must be enabled or disabled')
  let maxContextWindow = current.maxContextWindow
  if (patch.maxContextWindow !== undefined) {
    maxContextWindow = patch.maxContextWindow === null
      ? null
      : boundedInteger(patch.maxContextWindow, 'maxContextWindow', 1, 10_000_000) ?? null
  }
  const defaultContextWindow = boundedInteger(patch.defaultContextWindow, 'defaultContextWindow', 1, 10_000_000)
    ?? current.defaultContextWindow
  const streamIdleTimeoutMs = boundedInteger(patch.streamIdleTimeoutMs, 'streamIdleTimeoutMs', 1_000, 3_600_000)
    ?? current.streamIdleTimeoutMs
  const tokenExpiryBufferMs = boundedInteger(patch.tokenExpiryBufferMs, 'tokenExpiryBufferMs', 0, 3_600_000)
    ?? current.tokenExpiryBufferMs
  return {
    port,
    host,
    apiKey,
    adminToken,
    proxyUrl,
    region,
    profileArn,
    defaultModel,
    reasoningEffort,
    thinking,
    maxContextWindow,
    defaultContextWindow,
    streamIdleTimeoutMs,
    tokenExpiryBufferMs,
    dataDir: current.dataDir,
  }
}

/** 配置文件的绝对路径。 */
export function configPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE)
}

/**
 * 读取配置：文件中的值覆盖默认值，环境变量优先于文件。
 * @param dataDir - 数据目录。
 * @returns 校验后的配置。
 */
export async function loadConfig(dataDir: string): Promise<GatewayConfig> {
  const base = defaults(dataDir)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath(dataDir), 'utf8')) as unknown
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read gateway config at ${configPath(dataDir)}`, { cause: error })
    }
    return base
  }
  if (!isRecord(raw)) throw new Error('Gateway config must be a JSON object')
  const merged = mergeConfig(base, raw as GatewayConfigPatch)
  // 环境变量始终优先：容器部署时便于用编排系统覆盖镜像内配置。
  return {
    ...merged,
    port: envInteger('KIRO_NEST_PORT') ?? envInteger('PORT') ?? merged.port,
    host: envString('KIRO_NEST_HOST') ?? merged.host,
    apiKey: envString('KIRO_NEST_API_KEY') ?? merged.apiKey,
    adminToken: envString('KIRO_NEST_ADMIN_TOKEN') ?? merged.adminToken,
    proxyUrl: envString('KIRO_NEST_PROXY_URL') ?? merged.proxyUrl,
    region: envString('KIRO_NEST_REGION') ?? merged.region,
    profileArn: envString('KIRO_NEST_PROFILE_ARN') ?? merged.profileArn,
    defaultModel: envString('KIRO_NEST_DEFAULT_MODEL') ?? merged.defaultModel,
    reasoningEffort: envString('KIRO_NEST_REASONING_EFFORT') ?? merged.reasoningEffort,
    thinking: envString('KIRO_NEST_THINKING') === 'disabled' ? 'disabled' : merged.thinking,
    maxContextWindow: envInteger('KIRO_NEST_MAX_CONTEXT_WINDOW') ?? merged.maxContextWindow,
    defaultContextWindow: envInteger('KIRO_NEST_DEFAULT_CONTEXT_WINDOW') ?? merged.defaultContextWindow,
    streamIdleTimeoutMs: envInteger('KIRO_NEST_STREAM_IDLE_TIMEOUT_MS') ?? merged.streamIdleTimeoutMs,
    tokenExpiryBufferMs: envInteger('KIRO_NEST_TOKEN_EXPIRY_BUFFER_MS') ?? merged.tokenExpiryBufferMs,
  }
}

/**
 * 原子写入配置，权限仅所有者可读写。
 * @param config - 完整配置。
 */
export async function saveConfig(config: GatewayConfig): Promise<void> {
  const path = configPath(config.dataDir)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${String(process.pid)}.tmp`
  const { dataDir: _dataDir, ...persisted } = config
  await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/**
 * 转成页面可读的视图。
 * @param config - 完整配置。
 * @returns 密钥脱敏后的配置。
 */
export function publicConfig(config: GatewayConfig): PublicGatewayConfig {
  return {
    port: config.port,
    host: config.host,
    apiKeyConfigured: config.apiKey.length > 0,
    adminTokenConfigured: config.adminToken.length > 0,
    dataDir: config.dataDir,
    proxyUrl: config.proxyUrl,
    region: config.region,
    profileArn: config.profileArn,
    defaultModel: config.defaultModel,
    reasoningEffort: config.reasoningEffort,
    thinking: config.thinking,
    maxContextWindow: config.maxContextWindow,
    defaultContextWindow: config.defaultContextWindow,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    tokenExpiryBufferMs: config.tokenExpiryBufferMs,
  }
}
