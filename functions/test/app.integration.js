import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../app.js'
import { OWNER_UID, CLIENT_ID } from '../core.js'
import { fixture, testEnv, entry } from './helpers.js'

async function serve(t, env = testEnv) {
  const f = fixture(), app = createApp({ env: () => env, store: f.store, identity: f.identity, business: f.business, now: f.now, webConfig: {} })
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const root = `http://127.0.0.1:${server.address().port}`
  return { f, root, get: (path, options) => fetch(root + path, options) }
}
test('real SDK client initializes, lists only two read tools and reads owner data without writes', async t => {
  const { f, root } = await serve(t), tokens = await f.issueTokens()
  const date = '2026-10-06', data = entry(date)
  f.businessRecords.set(`users/${OWNER_UID}/state/current`, { revision: 7 })
  f.businessRecords.set(`users/${OWNER_UID}/entries/${date}`, data)
  const before = structuredClone([...f.businessRecords])
  const client = new Client({ name: 'moka-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(root + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }))
  const list = await client.listTools()
  assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['connection_check', 'read_business_day'])
  assert.ok(list.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint))
  const connection = await client.callTool({ name: 'connection_check', arguments: {} })
  assert.equal(connection.structuredContent.writesEnabled, false); assert.equal(connection.structuredContent.revision, 7)
  const read = await client.callTool({ name: 'read_business_day', arguments: { date, uid: 'someone-else' } })
  assert.deepEqual(read.structuredContent, { date, revision: 7, exists: true, entry: data })
  const invalid = await client.callTool({ name: 'read_business_day', arguments: { date: '2026-02-29' } })
  assert.equal(invalid.isError, true)
  const forbidden = await client.callTool({ name: 'save_business_day', arguments: { date, dineIn: 1 } })
  assert.equal(forbidden.isError, true)
  assert.deepEqual([...f.businessRecords], before)
  assert.ok(f.reads.every(path => path.startsWith(`users/${OWNER_UID}/`)))
})
test('OAuth HTTP flow enforces Origin+cookie consent and completes a PKCE token exchange', async t => {
  const { f, get } = await serve(t)
  const discovery = await (await get('/.well-known/oauth-authorization-server')).json()
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(discovery.token_endpoint_auth_methods_supported, ['none'])
  assert.equal(discovery.issuer, testEnv.MOKA_MCP_BASE_URL)
  const start = await get('/oauth/authorize?' + new URLSearchParams(f.query))
  assert.equal(start.status, 200)
  const html = await start.text(), requestId = /data-request="([A-Za-z0-9_-]+)"/.exec(html)[1]
  const cookie = start.headers.get('set-cookie').split(';')[0]
  assert.match(start.headers.get('set-cookie'), /HttpOnly/); assert.match(start.headers.get('set-cookie'), /Secure/)
  const consent = JSON.stringify({ requestId, idToken: 'verified-firebase-id-token' })
  const approve = options => get('/oauth/approve', { method: 'POST', headers: { 'content-type': 'application/json', ...options }, body: consent })
  assert.equal((await approve({ cookie })).status, 403)
  assert.equal((await approve({ origin: testEnv.MOKA_MCP_BASE_URL })).status, 400)
  assert.equal((await approve({ origin: 'https://evil.example', cookie })).status, 403)
  const approved = await approve({ origin: testEnv.MOKA_MCP_BASE_URL, cookie })
  assert.equal(approved.status, 200)
  const redirect = new URL((await approved.json()).redirect)
  const code = redirect.searchParams.get('code')
  const response = await get('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f.exchangeBody(code)) })
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const tokens = await response.json()
  assert.equal((await f.oauth.authenticate(tokens.access_token)).uid, OWNER_UID)
  const revoked = await get('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, token: tokens.refresh_token }) })
  assert.equal(revoked.status, 200)
  assert.equal((await get('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401)
})
test('missing settings, missing token, malicious origin, oversized body and write endpoints fail safely', async t => {
  let service = await serve(t, {})
  assert.equal((await service.get('/.well-known/oauth-authorization-server')).status, 503)
  service = await serve(t)
  const unauthenticated = await service.get('/mcp', { method: 'POST' })
  assert.equal(unauthenticated.status, 401)
  assert.match(unauthenticated.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/)
  assert.equal((await service.get('/mcp', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await service.get('/entries', { method: 'POST' })).status, 404)
  assert.equal((await service.get('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20000) })).status, 413)
  assert.equal(service.f.reads.length, 0)
})
test('discovery is available before callback registration, but all OAuth and data access stay disabled', async t => {
  const { f, get } = await serve(t, { ...testEnv, MOKA_OAUTH_REDIRECT_URIS: '[]' })
  assert.equal((await get('/.well-known/oauth-authorization-server')).status, 200)
  assert.equal((await get('/.well-known/oauth-protected-resource/mcp')).status, 200)
  assert.equal((await get('/oauth/authorize?' + new URLSearchParams(f.query))).status, 503)
  assert.equal((await get('/oauth/token', { method: 'POST' })).status, 503)
  assert.equal((await get('/mcp', { method: 'POST' })).status, 503)
  assert.equal(f.records.size, 0); assert.equal(f.reads.length, 0)
})
