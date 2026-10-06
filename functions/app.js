import express from 'express'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { CLIENT_ID, SCOPE, SafeError, createOAuth, createReader, readConfig } from './core.js'

const cookieName = '__Host-moka-oauth'
const cookie = req => {
  const matches = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`))
  return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : ''
}
export function createApp({ env, store, identity, business, webConfig, now, token }) {
  const app = express()
  let authWindow = 0, authRequests = 0
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' https://www.gstatic.com; style-src 'unsafe-inline'; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://www.gstatic.com; frame-src https://*.firebaseapp.com https://accounts.google.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" })
    // The Google popup must retain its opener.
    res.set('Cross-Origin-Opener-Policy', 'unsafe-none')
    if (Number(req.headers['content-length']) > 16384) return res.status(413).json({ error: 'request_too_large' })
    next()
  })
  app.use(express.json({ limit: '16kb' }))
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  app.use((req, res, next) => {
    try {
      const discoveryOnly = req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'].includes(req.path)
      req.config = readConfig(env(), { discoveryOnly })
      req.oauth = createOAuth({ config: req.config, store, identity, now, token })
      const origin = req.headers.origin
      if (origin && origin !== req.config.baseUrl && origin !== 'https://chatgpt.com') throw new SafeError(403, 'invalid_origin')
      // Bound unauthenticated OAuth bursts before storage/identity calls.
      // Per-instance guard, not a guaranteed billing cap across restarts.
      if (['/oauth/authorize', '/oauth/approve', '/oauth/token', '/oauth/revoke'].includes(req.path)) {
        const minute = Math.floor((now?.() ?? Date.now()) / 60000)
        if (authWindow !== minute) { authWindow = minute; authRequests = 0 }
        if (++authRequests > 60) throw new SafeError(429, 'rate_limited')
      }
      next()
    } catch (error) { next(error) }
  })
  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json({ resource: req.config.resource,
    authorization_servers: [req.config.baseUrl], scopes_supported: [SCOPE, 'offline_access'], bearer_methods_supported: ['header'] }))
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json({ resource: req.config.resource,
    authorization_servers: [req.config.baseUrl], scopes_supported: [SCOPE, 'offline_access'], bearer_methods_supported: ['header'] }))
  app.get('/.well-known/oauth-authorization-server', (req, res) => res.json({ issuer: req.config.baseUrl,
    authorization_endpoint: `${req.config.baseUrl}/oauth/authorize`, token_endpoint: `${req.config.baseUrl}/oauth/token`,
    revocation_endpoint: `${req.config.baseUrl}/oauth/revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true }))
  app.get('/oauth/login.js', (req, res) => res.type('text/javascript').sendFile(fileURLToPath(new URL('./public/login.js', import.meta.url))))
  app.get('/oauth/config', (req, res) => res.json(webConfig))
  app.get('/oauth/authorize', async (req, res) => {
    const { id, binding } = await req.oauth.begin(req.query)
    res.cookie(cookieName, binding, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 10 * 60000 })
    // id is random base64url; user-supplied query strings never enter the HTML.
    res.type('html').send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>MOKA 読み取り連携</title>
      <style>body{font:16px system-ui;max-width:540px;margin:auto;padding:24px 20px calc(24px + env(safe-area-inset-bottom));line-height:1.7}button{font:inherit;min-height:48px;margin:8px 0;padding:10px 16px}p{overflow-wrap:anywhere}</style>
      <h1>MOKAをChatGPTに接続</h1><p>連携先：ChatGPT（${CLIENT_ID}）</p><p>許可する内容：接続確認と営業日ごとのデータの読み取り。営業データの追加・変更・削除はできません。</p>
      <p>読み取った売上・仕入れ等はChatGPTに送信されます。MOKAで使っているGoogleアカウントでログインしてください。</p>
      <main data-request="${id}"><button id="login" disabled>Googleで本人確認</button><p id="account"></p><button id="approve" disabled>読み取り連携を許可する</button><button id="cancel">キャンセル</button><p id="status" role="status">ログインの準備中…</p></main>
      <script type="module" src="/oauth/login.js"></script></html>`)
  })
  app.post('/oauth/approve', async (req, res) => {
    if (req.headers.origin !== req.config.baseUrl) throw new SafeError(403, 'invalid_origin')
    if (!req.body || Object.keys(req.body).some(key => !['requestId', 'idToken'].includes(key))) throw new SafeError(400, 'invalid_request')
    const redirect = await req.oauth.approve(req.body.requestId, cookie(req), req.body.idToken)
    res.clearCookie(cookieName, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' })
    res.json({ redirect })
  })
  app.post('/oauth/token', async (req, res) => res.json(await req.oauth.exchange(req.body || {})))
  app.post('/oauth/revoke', async (req, res) => {
    if (req.body?.client_id !== CLIENT_ID) throw new SafeError(400, 'invalid_client')
    await req.oauth.revoke(req.body.token)
    res.status(200).json({ revoked: true })
  })
  app.use('/mcp', async (req, res, next) => {
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')
      req.account = await req.oauth.authenticate(match?.[1])
      next()
    } catch (error) {
      if (error.status === 401) res.set('WWW-Authenticate', `Bearer resource_metadata="${req.config.baseUrl}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`)
      next(error)
    }
  })
  app.post('/mcp', async (req, res, next) => {
    const reader = createReader({ uid: req.account.uid, business })
    const server = new McpServer({ name: 'moka-management-readonly', version: '1.0.0' })
    const metadata = { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [SCOPE] }] } }
    const result = async callback => {
      try { const data = await callback(); return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof SafeError ? error.code : 'read_failed_retry' }] } }
    }
    server.registerTool('connection_check', { title: 'MOKA接続確認', description: '本人のFirestoreとの接続と更新番号を確認します。営業データは変更しません。', inputSchema: {}, ...metadata }, () => result(() => reader.connection()))
    server.registerTool('read_business_day', { title: '営業日のデータを読む', description: 'YYYY-MM-DDで指定した営業日の実データと更新番号を読みます。今日・昨日はAsia/Tokyoで解釈し、日付を明示してください。未登録は未登録として返し、金額を推測しません。',
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }, ...metadata }, ({ date }) => result(() => reader.day(date)))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body) }
    catch (error) { if (!res.headersSent) next(error) }
  })
  app.all('/mcp', (req, res) => { res.set('Allow', 'POST'); res.status(405).json({ error: 'method_not_allowed' }) })
  app.use((req, res) => res.status(404).json({ error: 'not_found' }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    // Never expose/log token, request bodies or Firebase errors.
    const status = error instanceof SafeError ? error.status : error.status === 413 ? 413 : error.status === 400 ? 400 : 503
    res.status(status).json({ error: error instanceof SafeError ? error.code : status === 400 ? 'invalid_request' : status === 413 ? 'request_too_large' : 'service_unavailable' })
  })
  return app
}
