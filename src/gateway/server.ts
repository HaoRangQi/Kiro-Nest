/**
 * 网关 HTTP 服务器。
 *
 * 对外暴露两条模型协议：
 * - OpenAI：`GET /v1/models`、`POST /v1/chat/completions`
 * - Anthropic：`GET /anthropic/v1/models`、`POST /anthropic/v1/messages`
 *   以及 Claude Code 默认使用的 `POST /v1/messages`
 *
 * 管理 API 挂在 `/api/*`，静态配置页面挂在 `/`。
 *
 * @module kiro-nest/gateway/server
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatChunk, ChatRequest } from '../chat.ts'
import type { KiroCatalogModel } from '../connection.ts'
import {
  anthropicErrorBody,
  collectResponse,
  HttpError,
  openAIErrorBody,
  readJson,
  sendJson,
  sendText,
  sseData,
  statusForError,
  writeSseHead,
  finishFailure,
} from './http.ts'
import {
  anthropicMessage,
  AnthropicStreamEncoder,
  anthropicModelList,
  toAnthropicChatRequest,
} from './anthropic.ts'
import {
  openAICompletion,
  OpenAIStreamEncoder,
  toChatRequest,
} from './openai.ts'
import type { GatewayService } from './service.ts'

/** 服务器可选依赖。 */
export interface GatewayServerOptions {
  /** 静态页面目录；缺省使用项目根的 `web/`。 */
  webDir?: string
  /** 配置中端口/地址变更后由入口提供的重启动作。 */
  restart?: () => Promise<void>
}

/** 管理 API 成功响应。 */
function ok(value: unknown): { ok: true; value: unknown } {
  return { ok: true, value }
}

/** 从请求头或查询参数读取令牌。 */
function presentedToken(request: IncomingMessage, url: URL): string | undefined {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim()
  }
  const apiKey = request.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) return apiKey.trim()
  const admin = request.headers['x-admin-token']
  if (typeof admin === 'string' && admin.trim().length > 0) return admin.trim()
  const query = url.searchParams.get('token')
  return query === null || query.length === 0 ? undefined : query
}

/** 恒定时间比较，避免通过响应时间猜测令牌。 */
function secureEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/** 判断模型端点是否通过鉴权。 */
function modelAuthorized(request: IncomingMessage, url: URL, expected: string): boolean {
  if (expected.length === 0) return true
  const token = presentedToken(request, url)
  return token !== undefined && secureEqual(token, expected)
}

/** 判断管理端点是否通过鉴权；`/api/health` 永远公开。 */
function adminAuthorized(request: IncomingMessage, url: URL, expected: string): boolean {
  if (expected.length === 0) return true
  const token = presentedToken(request, url)
  return token !== undefined && secureEqual(token, expected)
}

/** 发送管理 API 错误。 */
function sendAdminError(response: ServerResponse, error: unknown): void {
  sendJson(response, statusForError(error), {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })
}

/** 默认静态目录：源码运行时是 `src/gateway`，构建后是 `lib/gateway`。 */
function defaultWebDir(): string {
  return resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web'))
}

/** 静态资源的 Content-Type。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * 返回静态文件，拒绝越出 web 目录的路径。
 * @param response - 响应对象。
 * @param webDir - 静态目录。
 * @param pathname - 请求路径。
 */
async function serveStatic(response: ServerResponse, webDir: string, pathname: string): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/u, '')
  if (relative.length === 0 || relative.startsWith('..') || relative.includes(`..${sep}`)) {
    sendText(response, 400, 'Bad path')
    return
  }
  const root = resolve(webDir)
  const file = resolve(root, relative)
  if (file !== root && !file.startsWith(root + sep)) {
    sendText(response, 400, 'Bad path')
    return
  }
  let body: Buffer
  try {
    body = await readFile(file)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') {
      // 未知前端路由回退到入口页。
      if (extname(relative).length === 0) {
        await serveStatic(response, root, '/')
        return
      }
      sendText(response, 404, 'Not found')
      return
    }
    throw error
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

/** 读取的模型列表，失败时退回家目录。 */
async function listModels(service: GatewayService): Promise<readonly KiroCatalogModel[]> {
  try {
    return await service.client.listModels(AbortSignal.timeout(15_000))
  } catch {
    return service.connection().models
  }
}

/** 向 SSE 响应写一帧；连接已断开时返回 false。 */
function writeFrame(response: ServerResponse, frame: string): boolean {
  if (response.writableEnded || response.destroyed) return false
  return response.write(frame)
}

/**
 * 处理 OpenAI 流式补全。
 * @param service - 网关服务。
 * @param request - 核心请求。
 * @param includeUsage - 是否输出 usage。
 * @param response - HTTP 响应。
 * @param signal - 客户端断开信号。
 */
async function streamOpenAI(
  service: GatewayService,
  request: ChatRequest,
  includeUsage: boolean,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const iterator = service.client.stream({ ...request, signal })[Symbol.asyncIterator]()
  let first: IteratorResult<ChatChunk>
  try {
    first = await iterator.next()
  } catch (error: unknown) {
    sendJson(response, statusForError(error), openAIErrorBody(error))
    return
  }
  writeSseHead(response)
  const encoder = new OpenAIStreamEncoder(request.model)
  let finished = false
  let failed = false
  try {
    if (!first.done) {
      if (first.value.type === 'finish') finished = true
      for (const frame of encoder.push(first.value)) {
        if (!writeFrame(response, frame)) return
      }
    }
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === 'finish') finished = true
      for (const frame of encoder.push(next.value)) {
        if (!writeFrame(response, frame)) return
      }
    }
  } catch (error: unknown) {
    failed = true
    if (writeFrame(response, sseData(openAIErrorBody(error)))) {
      writeFrame(response, sseData('[DONE]'))
    }
  } finally {
    if (!failed && !response.destroyed) {
      for (const frame of encoder.end(includeUsage, finished)) writeFrame(response, frame)
    }
    if (!response.destroyed) response.end()
  }
}

/**
 * 处理 Anthropic 流式消息。
 * @param service - 网关服务。
 * @param request - 核心请求。
 * @param response - HTTP 响应。
 * @param signal - 客户端断开信号。
 */
async function streamAnthropic(
  service: GatewayService,
  request: ChatRequest,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const iterator = service.client.stream({ ...request, signal })[Symbol.asyncIterator]()
  let first: IteratorResult<ChatChunk>
  try {
    first = await iterator.next()
  } catch (error: unknown) {
    sendJson(response, statusForError(error), anthropicErrorBody(error))
    return
  }
  writeSseHead(response)
  const encoder = new AnthropicStreamEncoder(request.model)
  for (const frame of encoder.start()) {
    if (!writeFrame(response, frame)) return
  }
  let failed = false
  try {
    if (!first.done) {
      for (const frame of encoder.push(first.value)) {
        if (!writeFrame(response, frame)) return
      }
    }
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      for (const frame of encoder.push(next.value)) {
        if (!writeFrame(response, frame)) return
      }
    }
  } catch (error: unknown) {
    failed = true
    const body = anthropicErrorBody(error)
    writeFrame(response, `event: error\ndata: ${JSON.stringify(body)}\n\n`)
  } finally {
    if (!failed && !response.destroyed) {
      for (const frame of encoder.end()) writeFrame(response, frame)
    }
    if (!response.destroyed) response.end()
  }
}

/**
 * 创建网关 HTTP 服务器。
 * @param service - 网关服务。
 * @param options - 静态目录与重启回调。
 * @returns 未监听的 Node HTTP server。
 */
export function createGatewayServer(service: GatewayService, options: GatewayServerOptions = {}): Server {
  const webDir = options.webDir ?? defaultWebDir()

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end()
        return
      }
      const status = statusForError(error)
      const path = (request.url ?? '/').split('?')[0] ?? '/'
      if (path === '/v1/messages' || path.startsWith('/anthropic')) {
        sendJson(response, status, anthropicErrorBody(error))
      } else if (path.startsWith('/v1/')) {
        sendJson(response, status, openAIErrorBody(error))
      } else {
        sendJson(response, status, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 客户端提前断开时，写入可能触发 error；避免它变成未捕获异常。
    response.on('error', () => {})
    const url = new URL(request.url ?? '/', 'http://gateway.local')
    const path = url.pathname
    const method = request.method ?? 'GET'
    const config = service.currentConfig

    // 浏览器预检与模型端点的 CORS：网关常被浏览器里的客户端直接调用。
    if (method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, x-admin-token, x-session-id, anthropic-version, anthropic-beta',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      response.end()
      return
    }
    response.setHeader('access-control-allow-origin', '*')

    if (path === '/api/health' && method === 'GET') {
      sendJson(response, 200, ok({
        status: 'ok',
        version: 1,
        authenticated: (await service.status()).authenticated,
      }))
      return
    }

    if (path.startsWith('/api/')) {
      if (!adminAuthorized(request, url, config.adminToken)) {
        sendJson(response, 401, { ok: false, error: 'Unauthorized' })
        return
      }
      await handleAdmin(request, response, url)
      return
    }

    if (path === '/v1/models' && method === 'GET') {
      if (!modelAuthorized(request, url, config.apiKey)) {
        sendJson(response, 401, openAIErrorBody(new HttpError(401, 'Unauthorized', 'authentication_error')))
        return
      }
      const models = await listModels(service)
      sendJson(response, 200, {
        object: 'list',
        data: models.map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'kiro',
          ...model.name === undefined ? {} : { name: model.name },
          ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
          ...model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens },
          ...model.inputModalities === undefined ? {} : { input_modalities: model.inputModalities },
          ...model.reasoningEfforts === undefined ? {} : { reasoning_efforts: model.reasoningEfforts },
        })),
      })
      return
    }

    if (path === '/v1/chat/completions' && method === 'POST') {
      if (!modelAuthorized(request, url, config.apiKey)) {
        sendJson(response, 401, openAIErrorBody(new HttpError(401, 'Unauthorized', 'authentication_error')))
        return
      }
      const body = await readJson(request)
      const models = await listModels(service)
      const sessionId = typeof request.headers['x-session-id'] === 'string'
        ? request.headers['x-session-id']
        : undefined
      const chatRequest = toChatRequest(body, {
        defaultModel: config.defaultModel,
        models,
        ...sessionId === undefined ? {} : { sessionId },
      })
      const controller = new AbortController()
      response.on('close', () => {
        if (!response.writableEnded) controller.abort('client disconnected')
      })
      chatRequest.signal = controller.signal
      if (body['stream'] === true) {
        const streamOptions = typeof body['stream_options'] === 'object' && body['stream_options'] !== null
          ? body['stream_options'] as Record<string, unknown>
          : undefined
        await streamOpenAI(service, chatRequest, streamOptions?.['include_usage'] === true, response, controller.signal)
        return
      }
      const result = await service.client.stream(chatRequest)
      const collected = await collectResponse(result)
      const failure = finishFailure(collected.finish)
      if (failure !== undefined) {
        throw new HttpError(failure.status ?? 502, failure.message, failure.code)
      }
      sendJson(response, 200, openAICompletion(chatRequest.model, collected))
      return
    }

    if ((path === '/anthropic/v1/models' || path === '/v1/models/anthropic') && method === 'GET') {
      if (!modelAuthorized(request, url, config.apiKey)) {
        sendJson(response, 401, anthropicErrorBody(new HttpError(401, 'Unauthorized')))
        return
      }
      sendJson(response, 200, anthropicModelList(await listModels(service)))
      return
    }

    if ((path === '/anthropic/v1/messages' || path === '/v1/messages') && method === 'POST') {
      if (!modelAuthorized(request, url, config.apiKey)) {
        sendJson(response, 401, anthropicErrorBody(new HttpError(401, 'Unauthorized')))
        return
      }
      const body = await readJson(request)
      const models = await listModels(service)
      const effort = typeof request.headers['x-kiro-reasoning-effort'] === 'string'
        ? request.headers['x-kiro-reasoning-effort']
        : undefined
      const chatRequest = toAnthropicChatRequest(body, {
        defaultModel: config.defaultModel,
        models,
        ...effort === undefined ? {} : { reasoningEffort: effort },
      })
      const controller = new AbortController()
      response.on('close', () => {
        if (!response.writableEnded) controller.abort('client disconnected')
      })
      chatRequest.signal = controller.signal
      if (body['stream'] === true) {
        await streamAnthropic(service, chatRequest, response, controller.signal)
        return
      }
      const collected = await collectResponse(service.client.stream(chatRequest))
      const failure = finishFailure(collected.finish)
      if (failure !== undefined) {
        throw new HttpError(failure.status ?? 502, failure.message, failure.code)
      }
      sendJson(response, 200, anthropicMessage(chatRequest.model, collected))
      return
    }

    if (path.startsWith('/api/')) {
      sendJson(response, 404, { ok: false, error: 'not-found' })
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      await serveStatic(response, webDir, path)
      return
    }
    sendText(response, 405, 'Method not allowed')
  }

  /** 管理 API 路由。 */
  async function handleAdmin(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const path = url.pathname.replace(/^\/api\/?/u, '')
    const method = request.method ?? 'GET'
    try {
      if (path === 'status' && method === 'GET') {
        sendJson(response, 200, ok(await service.status()))
        return
      }
      if (path === 'config' && method === 'GET') {
        sendJson(response, 200, ok(service.currentPublicConfig()))
        return
      }
      if (path === 'config' && (method === 'POST' || method === 'PUT')) {
        const before = service.currentConfig
        const body = await readJson(request)
        const next = await service.updateConfig(body)
        const restartRequired = next.port !== before.port || next.host !== before.host
        sendJson(response, 200, ok({ config: next, restartRequired }))
        return
      }
      if (path === 'restart' && method === 'POST') {
        if (options.restart === undefined) {
          sendJson(response, 400, { ok: false, error: 'This process cannot restart itself' })
          return
        }
        sendJson(response, 200, ok({ restarting: true }))
        // 给响应一个刷出的机会，再关闭监听。
        setTimeout(() => { void options.restart?.() }, 100)
        return
      }
      if (path === 'context' && method === 'POST') {
        const body = await readJson(request)
        const raw = body['maxContextWindow']
        if (raw !== null && raw !== undefined
          && (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)) {
          throw new HttpError(400, 'maxContextWindow must be a positive integer or null')
        }
        await service.updateConfig({ maxContextWindow: typeof raw === 'number' ? raw : null })
        sendJson(response, 200, ok(await service.status()))
        return
      }
      if (path === 'login' && method === 'POST') {
        sendJson(response, 200, ok(await service.startLogin(await readJson(request))))
        return
      }
      if (path === 'login/cancel' && method === 'POST') {
        service.cancelLogin()
        sendJson(response, 200, ok(await service.status()))
        return
      }
      if (path === 'credentials/import' && method === 'POST') {
        sendJson(response, 200, ok(await service.importCredential(await readJson(request))))
        return
      }
      if (path === 'logout' && method === 'POST') {
        sendJson(response, 200, ok(await service.logout()))
        return
      }
      if (path === 'accounts' && method === 'GET') {
        sendJson(response, 200, ok((await service.status()).accounts))
        return
      }
      if (path === 'accounts/activate' && method === 'POST') {
        const body = await readJson(request)
        const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : ''
        if (accountId.length === 0) throw new HttpError(400, 'accountId is required')
        const revision = typeof body['revision'] === 'number' ? body['revision'] : undefined
        sendJson(response, 200, ok(await service.activateAccount(accountId, revision)))
        return
      }
      if (path === 'accounts/remove' && method === 'POST') {
        const body = await readJson(request)
        const accountId = typeof body['accountId'] === 'string' ? body['accountId'] : ''
        if (accountId.length === 0) throw new HttpError(400, 'accountId is required')
        sendJson(response, 200, ok(await service.removeAccount(accountId, {
          ...typeof body['replacementId'] === 'string' ? { replacementId: body['replacementId'] } : {},
          ...typeof body['revision'] === 'number' ? { revision: body['revision'] } : {},
        })))
        return
      }
      if (path === 'models' && method === 'GET') {
        sendJson(response, 200, ok(await service.modelPayload()))
        return
      }
      if (path === 'models' && method === 'POST') {
        const body = await readJson(request)
        const ids = body['enabledModelIds']
        if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
          throw new HttpError(400, 'enabledModelIds must be an array of strings')
        }
        sendJson(response, 200, ok(await service.setEnabledModels(ids)))
        return
      }
      if (path === 'models/refresh' && method === 'POST') {
        sendJson(response, 200, ok(await service.refreshModels()))
        return
      }
      if (path === 'usage' && (method === 'GET' || method === 'POST')) {
        sendJson(response, 200, ok(await service.getUsage(method === 'POST')))
        return
      }
      sendJson(response, 404, { ok: false, error: 'not-found' })
    } catch (error: unknown) {
      sendAdminError(response, error)
    }
  }
}
