/**
 * 网关的数据目录布局。
 *
 * 凭据目录保持与旧版 dsh-kiro 相同的 `storages/kiro-auth` 结构，这样用户可以直接把
 * `~/.dsh/storages/kiro-auth` 复制进挂载卷完成迁移。
 *
 * @module kiro-nest/gateway/paths
 */

import { join } from 'node:path'

/** 返回网关管理的凭据目录。 */
export function credentialDirectory(dataDir: string): string {
  return join(dataDir, 'storages', 'kiro-auth')
}
