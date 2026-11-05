/**
 * 网关服务：把核心客户端、账号存储、模型发现、用量查询和登录流程组装起来。
 *
 * 这一层不依赖插件框架，只处理通用业务；HTTP 路由在 `server.ts`，协议转换在
 * `openai.ts` / `anthropic.ts`。
 *
 * @module kiro-nest/gateway/service
 */

import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { KiroAccountStore } from '../accounts.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../auth.ts'
import type { KiroToken } from '../auth.ts'
import { KiroClient, DEFAULT_MODELS, contextCapacity } from '../client.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from '../connection.ts'
import { discoverKiroProfileArn, KiroModelDiscovery } from '../discovery.ts'
import type { ManagedCredentials, RefreshTokenOrigin } from '../login.ts'
import {
  credentialSummary,
  deleteDeviceCredentials,
  importApiKey,
  importExternalIdp,
  importRefreshToken,
  pollDeviceLogin,
  pollSocialDeviceLogin,
  saveManagedCredentials,
  startDeviceLogin,
  startSocialDeviceLogin,
  syncManagedCredentialFile,
} from '../login.ts'
import { FileModelSettingsStore, modelSelection, modelSettingsPath } from '../model-settings.ts'
import { assertKiroProfileArn } from '../profile.ts'
import { assertKiroRegion } from '../region.ts'
import { getJson, parseProxyUrl, postForm, postJson } from '../transport.ts'
import { KiroUsageService } from '../usage.ts'
import type { KiroUsage } from '../usage.ts'
import { credentialDirectory } from './paths.ts'
import { mergeConfig, publicConfig, saveConfig } from './config.ts'
import type { GatewayConfig, GatewayConfigPatch, PublicGatewayConfig } from './config.ts'

/** 登录流程的公开状态。 */
export interface LoginFlow {
  status: 'pending' | 'complete' | 'error'
  kind: 'device' | 'social-device'
  method: string
  /** 本次登录替换的账号；缺省表示新增。 */
  accountId?: string
  /** 新账号的显示名；缺省由存储层生成。 */
  label?: string
  authUrl?: string
  userCode?: string
  startedAt: number
  completedAt?: number
  error?: string
}

/** 模型目录的公开视图。 */
export interface ModelPayload {
  source: 'live' | 'configured'
  fetchedAt: number
  enabledModelIds: readonly string[]
  models: readonly (Omit<KiroCatalogModel, 'inputModalities'> & {
    name: string
    enabled: boolean
    contextWindow?: number
    reasoningEfforts: string[]
    thinking: boolean
  })[]
}

/** 账号状态快照。 */
export interface GatewayStatus {
  authenticated: boolean
  credentialSource: 'gateway' | 'kiro' | 'none'
  authMethod?: string
  region?: string
  expiresAt?: string
  profileArn?: string
  accounts: unknown
  activeAccountId: string | null
  contextWindowCap: number | null
  login: Record<string, unknown>
  models: ModelPayload
  usage?: KiroUsage
  gateway: {
    apiKeyConfigured: boolean
    adminTokenConfigured: boolean
    endpoints: { openai: string; anthropic: string }
  }
}

/** 账号目标。 */
interface AccountTarget {
  accountId?: string
  label?: string
}

/** 安全化错误文本：去掉可能的凭据。 */
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/(?:access|refresh|client|api)[_-]?(?:token|secret|key)\s*[:=]\s*\S+/giu, '[redacted credential]')
    .replace(/aorAAAAAG[A-Za-z0-9._~-]+/gu, '[redacted refresh token]')
}

/** 把可选字符串字段规范成 `undefined`。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 必填字符串字段。 */
function requiredText(value: unknown, name: string): string {
  const result = optionalText(value)
  if (result === undefined) throw new Error(`${name} is required`)
  return result
}

/** 窄化导入请求声明的凭据来源。 */
function refreshTokenOrigin(value: unknown): RefreshTokenOrigin | undefined {
  const named = optionalText(value)
  if (named === undefined) return undefined
  if (named === 'builder-id' || named === 'idc' || named === 'imported') return named
  throw new Error(`Unsupported Kiro refresh-token credential source "${named}"`)
}

/** 读出一个登录或导入请求指向的账号。 */
function accountTarget(source: { accountId?: unknown; label?: unknown }): AccountTarget {
  const accountId = optionalText(source.accountId)
  const label = optionalText(source.label)
  return {
    ...accountId === undefined ? {} : { accountId },
    ...label === undefined ? {} : { label },
  }
}

/** 删除一个被移除账号独占的设备注册文件。 */
async function dropRegistration(directory: string, credential: Record<string, unknown>): Promise<void> {
  const hash = credential['clientIdHash']
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) return
  if (await new KiroAccountStore(directory).usesRegistration(hash)) return
  try {
    await unlink(join(directory, hash + '.json'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** 登录流程的公开视图。 */
function publicLogin(flow: LoginFlow | undefined): Record<string, unknown> {
  if (flow === undefined) return { status: 'idle' }
  return {
    status: flow.status,
    kind: flow.kind,
    method: flow.method,
    startedAt: flow.startedAt,
    ...flow.completedAt === undefined ? {} : { completedAt: flow.completedAt },
    ...flow.authUrl === undefined ? {} : { authUrl: flow.authUrl },
    ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
    ...flow.accountId === undefined ? {} : { accountId: flow.accountId },
    ...flow.error === undefined ? {} : { error: flow.error },
  }
}

/** 网关运行时的核心依赖。 */
export class GatewayService {
  readonly credentialDirectory: string
  readonly modelSettings: FileModelSettingsStore
  readonly discovery: KiroModelDiscovery
  readonly usage: KiroUsageService
  readonly client: KiroClient
  private config: GatewayConfig
  private login: LoginFlow | undefined
  private loginController: AbortController | undefined

  constructor(config: GatewayConfig) {
    this.config = config
    this.credentialDirectory = credentialDirectory(config.dataDir)
    this.modelSettings = new FileModelSettingsStore(modelSettingsPath(this.credentialDirectory))
    this.discovery = new KiroModelDiscovery({
      resolveToken: (connection, signal) => this.resolveToken(connection, signal),
    })
    this.usage = new KiroUsageService({
      resolveToken: (connection, signal) => this.resolveToken(connection, signal),
    })
    this.client = new KiroClient({
      options: () => this.connection(),
      resolveToken: (connection, signal) => this.resolveToken(connection, signal),
      discoverModels: async (connection, signal) => {
        try {
          const models = await this.discovery.list(connection, signal)
          await this.modelSettings.mergeCatalog(models)
          return models
        } catch {
          return connection.models
        }
      },
      currentModels: connection => this.discovery.current(connection),
      selectModels: models => this.modelSettings.enabledModels(models),
      userAgent: 'kiro-nest',
    })
  }

  /** 当前配置。 */
  get currentConfig(): GatewayConfig {
    return this.config
  }

  /** 关停仍在等待的登录。 */
  close(): void {
    this.loginController?.abort('gateway shutting down')
    this.loginController = undefined
  }

  /** 当前连接事实。 */
  connection(): KiroConnectionOptions {
    const config = this.config
    if (config.proxyUrl.length > 0) parseProxyUrl(config.proxyUrl)
    const region = config.region.length > 0 ? assertKiroRegion(config.region) : undefined
    const profileArn = config.profileArn.length > 0 ? assertKiroProfileArn(config.profileArn) : undefined
    return {
      ...region === undefined ? {} : { region },
      ...config.proxyUrl.length === 0 ? {} : { proxyUrl: config.proxyUrl },
      ...profileArn === undefined ? {} : { profileArn },
      defaults: {
        thinking: config.thinking,
        ...config.reasoningEffort.length === 0 ? {} : { reasoningEffort: config.reasoningEffort },
      },
      defaultContextWindow: config.defaultContextWindow,
      ...config.maxContextWindow === null ? {} : { maxContextWindow: config.maxContextWindow },
      models: DEFAULT_MODELS,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      tokenExpiryBufferMs: config.tokenExpiryBufferMs,
    }
  }

  /** 解析一次请求可用的令牌。 */
  private resolveToken(connection: KiroConnectionOptions, signal: AbortSignal): Promise<KiroToken> {
    return resolveTokenFromDirectories([this.credentialDirectory, kiroCredentialDirectory()], {
      expiryBufferMs: connection.tokenExpiryBufferMs,
      fetchJson: (url, body) => postJson(url, body, connection.proxyUrl, signal),
      fetchForm: (url, body) => postForm(url, body, connection.proxyUrl, signal),
      ...connection.profileArn === undefined
        ? {
            resolveProfileArn: (accessToken, region, authMethod) => discoverKiroProfileArn(
              connection,
              { accessToken, region, authMethod, expiresAt: Date.now() + 60_000 },
              signal,
            ),
          }
        : {},
      writableDirectories: [this.credentialDirectory],
    })
  }

  /** 模型目录的公开视图。 */
  async modelPayload(): Promise<ModelPayload> {
    const connection = this.connection()
    const cached = this.discovery.current(connection)
    const models = cached ?? connection.models
    const selection = await modelSelection(this.modelSettings, models)
    return {
      source: cached === undefined ? 'configured' : 'live',
      fetchedAt: Date.now(),
      enabledModelIds: selection.enabledModelIds,
      models: selection.models.map(model => ({
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.contextWindow === undefined
          ? {}
          : { contextWindow: contextCapacity(model.contextWindow, connection) },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        thinking: model.thinking ?? true,
        reasoningEfforts: model.reasoningEfforts
          ?? (model.thinking === false ? ['off'] : ['off', 'low', 'medium', 'high']),
        ...model.defaultReasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort: model.defaultReasoningEffort },
        ...model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities },
        enabled: model.enabled,
      })),
    }
  }

  /** 汇总状态，供页面与管理 API 读取。 */
  async status(): Promise<GatewayStatus> {
    const managed = await credentialSummary(this.credentialDirectory)
    const external = managed.authenticated
      ? { authenticated: false as const, authMethod: undefined, region: undefined, expiresAt: undefined, profileArn: undefined }
      : await credentialSummary(kiroCredentialDirectory())
    const connection = this.connection()
    const accounts = await new KiroAccountStore(this.credentialDirectory).snapshot()
    const usage = this.usage.current(connection)
    const authMethod = managed.authMethod ?? external.authMethod
    const region = managed.region ?? external.region ?? connection.region
    const expiresAt = managed.expiresAt ?? external.expiresAt
    const profileArn = connection.profileArn ?? managed.profileArn ?? external.profileArn
    return {
      authenticated: managed.authenticated || external.authenticated,
      credentialSource: managed.authenticated ? 'gateway' : external.authenticated ? 'kiro' : 'none',
      ...authMethod === undefined ? {} : { authMethod },
      ...region === undefined ? {} : { region },
      ...expiresAt === undefined ? {} : { expiresAt },
      ...profileArn === undefined ? {} : { profileArn },
      accounts,
      activeAccountId: accounts.activeAccountId,
      contextWindowCap: connection.maxContextWindow ?? null,
      login: publicLogin(this.login),
      models: await this.modelPayload(),
      ...usage === undefined ? {} : { usage },
      gateway: {
        apiKeyConfigured: this.config.apiKey.length > 0,
        adminTokenConfigured: this.config.adminToken.length > 0,
        endpoints: { openai: '/v1', anthropic: '/anthropic' },
      },
    }
  }

  /** 强制刷新模型目录。 */
  async refreshModels(): Promise<ModelPayload> {
    const connection = this.connection()
    const models = await this.discovery.list(connection, AbortSignal.timeout(20_000), true)
    await this.modelSettings.mergeCatalog(models)
    return this.modelPayload()
  }

  /** 保存启用模型列表。 */
  async setEnabledModels(ids: readonly string[]): Promise<ModelPayload> {
    const connection = this.connection()
    const models = this.discovery.current(connection) ?? connection.models
    await this.modelSettings.setEnabledModelIds(ids, models)
    return this.modelPayload()
  }

  /** 读取用量；`force` 绕过五分钟缓存。 */
  async getUsage(force: boolean): Promise<KiroUsage> {
    return this.usage.get(this.connection(), AbortSignal.timeout(20_000), force)
  }

  /** 当前配置的脱敏视图。 */
  currentPublicConfig(): PublicGatewayConfig {
    return publicConfig(this.config)
  }

  /**
   * 保存配置补丁。端口/监听地址的变更由服务器层决定是否重启。
   * @param patch - 页面提交的字段子集。
   * @returns 脱敏后的新配置。
   */
  async updateConfig(patch: GatewayConfigPatch): Promise<PublicGatewayConfig> {
    const next = mergeConfig(this.config, patch)
    await saveConfig(next)
    this.config = next
    this.discovery.clear()
    this.usage.clear()
    return publicConfig(next)
  }

  /**
   * 把一次登录或导入得到的凭据写入账号存储。
   * @param credentials - 登录流程产出的凭据。
   * @param signal - 请求取消信号。
   * @param target - 要更新的账号，或新账号的显示名。
   */
  private async saveCredentials(
    credentials: ManagedCredentials,
    signal: AbortSignal,
    target: AccountTarget = {},
  ): Promise<{ accountId: string }> {
    let complete = credentials
    if (credentials.profileArn === undefined && credentials.authMethod !== 'api_key') {
      try {
        const profileArn = await discoverKiroProfileArn(
          this.connection(),
          {
            accessToken: credentials.accessToken,
            region: credentials.region,
            expiresAt: Date.parse(credentials.expiresAt),
            authMethod: credentials.authMethod,
          },
          signal,
        )
        if (profileArn !== undefined) complete = { ...credentials, profileArn }
      } catch {
        // Profile discovery is best effort; the credential still works without it.
      }
    }
    const saved = await saveManagedCredentials(this.credentialDirectory, complete, target)
    this.discovery.clear()
    this.usage.clear()
    // 登录/导入完成后在后台拉取该账号的模型目录；失败不影响凭据保存，
    // 页面仍可手动点击“从 Kiro 刷新”。
    void this.refreshModels().catch(() => {})
    return saved
  }

  /**
   * 轮询设备码登录，直到完成、失败或取消。
   * @param initialIntervalSeconds - 首次轮询间隔。
   * @param flow - 正在发布的登录流程。
   * @param controller - 取消控制器。
   * @param poll - 单次轮询函数。
   */
  private monitorLogin(
    initialIntervalSeconds: number,
    flow: LoginFlow,
    controller: AbortController,
    poll: () => Promise<
      | { status: 'pending'; intervalSeconds: number }
      | { status: 'completed'; credentials: ManagedCredentials }
    >,
  ): void {
    void (async () => {
      let intervalSeconds = initialIntervalSeconds
      try {
        while (!controller.signal.aborted) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              clearTimeout(timer)
              reject(new Error('Kiro login cancelled'))
            }
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort)
              resolve()
            }, intervalSeconds * 1000)
            controller.signal.addEventListener('abort', onAbort, { once: true })
          })
          const result = await poll()
          if (result.status === 'pending') {
            intervalSeconds = result.intervalSeconds
            continue
          }
          const saved = await this.saveCredentials(result.credentials, controller.signal, {
            ...flow.accountId === undefined ? {} : { accountId: flow.accountId },
            ...flow.label === undefined ? {} : { label: flow.label },
          })
          this.login = {
            status: 'complete',
            kind: flow.kind,
            method: flow.method,
            ...flow.authUrl === undefined ? {} : { authUrl: flow.authUrl },
            ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
            startedAt: flow.startedAt,
            completedAt: Date.now(),
            accountId: saved.accountId,
          }
          return
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        this.login = {
          ...flow,
          status: 'error',
          completedAt: Date.now(),
          error: safeError(error),
        }
      }
    })()
  }

  /**
   * 启动 Builder ID / IAM Identity Center 设备码登录。
   * @param body - 页面提交的登录参数。
   * @returns 当前的登录流程状态。
   */
  async startDeviceLogin(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    this.loginController = controller
    if (body.method !== 'builder-id' && body.method !== 'idc') {
      throw new Error('Unsupported Kiro device login method')
    }
    const method = body.method
    const target = accountTarget(body)
    const connection = this.connection()
    const region = optionalText(body.region) ?? connection.region ?? 'us-east-1'
    const requestJson = (url: string, value: unknown, signal: AbortSignal) =>
      postJson(url, value, connection.proxyUrl, signal)
    const session = await startDeviceLogin(region, requestJson, controller.signal, {
      authMethod: method,
      ...method === 'idc'
        ? { startUrl: requiredText(body.startUrl, 'IAM Identity Center start URL') }
        : {},
    })
    const flow: LoginFlow = {
      status: 'pending',
      kind: 'device',
      method,
      authUrl: session.verificationUri,
      userCode: session.userCode,
      startedAt: Date.now(),
      ...target,
    }
    this.login = flow
    this.monitorLogin(
      session.intervalSeconds,
      flow,
      controller,
      () => pollDeviceLogin(session, requestJson, controller.signal),
    )
    return publicLogin(this.login)
  }

  /**
   * 启动 Google / GitHub 社交设备码登录。
   * @param method - 身份提供商。
   * @param target - 要更新的账号，或新账号的显示名。
   */
  async startSocialLogin(
    method: 'google' | 'github',
    target: AccountTarget = {},
  ): Promise<Record<string, unknown>> {
    this.loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    this.loginController = controller
    const connection = this.connection()
    const requestJson = (url: string, value: unknown, signal: AbortSignal) =>
      postJson(url, value, connection.proxyUrl, signal)
    const session = await startSocialDeviceLogin(method, requestJson, controller.signal)
    const flow: LoginFlow = {
      status: 'pending',
      kind: 'social-device',
      method,
      authUrl: session.verificationUri,
      userCode: session.userCode,
      startedAt: Date.now(),
      ...target,
    }
    this.login = flow
    this.monitorLogin(
      session.intervalSeconds,
      flow,
      controller,
      () => pollSocialDeviceLogin(session, requestJson, controller.signal),
    )
    return publicLogin(this.login)
  }

  /**
   * 按 `method` 分派一次登录。
   * @param body - 页面提交的登录参数。
   */
  async startLogin(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const method = optionalText(body.method) ?? 'builder-id'
    return method === 'google' || method === 'github'
      ? this.startSocialLogin(method, accountTarget(body))
      : this.startDeviceLogin({ ...body, method })
  }

  /** 取消正在进行的登录。 */
  cancelLogin(): void {
    this.loginController?.abort('Kiro login cancelled')
    this.loginController = undefined
    this.login = undefined
  }

  /**
   * 导入已有凭据（refresh token / API key / Microsoft external IdP）。
   * @param body - 页面提交的导入参数。
   * @returns 状态快照，附带本次导入实际验证的结果。
   */
  async importCredential(body: Record<string, unknown>): Promise<GatewayStatus | (GatewayStatus & { verified: { models?: number; refreshed?: true } })> {
    this.loginController?.abort('importing Kiro credentials')
    this.loginController = undefined
    const connection = this.connection()
    const signal = AbortSignal.timeout(30_000)
    const method = requiredText(body.method, 'Kiro import method')
    let credentials: ManagedCredentials
    let verified: { models?: number; refreshed?: true } | undefined
    if (method === 'refresh-token') {
      const region = optionalText(body.region) ?? connection.region
      const profileArn = optionalText(body.profileArn)
      const clientId = optionalText(body.clientId)
      const clientSecret = optionalText(body.clientSecret)
      const startUrl = optionalText(body.startUrl)
      const origin = refreshTokenOrigin(body.credentialSource ?? body.authMethod)
      credentials = await importRefreshToken(
        {
          refreshToken: requiredText(body.refreshToken, 'Kiro refresh token'),
          ...region === undefined ? {} : { region },
          ...profileArn === undefined ? {} : { profileArn },
          ...clientId === undefined ? {} : { clientId },
          ...clientSecret === undefined ? {} : { clientSecret },
          ...startUrl === undefined ? {} : { startUrl },
          ...origin === undefined ? {} : { authMethod: origin },
        },
        (url, value, requestSignal) => postJson(url, value, connection.proxyUrl, requestSignal),
        signal,
      )
      // 换取真实 access token 成功本身就是验证。
      verified = { refreshed: true }
    } else if (method === 'api-key') {
      const checked = await importApiKey(
        requiredText(body.apiKey, 'Kiro API key'),
        optionalText(body.region) ?? connection.region,
        (url, headers, requestSignal) => getJson(url, headers, connection.proxyUrl, requestSignal),
        signal,
      )
      credentials = checked.credentials
      verified = { models: checked.models }
    } else if (method === 'external-idp') {
      credentials = importExternalIdp(body.credentials)
    } else {
      throw new Error('Unsupported Kiro import method')
    }
    await this.saveCredentials(credentials, signal, accountTarget(body))
    this.login = undefined
    const current = await this.status()
    // external-IdP JSON 只做了本地整形，没有在线验证，因此不宣称已验证。
    return verified === undefined ? current : { ...current, verified }
  }

  /** 退出所有由网关管理的账号。 */
  async logout(): Promise<GatewayStatus> {
    this.loginController?.abort('Kiro logout')
    this.login = undefined
    await deleteDeviceCredentials(this.credentialDirectory)
    this.discovery.clear()
    this.usage.clear()
    return this.status()
  }

  /**
   * 切换请求使用的账号。
   * @param accountId - 目标账号。
   * @param revision - 页面读取到的文档版本，用于冲突检测。
   */
  async activateAccount(accountId: string, revision?: number): Promise<GatewayStatus> {
    await new KiroAccountStore(this.credentialDirectory).activate(accountId, revision)
    await syncManagedCredentialFile(this.credentialDirectory)
    this.discovery.clear()
    this.usage.clear()
    return this.status()
  }

  /**
   * 移除一个账号。
   * @param accountId - 目标账号。
   * @param options - 替代账号与版本保护。
   */
  async removeAccount(
    accountId: string,
    options: { replacementId?: string; revision?: number } = {},
  ) : Promise<GatewayStatus> {
    const removed = await new KiroAccountStore(this.credentialDirectory).remove(accountId, {
      ...options.replacementId === undefined ? {} : { replacementId: options.replacementId },
      ...options.revision === undefined ? {} : { expectedRevision: options.revision },
    })
    await dropRegistration(this.credentialDirectory, removed.credential)
    await syncManagedCredentialFile(this.credentialDirectory)
    this.discovery.clear()
    this.usage.clear()
    return this.status()
  }
}
