/**
 * Kiro-nest 配置页面。
 *
 * 纯原生模块，无构建步骤；通过 `/api/*` 管理账号、模型、用量与网关设置。
 * 所有动态文本使用 textContent 写入，避免把账号数据当成 HTML 执行。
 */

const TOKEN_KEY = 'kiro-nest-admin-token'

const state = {
  /** @type {any} */
  status: null,
  /** @type {any} */
  config: null,
  /** @type {any} */
  models: null,
  /** @type {any} */
  usage: null,
  /** @type {Set<string>} */
  enabledModelIds: new Set(),
  modelsDirty: false,
  /** @type {number | null} */
  loginTimer: null,
}

const $ = id => document.getElementById(id)

/** 创建元素。 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else {
      node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

/** 字符串化可选值。 */
function text(value) {
  return value === undefined || value === null || value === '' ? '' : String(value)
}

/** 格式化时间戳；非法值返回空串。 */
function formatTime(value) {
  if (value === undefined || value === null || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 短暂提示。 */
let toastTimer
function toast(message) {
  const node = $('toast')
  node.textContent = message
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, 3200)
}

/** 顶部错误条。 */
let errorTimer
function showError(error) {
  const node = $('error-banner')
  node.textContent = error instanceof Error ? error.message : String(error)
  node.hidden = false
  clearTimeout(errorTimer)
  errorTimer = setTimeout(() => { node.hidden = true }, 8000)
}

/** 管理 API 请求。 */
async function api(path, options = {}) {
  const headers = new Headers(options.headers)
  const token = localStorage.getItem(TOKEN_KEY) ?? ''
  if (token.length > 0) headers.set('authorization', `Bearer ${token}`)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`/api${path}`, { ...options, headers })
  const payload = await response.json().catch(() => null)
  if (response.status === 401) $('auth-banner').hidden = false
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`)
  }
  return payload?.value
}

/** 读取状态、配置与模型。 */
async function loadAll() {
  try {
    const [status, config] = await Promise.all([api('/status'), api('/config')])
    state.status = status
    state.config = config
    state.models = status.models
    if (!state.modelsDirty) {
      state.enabledModelIds = new Set(status.models?.enabledModelIds ?? [])
    }
    renderAuthBadge()
    renderAccounts()
    renderModels()
    renderConfig()
    renderEndpoints()
    renderUsage()
  } catch (error) {
    showError(error)
  }
}

/** 读取用量。 */
async function loadUsage(force = false) {
  try {
    state.usage = await api('/usage', force ? { method: 'POST' } : {})
  } catch {
    state.usage = null
  }
  renderUsage()
}

/** 登录状态徽章。 */
function renderAuthBadge() {
  const status = state.status
  const badge = $('auth-badge')
  if (status?.authenticated) {
    badge.textContent = status.credentialSource === 'kiro' ? '使用 Kiro CLI 凭据' : '已登录'
    badge.className = status.credentialSource === 'kiro' ? 'badge badge-warn' : 'badge badge-ok'
  } else if (status?.credentialSource === 'kiro') {
    badge.textContent = '使用 Kiro CLI 凭据'
    badge.className = 'badge badge-warn'
  } else {
    badge.textContent = '未登录'
    badge.className = 'badge badge-muted'
  }
}

/** 账号卡片。 */
function renderAccounts() {
  const status = state.status
  const snapshot = status?.accounts ?? {}
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : []
  const summary = $('account-summary')
  summary.replaceChildren()

  const sourceLabel = status?.credentialSource === 'gateway'
    ? '网关管理的账号'
    : status?.credentialSource === 'kiro'
      ? 'Kiro CLI 凭据（只读）'
      : '无凭据'
  summary.append(el('span', { text: `凭据来源：${sourceLabel}` }))
  if (status?.authMethod) summary.append(el('span', { text: `登录方式：${status.authMethod}` }))
  if (status?.region) summary.append(el('span', { text: `区域：${status.region}` }))
  if (status?.expiresAt) summary.append(el('span', { text: `令牌到期：${formatTime(status.expiresAt)}` }))

  const list = $('account-list')
  list.replaceChildren()
  if (accounts.length === 0) {
    list.append(el('div', { class: 'empty', text: '还没有账号。点击“添加账号”登录或导入凭据。' }))
    return
  }
  for (const account of accounts) {
    const statePill = account.state === 'ready'
      ? el('span', { class: 'pill pill-ready', text: '就绪' })
      : account.state === 'refresh-required'
        ? el('span', { class: 'pill pill-warn', text: '待刷新' })
        : el('span', { class: 'pill pill-bad', text: '不可用' })
    const meta = [
      text(account.authMethod),
      text(account.region),
      account.expiresAt ? `到期 ${formatTime(account.expiresAt)}` : '',
    ].filter(part => part.length > 0).join(' · ')

    const actions = el('div', { class: 'account-actions' })
    if (!account.active) {
      actions.append(el('button', {
        class: 'button button-small',
        type: 'button',
        'data-action': 'activate',
        'data-id': account.id,
        text: '设为当前',
      }))
    }
    actions.append(el('button', {
      class: 'button button-small button-danger',
      type: 'button',
      'data-action': 'remove',
      'data-id': account.id,
      text: '移除',
    }))

    list.append(el('div', { class: `account${account.active ? ' active' : ''}` },
      el('div', { class: 'account-main' },
        el('div', { class: 'account-title' },
          el('span', { text: account.label ?? account.id }),
          account.active ? el('span', { class: 'pill pill-active', text: '当前' }) : null,
          statePill,
        ),
        el('div', { class: 'account-meta', title: text(account.profileArn), text: meta }),
      ),
      actions,
    ))
  }
}

/** 用量卡片。 */
function renderUsage() {
  const rowsNode = $('usage-rows')
  const planNode = $('usage-plan')
  rowsNode.replaceChildren()
  const usage = state.usage
  if (!usage) {
    planNode.textContent = '暂无用量数据（未登录或接口不可用）'
    return
  }
  planNode.textContent = [
    text(usage.plan),
    usage.resetAt ? `重置 ${formatTime(usage.resetAt)}` : '',
  ].filter(part => part.length > 0).join(' · ')

  const rows = Array.isArray(usage.rows) ? usage.rows : []
  if (rows.length === 0) {
    rowsNode.append(el('div', { class: 'empty', text: 'Kiro 未返回可展示的额度。' }))
    return
  }
  for (const row of rows) {
    const percent = Math.min(100, Math.max(0, Number(row.usedPercent) || 0))
    const level = percent >= 90 ? ' danger' : percent >= 70 ? ' warn' : ''
    rowsNode.append(el('div', { class: 'usage-row' },
      el('div', { class: 'usage-head' },
        el('strong', { text: row.label ?? row.id }),
        el('span', {
          class: 'usage-meta',
          text: row.unlimited
            ? '无限制'
            : `${row.used} / ${row.limit}（${Math.round(percent)}%）`,
        }),
      ),
      el('div', { class: `progress${level}` },
        el('span', { style: `width:${row.unlimited ? 0 : percent}%` }),
      ),
      row.resetAt
        ? el('div', { class: 'usage-meta', text: `重置：${formatTime(row.resetAt)}` })
        : null,
    ))
  }
}

/** 模型卡片。 */
function renderModels() {
  const models = state.models
  const list = $('model-list')
  list.replaceChildren()
  $('models-source').textContent = models
    ? `${models.source === 'live' ? '来自 Kiro 实时目录' : '来自本地配置'} · ${formatTime(models.fetchedAt)}`
    : '—'

  const datalist = $('model-ids')
  datalist.replaceChildren()
  if (!models) return
  for (const model of models.models ?? []) {
    datalist.append(el('option', { value: model.id }))
    const checkbox = el('input', {
      type: 'checkbox',
      checked: state.enabledModelIds.has(model.id),
      onchange: event => {
        if (event.currentTarget.checked) state.enabledModelIds.add(model.id)
        else state.enabledModelIds.delete(model.id)
        state.modelsDirty = true
      },
    })
    const meta = [
      model.contextWindow ? `上下文 ${model.contextWindow.toLocaleString('en-US')}` : '',
      model.maxTokens ? `输出 ${model.maxTokens.toLocaleString('en-US')}` : '',
      Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
        ? `强度 ${model.reasoningEfforts.join('/')}`
        : '',
      model.thinking ? '支持思考' : '',
    ].filter(part => part.length > 0).join(' · ')

    list.append(el('label', { class: 'model' },
      checkbox,
      el('span', { class: 'model-main' },
        el('span', { class: 'model-name', text: model.name ?? model.id }),
        el('span', { class: 'model-meta', text: model.id }),
        meta.length > 0 ? el('span', { class: 'model-meta', text: meta }) : null,
      ),
    ))
  }
  if (list.childElementCount === 0) {
    list.append(el('div', { class: 'empty', text: '未发现模型；请先登录账号。' }))
  }
  const cap = $('context-cap')
  if (document.activeElement !== cap) {
    cap.value = state.config?.maxContextWindow ?? ''
  }
}

/** 设置表单。 */
function renderConfig() {
  const config = state.config
  if (!config) return
  $('cfg-port').value = config.port ?? ''
  $('cfg-host').value = config.host ?? ''
  $('cfg-proxy-url').value = config.proxyUrl ?? ''
  $('cfg-region').value = config.region ?? ''
  $('cfg-profile-arn').value = config.profileArn ?? ''
  $('cfg-default-model').value = config.defaultModel ?? ''
  $('cfg-reasoning-effort').value = config.reasoningEffort ?? ''
  $('cfg-thinking').value = config.thinking ?? 'enabled'
  $('cfg-default-context').value = config.defaultContextWindow ?? ''
  $('cfg-stream-idle').value = config.streamIdleTimeoutMs ?? ''
  $('cfg-token-buffer').value = config.tokenExpiryBufferMs ?? ''
  $('context-cap').value = config.maxContextWindow ?? ''

  const apiKeyInput = $('cfg-api-key')
  apiKeyInput.value = ''
  apiKeyInput.placeholder = config.apiKeyConfigured ? '已配置，留空保持不变' : '未配置'
  const adminInput = $('cfg-admin-token')
  adminInput.value = ''
  adminInput.placeholder = config.adminTokenConfigured ? '已配置，留空保持不变' : '未配置'
}

/** 接入信息。 */
function renderEndpoints() {
  const origin = `${location.protocol}//${location.host}`
  $('endpoint-openai').textContent = `${origin}/v1`
  $('endpoint-anthropic').textContent = `${origin}/anthropic`
  $('endpoint-data').textContent = state.config?.dataDir ?? '—'
}

/** 保存模型选择。 */
async function saveModels() {
  try {
    const payload = await api('/models', {
      method: 'POST',
      body: JSON.stringify({ enabledModelIds: [...state.enabledModelIds] }),
    })
    state.models = payload
    if (state.status) state.status.models = payload
    state.modelsDirty = false
    renderModels()
    toast('模型选择已保存')
  } catch (error) {
    showError(error)
  }
}

/** 从 Kiro 刷新模型。 */
async function refreshModels() {
  try {
    const payload = await api('/models/refresh', { method: 'POST' })
    state.models = payload
    if (state.status) state.status.models = payload
    state.enabledModelIds = new Set(payload.enabledModelIds ?? [])
    state.modelsDirty = false
    renderModels()
    toast('模型目录已刷新')
  } catch (error) {
    showError(error)
  }
}

/** 保存上下文上限。 */
async function saveContext() {
  const raw = $('context-cap').value.trim()
  const maxContextWindow = raw === '' ? null : Number(raw)
  if (maxContextWindow !== null && (!Number.isInteger(maxContextWindow) || maxContextWindow <= 0)) {
    showError(new Error('上下文上限必须是正整数或留空'))
    return
  }
  try {
    await api('/context', { method: 'POST', body: JSON.stringify({ maxContextWindow }) })
    toast('上下文上限已保存')
    await loadAll()
  } catch (error) {
    showError(error)
  }
}

/** 保存服务设置。 */
async function saveConfig() {
  const patch = {
    port: Number($('cfg-port').value),
    host: $('cfg-host').value.trim(),
    proxyUrl: $('cfg-proxy-url').value.trim(),
    region: $('cfg-region').value.trim(),
    profileArn: $('cfg-profile-arn').value.trim(),
    defaultModel: $('cfg-default-model').value.trim(),
    reasoningEffort: $('cfg-reasoning-effort').value,
    thinking: $('cfg-thinking').value,
    defaultContextWindow: Number($('cfg-default-context').value),
    streamIdleTimeoutMs: Number($('cfg-stream-idle').value),
    tokenExpiryBufferMs: Number($('cfg-token-buffer').value),
  }
  const apiKey = $('cfg-api-key').value
  if ($('cfg-clear-api-key').checked) patch.apiKey = ''
  else if (apiKey.length > 0) patch.apiKey = apiKey
  const adminToken = $('cfg-admin-token').value
  if ($('cfg-clear-admin-token').checked) patch.adminToken = ''
  else if (adminToken.length > 0) patch.adminToken = adminToken

  try {
    const result = await api('/config', { method: 'POST', body: JSON.stringify(patch) })
    state.config = result.config
    if (patch.adminToken !== undefined) {
      if (patch.adminToken === '') localStorage.removeItem(TOKEN_KEY)
      else localStorage.setItem(TOKEN_KEY, patch.adminToken)
    }
    $('cfg-clear-api-key').checked = false
    $('cfg-clear-admin-token').checked = false
    $('restart-row').hidden = result.restartRequired !== true
    toast(result.restartRequired ? '设置已保存，请重启监听' : '设置已保存')
    await loadAll()
  } catch (error) {
    showError(error)
  }
}

/** 等待新端口可用，然后跳转页面。 */
async function restartListener() {
  const port = Number($('cfg-port').value)
  const origin = `${location.protocol}//${location.hostname}:${port}`
  try {
    await api('/restart', { method: 'POST' })
  } catch (error) {
    showError(error)
    return
  }
  $('restart-row').hidden = true
  toast('正在重启监听…')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    try {
      const response = await fetch(`${origin}/api/health`, { cache: 'no-store' })
      if (response.ok) {
        location.href = `${origin}/`
        return
      }
    } catch {
      // 端口尚未恢复，继续等待。
    }
  }
  showError(new Error('监听重启超时，请查看容器日志'))
}

/** 显示登录流程状态。 */
function renderLoginPending(login) {
  const pending = $('login-pending')
  const textNode = $('login-pending-text')
  const device = $('login-device')
  const errorNode = $('login-error')
  if (!login || login.status === 'idle') {
    pending.hidden = true
    return
  }
  pending.hidden = false
  errorNode.hidden = true
  if (login.status === 'pending') {
    textNode.textContent = '等待浏览器授权…'
    device.hidden = false
    const link = $('login-auth-url')
    link.href = login.authUrl ?? '#'
    link.textContent = login.authUrl ?? '—'
    $('login-user-code').textContent = login.userCode ?? '—'
    $('submit-login').disabled = true
  } else if (login.status === 'complete') {
    textNode.textContent = '登录完成，账号已保存。'
    device.hidden = true
    $('submit-login').disabled = false
  } else {
    textNode.textContent = '登录失败。'
    device.hidden = true
    errorNode.textContent = login.error ?? '未知错误'
    errorNode.hidden = false
    $('submit-login').disabled = false
  }
}

/** 开始轮询登录状态。 */
function startLoginPolling() {
  stopLoginPolling()
  state.loginTimer = setInterval(async () => {
    try {
      const status = await api('/status')
      state.status = status
      renderAuthBadge()
      renderAccounts()
      const login = status.login
      if (!login || login.status === 'idle') {
        stopLoginPolling()
        return
      }
      renderLoginPending(login)
      if (login.status === 'complete') {
        stopLoginPolling()
        toast('账号登录成功')
        await loadAll()
        await loadUsage()
        // 服务端会在登录后后台刷新模型目录，稍后再读一次即可显示真实模型。
        setTimeout(() => { void loadAll() }, 3000)
        setTimeout(closeLoginDialog, 900)
      } else if (login.status === 'error') {
        stopLoginPolling()
      }
    } catch {
      // 轮询期间的临时错误不终止流程。
    }
  }, 2000)
}

/** 停止轮询。 */
function stopLoginPolling() {
  if (state.loginTimer !== null) {
    clearInterval(state.loginTimer)
    state.loginTimer = null
  }
}

/** 打开登录对话框。 */
function openLoginDialog() {
  $('login-form').reset()
  $('login-error').hidden = true
  $('login-pending').hidden = true
  $('submit-login').disabled = false
  updateLoginFields()
  $('login-dialog').showModal()
}

/** 关闭登录对话框。 */
function closeLoginDialog() {
  stopLoginPolling()
  $('login-dialog').close()
}

/** 按登录方式显示字段。 */
function updateLoginFields() {
  const method = $('login-method').value
  for (const node of document.querySelectorAll('[data-methods]')) {
    const methods = (node.dataset.methods ?? '').split(/\s+/u)
    node.hidden = !methods.includes(method)
  }
}

/** 提交登录或导入。 */
async function submitLogin(event) {
  event.preventDefault()
  const method = $('login-method').value
  const body = { method }
  const put = (key, value) => {
    if (typeof value === 'string' && value.trim().length > 0) body[key] = value.trim()
  }
  put('label', $('login-label').value)
  put('region', $('login-region').value)
  put('startUrl', $('login-start-url').value)
  put('refreshToken', $('login-refresh-token').value)
  put('credentialSource', $('login-credential-source').value)
  put('clientId', $('login-client-id').value)
  put('clientSecret', $('login-client-secret').value)
  put('apiKey', $('login-api-key').value)
  put('profileArn', $('login-profile-arn').value)

  if (method === 'external-idp') {
    try {
      body.credentials = JSON.parse($('login-external-json').value)
    } catch {
      showLoginError('External IdP 凭据必须是合法的 JSON')
      return
    }
  }

  const importing = method === 'refresh-token' || method === 'api-key' || method === 'external-idp'
  $('login-error').hidden = true
  $('submit-login').disabled = true
  try {
    if (importing) {
      const status = await api('/credentials/import', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      state.status = status
      renderAuthBadge()
      renderAccounts()
      toast('账号已导入')
      closeLoginDialog()
      await loadAll()
      await loadUsage()
      return
    }
    const login = await api('/login', { method: 'POST', body: JSON.stringify(body) })
    renderLoginPending(login)
    startLoginPolling()
  } catch (error) {
    showLoginError(error instanceof Error ? error.message : String(error))
    $('submit-login').disabled = false
  }
}

/** 登录对话框内的错误。 */
function showLoginError(message) {
  const node = $('login-error')
  node.textContent = message
  node.hidden = false
}

/** 取消登录。 */
async function cancelLogin() {
  try {
    await api('/login/cancel', { method: 'POST' })
  } catch (error) {
    showError(error)
  }
  closeLoginDialog()
  await loadAll()
}

/** 绑定事件。 */
function bind() {
  $('refresh-all').addEventListener('click', () => { void loadAll().then(() => loadUsage(true)) })
  $('refresh-usage').addEventListener('click', () => void loadUsage(true))
  $('refresh-models').addEventListener('click', () => void refreshModels())
  $('save-models').addEventListener('click', () => void saveModels())
  $('save-context').addEventListener('click', () => void saveContext())
  $('save-settings').addEventListener('click', () => void saveConfig())
  $('restart-listener').addEventListener('click', () => void restartListener())
  $('open-login').addEventListener('click', openLoginDialog)
  $('close-login').addEventListener('click', closeLoginDialog)
  $('cancel-login').addEventListener('click', () => void cancelLogin())
  $('login-method').addEventListener('change', updateLoginFields)
  $('login-form').addEventListener('submit', event => void submitLogin(event))
  $('admin-token-save').addEventListener('click', () => {
    const token = $('admin-token-input').value.trim()
    if (token.length > 0) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    $('auth-banner').hidden = true
    void loadAll().then(() => loadUsage())
  })

  $('logout-all').addEventListener('click', async () => {
    if (!window.confirm('退出所有由网关管理的 Kiro 账号？')) return
    try {
      state.status = await api('/logout', { method: 'POST' })
      state.usage = null
      toast('已退出所有账号')
      await loadAll()
    } catch (error) {
      showError(error)
    }
  })

  $('account-list').addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('button[data-action]')
    if (button === null || button === undefined) return
    const accountId = button.dataset.id ?? ''
    const accounts = state.status?.accounts?.accounts ?? []
    if (button.dataset.action === 'activate') {
      try {
        state.status = await api('/accounts/activate', {
          method: 'POST',
          body: JSON.stringify({ accountId }),
        })
        toast('已切换当前账号')
        await loadAll()
        await loadUsage(true)
      } catch (error) {
        showError(error)
      }
      return
    }
    if (button.dataset.action === 'remove') {
      const target = accounts.find(account => account.id === accountId)
      if (target === undefined) return
      if (!window.confirm(`移除账号“${target.label ?? target.id}”？`)) return
      const replacement = target.active
        ? accounts.find(account => account.id !== accountId)
        : undefined
      try {
        state.status = await api('/accounts/remove', {
          method: 'POST',
          body: JSON.stringify({
            accountId,
            ...replacement === undefined ? {} : { replacementId: replacement.id },
          }),
        })
        toast('账号已移除')
        await loadAll()
      } catch (error) {
        showError(error)
      }
    }
  })

  document.addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('button[data-copy]')
    if (button === null || button === undefined) return
    const source = document.getElementById(button.dataset.copy ?? '')
    if (source === null) return
    try {
      await navigator.clipboard.writeText(source.textContent ?? '')
      toast('已复制')
    } catch {
      showError(new Error('复制失败，请手动选择文本'))
    }
  })
}

bind()
await loadAll()
await loadUsage()
