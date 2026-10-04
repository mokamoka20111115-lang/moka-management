import { checkLoginDomain, createGoogleLogin } from './googleLogin.js'
import { createCloudStore } from './cloudData.js'
// Firebase Web設定は公開用。管理者鍵やパスワードは含めない。
const config = {
  apiKey: 'AIzaSyDI6jWFF13UoPdGwBRkeBVzXeg4EXpgK3c',
  authDomain: 'moka-management.firebaseapp.com',
  projectId: 'moka-management',
  storageBucket: 'moka-management.firebasestorage.app',
  messagingSenderId: '629293497917',
  appId: '1:629293497917:web:c41ef59a18e527a32d3454',
}

export async function initializeFirebase(onUser) {
  // SDK読み込み失敗時もローカル機能を使えるよう、ブラウザから遅延読み込みする。
  const [appSdk, authSdk, dbSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
  ])
  const app = appSdk.initializeApp(config)
  const auth = authSdk.getAuth(app), db = dbSdk.getFirestore(app)
  // 永続的なFirestoreキャッシュは使わない。クラウド操作は通信必須。
  const api = {
    async get(path) { const snap = await dbSdk.getDocFromServer(dbSdk.doc(db, path)); return snap.exists() ? snap.data() : null },
    async list(path) { const snap = await dbSdk.getDocsFromServer(dbSdk.collection(db, path)); return snap.docs.map(doc => doc.data()) },
    transaction(callback) {
      return dbSdk.runTransaction(db, tx => callback({
        async get(path) { const snap = await tx.get(dbSdk.doc(db, path)); return snap.exists() ? snap.data() : null },
        set(path, data) { tx.set(dbSdk.doc(db, path), data) },
        delete(path) { tx.delete(dbSdk.doc(db, path)) },
      }))
    },
  }
  authSdk.onAuthStateChanged(auth, user => onUser(user, user ? createCloudStore(api, user.uid) : null))
  const provider = new authSdk.GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const loginClient = createGoogleLogin(authSdk, auth, provider, () => checkLoginDomain(config, globalThis.location.href))
  return {
    prepareLogin: () => loginClient.prepareLogin(),
    login: () => loginClient.login(),
    logout: () => authSdk.signOut(auth),
  }
}
