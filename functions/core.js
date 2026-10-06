import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SCOPE = 'entries:read'
export const CLIENT_ID = 'moka-chatgpt-readonly'
export const AUTH_DATABASE = 'mcp-auth'
export const OWNER_UID = 'JR8vRpF9uyaOnNONszt4vYcYBWd2'
export class SafeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
const fail = (status, code) => { throw new SafeError(status, code) }
export const hash = value => createHash('sha256').update(value).digest('hex')
export const randomToken = () => randomBytes(32).toString('base64url')
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const scalar = value => typeof value === 'string' && value.length <= 2048
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export function readConfig(env, { discoveryOnly = false } = {}) {
  const uid = env.MOKA_ALLOWED_UID || ''
  const baseUrl = env.MOKA_MCP_BASE_URL || ''
  let redirects
  try { redirects = JSON.parse(env.MOKA_OAUTH_REDIRECT_URIS || '[]') } catch { fail(503, 'configuration_required') }
  if (uid !== OWNER_UID) fail(503, 'configuration_required')
  let url
  try { url = new URL(baseUrl) } catch { fail(503, 'configuration_required') }
  // Root origin is required for standards-based OAuth discovery. Never infer from Host.
  if (url.protocol !== 'https:' || url.origin !== baseUrl || url.username || url.password) fail(503, 'configuration_required')
  if (!Array.isArray(redirects) || (!discoveryOnly && !redirects.length) || redirects.length > 4) fail(503, 'configuration_required')
  for (const redirect of redirects) {
    let target
    try { target = new URL(redirect) } catch { fail(503, 'configuration_required') }
    if (target.origin !== 'https://chatgpt.com' || target.search || target.hash
      || !/^\/(connector\/oauth\/[A-Za-z0-9_-]+|connector_platform_oauth_redirect)$/.test(target.pathname)) fail(503, 'configuration_required')
  }
  return { uid, baseUrl, resource: `${baseUrl}/mcp`, redirects, clientId: CLIENT_ID }
}

export function authorizationRequest(config, query) {
  for (const key of ['client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'resource']) {
    if (!scalar(query[key])) fail(400, 'invalid_request')
  }
  if (query.client_id !== config.clientId || !config.redirects.includes(query.redirect_uri)) fail(400, 'invalid_client')
  if (query.response_type !== 'code' || query.code_challenge_method !== 'S256'
    || !opaque(query.code_challenge) || !query.state || query.resource !== config.resource) fail(400, 'invalid_request')
  const scopes = query.scope.split(' ')
  if (!scopes.includes(SCOPE) || scopes.some(scope => ![SCOPE, 'offline_access'].includes(scope))
    || scopes.length !== new Set(scopes).size) fail(400, 'invalid_scope')
  return { clientId: query.client_id, redirect: query.redirect_uri, state: query.state,
    scope: scopes.join(' '), challenge: query.code_challenge, resource: query.resource }
}

// store.atomic(callback) is injected; production uses only the separate mcp-auth DB.
export function createOAuth({ config, store, identity, now = () => Date.now(), token = randomToken }) {
  const path = (kind, value) => `${kind}/${hash(value)}`
  const assertOwner = async (uid, authTime) => {
    if (uid !== config.uid) fail(403, 'access_denied')
    const user = await identity.getUser(uid)
    const revokedAfter = Date.parse(user.tokensValidAfterTime || '1970-01-01') / 1000
    if (user.disabled || !user.emailVerified || !user.providerData?.some(p => p.providerId === 'google.com')
      || !Number.isFinite(authTime) || authTime < revokedAfter) fail(401, 'invalid_token')
  }
  const mint = (tx, account, grantId, instant) => {
    const access = token(), refresh = account.scope.split(' ').includes('offline_access') ? token() : null
    tx.set(path('access', access), { ...account, grantId, expiresAt: instant + 60 * 60 * 1000 })
    if (refresh) tx.set(path('refresh', refresh), { ...account, grantId, used: false, expiresAt: instant + 30 * 86400000 })
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: account.scope,
      ...(refresh ? { refresh_token: refresh } : {}) }
  }
  return {
    async begin(query) {
      const request = authorizationRequest(config, query), id = token(), binding = token()
      await store.atomic(async tx => tx.set(path('requests', id), { ...request, binding: hash(binding), expiresAt: now() + 10 * 60000 }))
      return { id, binding }
    },
    async approve(id, binding, idToken) {
      if (!opaque(id) || !opaque(binding) || typeof idToken !== 'string' || idToken.length > 8192) fail(400, 'invalid_request')
      const decoded = await identity.verifyIdToken(idToken, true)
      if (decoded.uid !== config.uid || decoded.firebase?.sign_in_provider !== 'google.com'
        || decoded.email_verified !== true || !Number.isFinite(decoded.auth_time)
        || now() / 1000 - decoded.auth_time > 300 || decoded.auth_time > now() / 1000 + 30) fail(403, 'access_denied')
      await assertOwner(decoded.uid, decoded.auth_time)
      return store.atomic(async tx => {
        const pending = await tx.get(path('requests', id))
        if (!pending || pending.expiresAt <= now() || !equal(pending.binding, hash(binding))) fail(400, 'invalid_request')
        const code = token()
        tx.set(path('codes', code), { ...pending, uid: decoded.uid, authTime: decoded.auth_time, expiresAt: now() + 60000 })
        tx.delete(path('requests', id))
        const redirect = new URL(pending.redirect)
        redirect.searchParams.set('code', code); redirect.searchParams.set('state', pending.state)
        redirect.searchParams.set('iss', config.baseUrl)
        return redirect.href
      })
    },
    async exchange(body) {
      if (body.client_id !== config.clientId || body.resource !== config.resource) fail(400, 'invalid_client')
      if (body.grant_type === 'authorization_code') {
        if (!opaque(body.code) || !scalar(body.code_verifier) || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) fail(400, 'invalid_grant')
        return store.atomic(async tx => {
          const codePath = path('codes', body.code), code = await tx.get(codePath)
          if (!code || code.expiresAt <= now() || code.clientId !== body.client_id || code.redirect !== body.redirect_uri
            || code.resource !== body.resource || !equal(code.challenge, createHash('sha256').update(body.code_verifier).digest('base64url'))) fail(400, 'invalid_grant')
          await assertOwner(code.uid, code.authTime)
          const grantId = token(), account = { uid: code.uid, authTime: code.authTime, clientId: code.clientId, scope: code.scope, resource: code.resource }
          tx.set(path('grants', grantId), { uid: code.uid, revoked: false, expiresAt: now() + 30 * 86400000 })
          tx.delete(codePath)
          return mint(tx, account, grantId, now())
        })
      }
      if (body.grant_type === 'refresh_token') {
        if (!opaque(body.refresh_token)) fail(400, 'invalid_grant')
        const outcome = await store.atomic(async tx => {
          const key = path('refresh', body.refresh_token), record = await tx.get(key)
          if (!record || record.expiresAt <= now() || record.clientId !== body.client_id || record.resource !== body.resource) fail(400, 'invalid_grant')
          const grantPath = path('grants', record.grantId), grant = await tx.get(grantPath)
          if (!grant || grant.revoked || grant.expiresAt <= now()) fail(400, 'invalid_grant')
          if (record.used) { tx.set(grantPath, { ...grant, revoked: true }); return null }
          await assertOwner(record.uid, record.authTime)
          const { uid, authTime, clientId, scope, resource, grantId } = record
          tx.set(key, { ...record, used: true })
          return mint(tx, { uid, authTime, clientId, scope, resource }, grantId, now())
        })
        if (!outcome) fail(400, 'invalid_grant')
        return outcome
      }
      fail(400, 'unsupported_grant_type')
    },
    async authenticate(bearer) {
      if (!opaque(bearer)) fail(401, 'invalid_token')
      const record = await store.atomic(async tx => {
        const access = await tx.get(path('access', bearer))
        if (!access || access.expiresAt <= now() || access.uid !== config.uid || access.resource !== config.resource
          || access.clientId !== config.clientId || !access.scope.split(' ').includes(SCOPE)) fail(401, 'invalid_token')
        const grant = await tx.get(path('grants', access.grantId))
        if (!grant || grant.uid !== config.uid || grant.revoked || grant.expiresAt <= now()) fail(401, 'invalid_token')
        const key = path('limits', config.uid), current = await tx.get(key)
        const minute = Math.floor(now() / 60000), count = current?.minute === minute ? current.count : 0
        if (count >= 120) fail(429, 'rate_limited')
        tx.set(key, { minute, count: count + 1, expiresAt: now() + 86400000 })
        return access
      })
      await assertOwner(record.uid, record.authTime)
      return record
    },
    async revoke(bearer) {
      if (!opaque(bearer)) return
      await store.atomic(async tx => {
        const access = await tx.get(path('access', bearer)), refresh = await tx.get(path('refresh', bearer))
        const record = access || refresh
        if (!record || record.clientId !== config.clientId) return
        const key = path('grants', record.grantId), grant = await tx.get(key)
        if (grant) tx.set(key, { ...grant, revoked: true })
      })
    },
  }
}

const FIELDS = ['dineIn', 'uberOrder', 'uberPaid', 'demaeOrder', 'demaePaid', 'rocketOrder', 'rocketPaid', 'ingredients', 'supplies']
export function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}
export function checkedEntry(entry, date) {
  if (!entry || entry.date !== date || Object.keys(entry).sort().join(',') !== ['date', ...FIELDS].sort().join(',')
    || FIELDS.some(field => !Number.isSafeInteger(entry[field]) || entry[field] < 0)) fail(409, 'invalid_cloud_data')
  return Object.fromEntries(['date', ...FIELDS].map(field => [field, entry[field]]))
}
export function createReader({ uid, business }) {
  // Only get/readTransaction are injected. No business database writes are exposed.
  return {
    async connection() {
      const revision = await business.readTransaction(async tx => (await tx.get(`users/${uid}/state/current`))?.revision ?? 0)
      if (!Number.isSafeInteger(revision) || revision < 0) fail(409, 'invalid_cloud_data')
      return { connected: true, mode: 'read_only', revision, timezone: 'Asia/Tokyo', writesEnabled: false }
    },
    async day(date) {
      if (!validDate(date)) fail(400, 'invalid_date')
      return business.readTransaction(async tx => {
        const state = await tx.get(`users/${uid}/state/current`)
        const entry = await tx.get(`users/${uid}/entries/${date}`)
        const revision = state?.revision ?? 0
        if (!Number.isSafeInteger(revision) || revision < 0) fail(409, 'invalid_cloud_data')
        return { date, revision, exists: Boolean(entry), entry: entry ? checkedEntry(entry, date) : null }
      })
    },
  }
}
