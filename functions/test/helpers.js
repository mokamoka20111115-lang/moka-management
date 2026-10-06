import { createHash } from 'node:crypto'
import { OWNER_UID, CLIENT_ID, readConfig, createOAuth } from '../core.js'

export const testEnv = { MOKA_ALLOWED_UID: OWNER_UID, MOKA_MCP_BASE_URL: 'https://moka-mcp.example.com',
  MOKA_OAUTH_REDIRECT_URIS: '["https://chatgpt.com/connector/oauth/test-callback"]' }
export function fixture() {
  let instant = Date.parse('2026-10-06T01:00:00Z')
  const now = () => instant
  const records = new Map(), businessRecords = new Map(), reads = []
  // Atomic rollback and serialization, also enforcing Firestore's read-before-write rule.
  let queue = Promise.resolve()
  const store = { atomic(callback) {
    const operation = queue.then(async () => {
      const draft = new Map(structuredClone([...records])), pending = []
      const value = await callback({ get: async path => {
        if (pending.length) throw new Error('read after write')
        return structuredClone(draft.get(path) ?? null)
      }, set: (path, data) => pending.push(() => draft.set(path, structuredClone(data))), delete: path => pending.push(() => draft.delete(path)) })
      pending.forEach(write => write()); records.clear(); draft.forEach((data, key) => records.set(key, data))
      return value
    })
    queue = operation.catch(() => {}); return operation
  } }
  const claims = { uid: OWNER_UID, email_verified: true, firebase: { sign_in_provider: 'google.com' }, auth_time: instant / 1000 }
  const user = { uid: OWNER_UID, emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com' }], tokensValidAfterTime: '1970-01-01T00:00:00Z' }
  const identity = { async verifyIdToken(idToken, checkRevoked) {
    if (idToken !== 'verified-firebase-id-token' || checkRevoked !== true) throw new Error('invalid Firebase token')
    return claims
  }, async getUser(uid) { if (uid !== OWNER_UID) throw new Error('wrong UID'); return user } }
  const business = { async readTransaction(callback) {
    const snapshot = new Map(structuredClone([...businessRecords]))
    return callback({ async get(path) { reads.push(path); return snapshot.get(path) ?? null } })
  } }
  const config = readConfig(testEnv), oauth = createOAuth({ config, store, identity, now })
  const verifier = 'v'.repeat(64)
  const query = { client_id: CLIENT_ID, redirect_uri: config.redirects[0], response_type: 'code', state: 'csrf-state',
    scope: 'entries:read offline_access', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: config.resource }
  const exchangeBody = code => ({ client_id: CLIENT_ID, resource: config.resource, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: query.redirect_uri })
  async function issueCode() {
    const pending = await oauth.begin(query)
    const redirect = new URL(await oauth.approve(pending.id, pending.binding, 'verified-firebase-id-token'))
    return { code: redirect.searchParams.get('code'), redirect, pending }
  }
  async function issueTokens() { return oauth.exchange(exchangeBody((await issueCode()).code)) }
  return { records, store, identity, business, businessRecords, reads, config, oauth, now, claims, user, query, verifier, exchangeBody, issueCode, issueTokens,
    advance: ms => { instant += ms } }
}
export const entry = date => ({ date, dineIn: 30000, uberOrder: 0, uberPaid: 0, demaeOrder: 5000, demaePaid: 4000, rocketOrder: 0, rocketPaid: 0, ingredients: 8000, supplies: 0 })
