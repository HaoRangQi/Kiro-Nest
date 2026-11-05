/**
 * 网关独立进程入口。
 *
 * 用法：
 * ```bash
 * node lib/gateway/main.js --data-dir ./data
 * KIRO_NEST_PORT=8787 node lib/gateway/main.js
 * ```
 *
 * 监听端口与地址来自配置（环境变量优先）。页面保存新端口后可调用
 * `POST /api/restart` 让进程原地切换监听，无需重启容器。
 *
 * @module kiro-nest/gateway/main
 */

import { mkdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { loadConfig, resolveDataDir } from './config.ts'
import type { GatewayConfig } from './config.ts'
import { createGatewayServer } from './server.ts'
import { GatewayService } from './service.ts'

/** 读取 `--name value` 或 `--name=value` 形式的命令行参数。 */
function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const next = process.argv[index + 1]
  if (index >= 0 && next !== undefined && !next.startsWith('--')) return next
  const prefix = `${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  return inline === undefined ? undefined : inline.slice(prefix.length)
}

/** 打印一条带前缀的日志。 */
function log(message: string): void {
  console.log(`[kiro-nest] ${message}`)
}

/** 错误信息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const dataDir = resolveDataDir(flagValue('--data-dir'))
await mkdir(dataDir, { recursive: true, mode: 0o700 })

const config = await loadConfig(dataDir)
const service = new GatewayService(config)
let listening: { port: number; host: string } | undefined
let closing = false

const server = createGatewayServer(service, { restart })

/**
 * 在配置指定的地址上开始监听。
 * @param target - 端口与地址来源。
 */
async function listen(target: GatewayConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(target.port, target.host)
  })
  const address = server.address() as AddressInfo | string | null
  const port = typeof address === 'object' && address !== null ? address.port : target.port
  listening = { port, host: target.host }
  const shown = target.host === '0.0.0.0' || target.host === '::' ? 'localhost' : target.host
  log(`listening on http://${shown}:${port}`)
  log(`OpenAI-compatible endpoint:    http://${shown}:${port}/v1`)
  log(`Anthropic-compatible endpoint: http://${shown}:${port}/anthropic`)
  log(`settings page:                 http://${shown}:${port}/`)
}

/** 停止监听；先等现有请求结束，超时后强制断开。 */
async function stopListening(): Promise<void> {
  await new Promise<void>((resolve) => {
    // 定时器必须在 close 完成时取消，否则重启后的新连接会被误断开。
    const forceTimer = setTimeout(() => server.closeAllConnections(), 2_000)
    forceTimer.unref()
    server.close(() => {
      clearTimeout(forceTimer)
      resolve()
    })
    server.closeIdleConnections()
  })
}

/** 页面修改端口后原地重启监听；失败时回退到上一个端口。 */
async function restart(): Promise<void> {
  if (closing) return
  const previous = listening
  const next = service.currentConfig
  log(`restarting listener on ${next.host}:${next.port} ...`)
  await stopListening()
  try {
    await listen(next)
    return
  } catch (error: unknown) {
    log(`cannot listen on ${next.host}:${next.port}: ${messageOf(error)}`)
  }
  if (previous === undefined) {
    process.exitCode = 1
    return
  }
  try {
    await service.updateConfig({ port: previous.port, host: previous.host })
  } catch (error: unknown) {
    log(`cannot restore previous configuration: ${messageOf(error)}`)
  }
  await listen({ ...next, port: previous.port, host: previous.host })
  log('kept the previous port; update the port setting and restart the container later')
}

/** 优雅退出。 */
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  log(`received ${signal}, shutting down`)
  service.close()
  await stopListening()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
server.on('error', (error: Error) => {
  log(`server error: ${messageOf(error)}`)
})

log(`data directory: ${dataDir}`)
try {
  await listen(config)
} catch (error: unknown) {
  log(`cannot start gateway: ${messageOf(error)}`)
  process.exit(1)
}
