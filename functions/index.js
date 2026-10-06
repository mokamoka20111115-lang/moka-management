import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'
import { createApp } from './app.js'
import { AUTH_DATABASE } from './core.js'

const uid = defineString('MOKA_ALLOWED_UID', { default: '' })
const baseUrl = defineString('MOKA_MCP_BASE_URL', { default: '' })
const redirects = defineString('MOKA_OAUTH_REDIRECT_URIS', { default: '[]' })
const serviceAccount = defineString('MOKA_MCP_SERVICE_ACCOUNT')
const app = initializeApp({ projectId: 'moka-management' }) // ADC; no service-account JSON.
const businessDb = getFirestore(app)
const oauthDb = getFirestore(app, AUTH_DATABASE)
const store = {
  atomic(callback) {
    return oauthDb.runTransaction(tx => callback({
      async get(path) {
        const snap = await tx.get(oauthDb.doc(path))
        if (!snap.exists) return null
        const data = snap.data()
        return { ...data, expiresAt: data.expiresAt?.toMillis?.() ?? data.expiresAt }
      },
      set(path, data) { tx.set(oauthDb.doc(path), { ...data, expiresAt: new Date(data.expiresAt) }) },
      delete(path) { tx.delete(oauthDb.doc(path)) },
    }))
  },
}
const business = {
  readTransaction(callback) {
    return businessDb.runTransaction(tx => callback({
      async get(path) { const snap = await tx.get(businessDb.doc(path)); return snap.exists ? snap.data() : null },
    }), { readOnly: true })
  },
}
const handler = createApp({ env: () => ({ MOKA_ALLOWED_UID: uid.value(), MOKA_MCP_BASE_URL: baseUrl.value(), MOKA_OAUTH_REDIRECT_URIS: redirects.value() }),
  store, identity: getAuth(app), business,
  webConfig: { apiKey: 'AIzaSyDI6jWFF13UoPdGwBRkeBVzXeg4EXpgK3c', authDomain: 'moka-management.firebaseapp.com', projectId: 'moka-management',
    appId: '1:629293497917:web:c41ef59a18e527a32d3454' },
})
export const mokaMcp = onRequest({ region: 'asia-northeast1', minInstances: 0, maxInstances: 1, concurrency: 10, timeoutSeconds: 30,
  memory: '256MiB', serviceAccount, invoker: 'public', cors: false }, handler)
