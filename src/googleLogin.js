// Firebase SDKも認証開始時に使う公開プロジェクト設定APIを先に確認する。
// ポップアップを開いてから設定エラーになるのを避ける。管理者APIではない。
function authError(code, message) { return Object.assign(new Error(message), { code }) }

export async function checkLoginDomain(config, pageUrl, fetchImpl = globalThis.fetch, timeoutMilliseconds = 10000) {
  const page = new URL(pageUrl)
  if (!['https:', 'http:'].includes(page.protocol)) throw authError('auth/operation-not-supported-in-this-environment', '公開アプリのHTTPSのURLから開いてください。')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds)
  try {
    const endpoint = new URL('https://identitytoolkit.googleapis.com/v1/projects')
    endpoint.searchParams.set('key', config.apiKey)
    const response = await fetchImpl(endpoint.href, { signal: controller.signal, cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) {
      const reason = data.error?.message || ''
      if (reason.includes('API_KEY_INVALID') || reason.includes('API key not valid')) throw authError('auth/invalid-api-key', 'Firebase Web設定のapiKeyが有効か確認してください。')
      if (response.status === 403) throw authError('auth/app-not-authorized', 'Firebase APIへのアクセスが拒否されました。APIキーの制限とAuthentication設定を確認してください。')
      throw authError('auth/project-config-unavailable', 'Firebaseの認証設定を確認できませんでした。')
    }
    if (!Array.isArray(data.authorizedDomains)) throw authError('auth/project-config-unavailable', 'Firebaseから承認済みドメインの設定を取得できませんでした。')
    const hostname = page.hostname.toLowerCase()
    const allowed = data.authorizedDomains.some(domain => {
      if (typeof domain !== 'string' || !domain) return false
      const expected = domain.toLowerCase()
      return hostname === expected || (!/^\d+\.\d+\.\d+\.\d+$/.test(expected) && hostname.endsWith('.' + expected))
    })
    if (!allowed) throw authError('auth/unauthorized-domain', `Firebase Authenticationの「承認済みドメイン」に ${page.hostname} を追加してから、アプリを再読み込みしてください。パスは入力しません。`)
  } catch (error) {
    if (error.code?.startsWith('auth/')) throw error
    throw authError('auth/network-request-failed', 'Firebaseの認証設定を確認する通信に失敗しました。接続やコンテンツブロッカーを確認して、再読み込みしてください。')
  } finally { clearTimeout(timeout) }
}

export function createGoogleLogin(authSdk, auth, provider, prepare) {
  let ready = false, preparation = null, preparationError = null, pending = null
  return {
    prepareLogin() {
      if (!preparation) preparation = Promise.resolve().then(prepare).then(() => { ready = true }).catch(error => { preparationError = error; throw error })
      return preparation
    },
    login() {
      if (pending) return pending
      if (!ready) return Promise.reject(preparationError || authError('auth/not-ready', 'ログインの準備が終わっていません。少し待ってからお試しください。'))
      // ここでawaitしない。ユーザーがボタンを押した呼び出しの中からSDKを実行する。
      try {
        pending = Promise.resolve(authSdk.signInWithPopup(auth, provider)).finally(() => { pending = null })
        return pending
      } catch (error) { return Promise.reject(error) }
    },
  }
}

export function isStandalone(navigatorLike = globalThis.navigator, mediaQuery = globalThis.matchMedia) {
  return navigatorLike?.standalone === true || (typeof mediaQuery === 'function' && mediaQuery('(display-mode: standalone)').matches === true)
}

export function loginErrorMessage(error) {
  const code = error?.code || ''
  const messages = {
    'auth/unauthorized-domain': 'Firebase Authenticationの「承認済みドメイン」に mokamoka20111115-lang.github.io を追加してください。',
    'auth/operation-not-allowed': 'Firebase AuthenticationでGoogleログインを有効にし、サポートメールを確認してください。',
    'auth/invalid-api-key': 'Firebase Web設定のapiKeyが有効か確認してください。',
    'auth/app-not-authorized': 'Firebase APIへのアクセスが拒否されました。APIキーの制限を確認してください。',
    'auth/invalid-oauth-client-id': 'GoogleプロバイダのOAuthクライアント設定を確認してください。',
    'auth/web-storage-unsupported': '認証に必要なブラウザ保存領域を利用できません。Safariの通常タブで試してください。',
    'auth/popup-blocked': 'ログイン画面がブロックされました。Safariで公開URLを直接開き、ボタンを1回押してください。',
    'auth/popup-closed-by-user': 'ログイン画面が閉じられました。「The requested action is invalid.」が表示された場合は、承認済みドメインとGoogleプロバイダの設定を確認してください。',
    'auth/cancelled-popup-request': '別のログイン操作が始まりました。画面を閉じて、ボタンを1回だけ押してください。',
    'auth/network-request-failed': '認証の通信に失敗しました。接続やコンテンツブロッカーを確認してください。',
  }
  const message = error?.message && !error.message.startsWith('Firebase:') ? error.message : messages[code] || 'Googleログインに失敗しました。設定と接続を確認してください。'
  // URL・eventId・トークンは表示しない。診断に必要なエラーコードだけを表示する。
  return `${message}${code ? `（${code}）` : ''}`
}
