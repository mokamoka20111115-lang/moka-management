import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createReader, readConfig, authorizationRequest, OWNER_UID, hash } from '../core.js'
import { fixture, testEnv, entry } from './helpers.js'

const rejects = (operation, code) => assert.rejects(operation, error => error.code === code)
test('missing/foreign UID, invalid origin and wildcard callbacks fail closed', () => {
  for (const env of [{}, { ...testEnv, MOKA_ALLOWED_UID: 'other' }, { ...testEnv, MOKA_MCP_BASE_URL: 'http://localhost' },
    { ...testEnv, MOKA_MCP_BASE_URL: 'https://example.com/path' }, { ...testEnv, MOKA_OAUTH_REDIRECT_URIS: '[]' },
    { ...testEnv, MOKA_OAUTH_REDIRECT_URIS: '["https://evil.example/callback"]' }, { ...testEnv, MOKA_OAUTH_REDIRECT_URIS: '["https://chatgpt.com/connector/oauth/*"]' }]) {
    assert.throws(() => readConfig(env), error => error.status === 503)
  }
  assert.equal(readConfig(testEnv).uid, OWNER_UID)
})
test('S256 PKCE, exact client, callback, resource and read-only scope are mandatory', () => {
  const f = fixture()
  for (const mutation of [{ code_challenge_method: 'plain' }, { resource: 'https://other/mcp' }, { redirect_uri: 'https://evil.example' },
    { client_id: 'other' }, { scope: 'entries:write' }, { state: '' }, { code_challenge: 'short' }, { client_id: ['a', 'b'] }]) {
    assert.throws(() => authorizationRequest(f.config, { ...f.query, ...mutation }))
  }
})
test('Google UID verified with revocation checks; foreign/unverified/stale sign-in denied', async () => {
  for (const mutation of [{ uid: 'other' }, { email_verified: false }, { firebase: { sign_in_provider: 'password' } }, { auth_time: 1 }]) {
    const f = fixture(), request = await f.oauth.begin(f.query); Object.assign(f.claims, mutation)
    await rejects(() => f.oauth.approve(request.id, request.binding, 'verified-firebase-id-token'), 'access_denied')
    assert.equal([...f.records.keys()].some(key => key.startsWith('codes/')), false)
  }
})
test('browser binding and one-use authorization protect consent; state and issuer are preserved', async () => {
  const f = fixture(), pending = await f.oauth.begin(f.query)
  await rejects(() => f.oauth.approve(pending.id, 'a'.repeat(43), 'verified-firebase-id-token'), 'invalid_request')
  const redirect = new URL(await f.oauth.approve(pending.id, pending.binding, 'verified-firebase-id-token'))
  assert.equal(redirect.searchParams.get('state'), f.query.state); assert.equal(redirect.searchParams.get('iss'), f.config.baseUrl)
  await rejects(() => f.oauth.approve(pending.id, pending.binding, 'verified-firebase-id-token'), 'invalid_request')
})
test('code requires matching verifier, resource, callback and client; never stored as plaintext', async () => {
  const f = fixture(), { code } = await f.issueCode()
  for (const mutation of [{ code_verifier: 'x'.repeat(64) }, { redirect_uri: 'https://evil.example' }, { resource: 'https://evil.example' }, { client_id: 'other' }]) {
    await assert.rejects(() => f.oauth.exchange({ ...f.exchangeBody(code), ...mutation }))
  }
  const tokens = await f.oauth.exchange(f.exchangeBody(code))
  assert.equal((await f.oauth.authenticate(tokens.access_token)).uid, OWNER_UID)
  const dump = JSON.stringify([...f.records])
  assert.equal(dump.includes(tokens.access_token), false); assert.equal(dump.includes(tokens.refresh_token), false)
  assert.equal(dump.includes(code), false)
  await rejects(() => f.oauth.exchange(f.exchangeBody(code)), 'invalid_grant')
})
test('concurrent code exchange only succeeds once', async () => {
  const f = fixture(), { code } = await f.issueCode()
  const results = await Promise.allSettled([f.oauth.exchange(f.exchangeBody(code)), f.oauth.exchange(f.exchangeBody(code))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
})
test('request, code and access token expirations are enforced without cleanup', async () => {
  let f = fixture(), pending = await f.oauth.begin(f.query); f.advance(600001); f.claims.auth_time = f.now() / 1000
  await rejects(() => f.oauth.approve(pending.id, pending.binding, 'verified-firebase-id-token'), 'invalid_request')
  f = fixture(); let { code } = await f.issueCode(); f.advance(60001)
  await rejects(() => f.oauth.exchange(f.exchangeBody(code)), 'invalid_grant')
  f = fixture(); const tokens = await f.issueTokens(); f.advance(3600001)
  await rejects(() => f.oauth.authenticate(tokens.access_token), 'invalid_token')
})
test('rotating refresh tokens detect replay and revoke the entire grant', async () => {
  const f = fixture(), tokens = await f.issueTokens()
  const body = { client_id: f.config.clientId, resource: f.config.resource, grant_type: 'refresh_token', refresh_token: tokens.refresh_token }
  const next = await f.oauth.exchange(body)
  assert.notEqual(next.refresh_token, tokens.refresh_token)
  await f.oauth.authenticate(next.access_token)
  await rejects(() => f.oauth.exchange(body), 'invalid_grant')
  await rejects(() => f.oauth.authenticate(next.access_token), 'invalid_token')
})
test('disabled user, revoked Firebase sessions and explicit disconnect prevent reads', async () => {
  for (const change of [f => { f.user.disabled = true }, f => { f.user.tokensValidAfterTime = new Date(f.now() + 1000).toISOString() }]) {
    const f = fixture(), tokens = await f.issueTokens(); change(f)
    await rejects(() => f.oauth.authenticate(tokens.access_token), 'invalid_token')
  }
  const f = fixture(), tokens = await f.issueTokens(); await f.oauth.revoke(tokens.refresh_token)
  await rejects(() => f.oauth.authenticate(tokens.access_token), 'invalid_token')
})
test('access resource and scopes are rechecked; rate limiting applies', async () => {
  const f = fixture(), tokens = await f.issueTokens(), key = `access/${hash(tokens.access_token)}`
  const original = f.records.get(key)
  f.records.set(key, { ...original, resource: 'https://other/mcp' })
  await rejects(() => f.oauth.authenticate(tokens.access_token), 'invalid_token')
  f.records.set(key, { ...original, scope: 'entries:write' })
  await rejects(() => f.oauth.authenticate(tokens.access_token), 'invalid_token')
  f.records.set(key, original)
  for (let i = 0; i < 120; i++) await f.oauth.authenticate(tokens.access_token)
  await rejects(() => f.oauth.authenticate(tokens.access_token), 'rate_limited')
  f.advance(60000); await f.oauth.authenticate(tokens.access_token)
})
test('read day keeps all fields and revision; missing day stays missing; no business writes', async () => {
  const f = fixture(), date = '2026-10-06', expected = entry(date)
  f.businessRecords.set(`users/${OWNER_UID}/state/current`, { revision: 42 })
  f.businessRecords.set(`users/${OWNER_UID}/entries/${date}`, expected)
  const before = structuredClone([...f.businessRecords]), reader = createReader({ uid: OWNER_UID, business: f.business })
  assert.deepEqual(await reader.day(date), { date, exists: true, revision: 42, entry: expected })
  assert.deepEqual(await reader.day('2026-10-05'), { date: '2026-10-05', exists: false, revision: 42, entry: null })
  assert.equal((await reader.connection()).writesEnabled, false)
  assert.deepEqual([...f.businessRecords], before)
  assert.ok(f.reads.every(path => path.startsWith(`users/${OWNER_UID}/`)))
})
test('invalid dates, traversal, bad amounts and malformed data fail before disclosure', async () => {
  const f = fixture(), reader = createReader({ uid: OWNER_UID, business: f.business })
  for (const date of ['2026-02-29', '2026-04-31', '../other', '2026-1-01']) await rejects(() => reader.day(date), 'invalid_date')
  assert.equal(f.reads.length, 0)
  for (const mutation of [{ dineIn: -1 }, { supplies: 1.5 }, { uberPaid: Number.MAX_SAFE_INTEGER + 1 }, { secret: 'do not leak' }]) {
    f.businessRecords.set(`users/${OWNER_UID}/entries/2026-10-06`, { ...entry('2026-10-06'), ...mutation })
    await rejects(() => reader.day('2026-10-06'), 'invalid_cloud_data')
  }
})
test('deployment separates OAuth DB and read-only business transactions; Pages build excludes functions', async () => {
  const root = new URL('../', import.meta.url)
  const source = await readFile(new URL('index.js', root), 'utf8')
  assert.match(source, /getFirestore\(app, AUTH_DATABASE\)/)
  assert.match(source, /readOnly: true/)
  const build = await readFile(new URL('../../scripts/build.js', import.meta.url), 'utf8')
  assert.doesNotMatch(build, /functions/)
})
