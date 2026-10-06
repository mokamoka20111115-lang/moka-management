import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'
import { getAuth, setPersistence, inMemoryPersistence, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'

const login = document.getElementById('login'), approve = document.getElementById('approve')
const status = document.getElementById('status'), account = document.getElementById('account')
let auth, user
try {
  const response = await fetch('/oauth/config', { cache: 'no-store' })
  if (!response.ok) throw new Error('configuration')
  auth = getAuth(initializeApp(await response.json(), 'moka-mcp-consent'))
  await setPersistence(auth, inMemoryPersistence)
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  login.disabled = false; status.textContent = 'Googleで本人確認してから、読み取り連携を許可してください。'
  login.onclick = async () => {
    login.disabled = true; approve.disabled = true
    try {
      // SDK is loaded before click. No await before opening the popup on Safari.
      const signedIn = await signInWithPopup(auth, provider)
      user = signedIn.user; account.textContent = `ログイン中：${user.email}`
      approve.disabled = false; status.textContent = 'このアカウントの営業データをChatGPTに読み取らせます。内容を確認して許可してください。'
    } catch {
      user = null; account.textContent = ''; status.textContent = 'ログインできませんでした。Safariで開き、ポップアップの許可とアカウントをご確認ください。'
    } finally { login.disabled = false }
  }
  approve.onclick = async () => {
    if (!user) return
    approve.disabled = true; login.disabled = true; status.textContent = '接続を確認中…'
    try {
      const response = await fetch('/oauth/approve', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: document.querySelector('[data-request]').dataset.request, idToken: await user.getIdToken(true) }) })
      const result = await response.json()
      if (!response.ok) throw new Error('denied')
      await signOut(auth)
      location.replace(result.redirect)
    } catch {
      status.textContent = '接続できませんでした。許可されたGoogleアカウントか、設定・通信をご確認ください。期限切れの場合はChatGPTから接続し直してください。'
      approve.disabled = false; login.disabled = false
    }
  }
} catch { status.textContent = '準備に失敗しました。ChatGPTから接続し直してください。' }
document.getElementById('cancel').onclick = async () => {
  if (auth) await signOut(auth).catch(() => {})
  login.disabled = true; approve.disabled = true; account.textContent = ''
  status.textContent = '連携をキャンセルしました。この画面を閉じてChatGPTへ戻ってください。'
}
