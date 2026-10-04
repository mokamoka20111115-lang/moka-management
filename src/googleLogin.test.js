import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLoginDomain, createGoogleLogin, isStandalone, loginErrorMessage } from './googleLogin.js'
const config={apiKey:'public-web-key'}
const page='https://mokamoka20111115-lang.github.io/moka-management/'
const response=(data,ok=true,status=200)=>({ok,status,json:async()=>data})

test('公開アプリのホストを承認済みドメインと照合し、Firebaseの公開設定APIを使う',async()=>{
  let called
  await checkLoginDomain(config,page,async(url,options)=>{called={url:new URL(url),options};return response({authorizedDomains:['moka-management.firebaseapp.com','mokamoka20111115-lang.github.io']})})
  assert.equal(called.url.origin,'https://identitytoolkit.googleapis.com')
  assert.equal(called.url.pathname,'/v1/projects');assert.equal(called.url.searchParams.get('key'),'public-web-key')
  assert.equal(called.options.cache,'no-store')
})
test('Firebase側にGitHub Pagesドメインがなければ認証開始前に具体的なエラーにする',async()=>{
  await assert.rejects(()=>checkLoginDomain(config,page,async()=>response({authorizedDomains:['moka-management.firebaseapp.com']})),error=>error.code==='auth/unauthorized-domain'&&error.message.includes('mokamoka20111115-lang.github.io'))
})
test('ドメイン照合はパスや類似ドメインで誤許可しない',async()=>{
  for(const domains of [['mokamoka20111115-lang.github.io/moka-management/'],['github.io.attacker.example'],['amokamoka20111115-lang.github.io']]) {
    await assert.rejects(()=>checkLoginDomain(config,page,async()=>response({authorizedDomains:domains})),{code:'auth/unauthorized-domain'})
  }
  await checkLoginDomain(config,'https://sub.example.com/app',async()=>response({authorizedDomains:['example.com']}))
  await assert.rejects(()=>checkLoginDomain(config,'file:///app/index.html',async()=>response({authorizedDomains:[]})),{code:'auth/operation-not-supported-in-this-environment'})
})
test('APIキー不正・制限・不正な応答・通信失敗を切り分ける',async()=>{
  await assert.rejects(()=>checkLoginDomain(config,page,async()=>response({error:{message:'API_KEY_INVALID'}},false,400)),{code:'auth/invalid-api-key'})
  await assert.rejects(()=>checkLoginDomain(config,page,async()=>response({error:{message:'PERMISSION_DENIED'}},false,403)),{code:'auth/app-not-authorized'})
  await assert.rejects(()=>checkLoginDomain(config,page,async()=>response({})),{code:'auth/project-config-unavailable'})
  await assert.rejects(()=>checkLoginDomain(config,page,async()=>{throw new Error('offline')}),{code:'auth/network-request-failed'})
})
test('通信タイムアウトで準備状態のまま待ち続けない',async()=>{
  await assert.rejects(()=>checkLoginDomain(config,page,async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))),10),{code:'auth/network-request-failed'})
})
test('準備完了前・設定エラー時にはポップアップを開かない',async()=>{
  let calls=0
  const client=createGoogleLogin({signInWithPopup:()=>{calls++}}, {}, {}, async()=>{throw Object.assign(new Error('未登録'),{code:'auth/unauthorized-domain'})})
  await assert.rejects(()=>client.login(),{code:'auth/not-ready'})
  await assert.rejects(()=>client.prepareLogin(),{code:'auth/unauthorized-domain'})
  await assert.rejects(()=>client.login(),{code:'auth/unauthorized-domain'})
  assert.equal(calls,0)
})
test('ボタン操作の呼び出し内でPopupを開始し、連打で認証をキャンセルしない',async()=>{
  let calls=0,resolve
  const auth={},provider={}
  const client=createGoogleLogin({signInWithPopup:(a,p)=>{assert.equal(a,auth);assert.equal(p,provider);calls++;return new Promise(done=>{resolve=done})},signInWithRedirect:()=>assert.fail('別ドメインへのRedirectに自動変更しない')},auth,provider,async()=>{})
  await client.prepareLogin()
  const first=client.login()
  assert.equal(calls,1) // 次のmicrotaskまで待たずSDKを呼ぶ
  assert.equal(client.login(),first);assert.equal(calls,1)
  resolve({user:{uid:'alice'}});await first
  const second=client.login();assert.equal(calls,2);resolve({user:{uid:'alice'}});await second
})
test('キャンセルや認証エラーの後に再試行できる',async()=>{
  let calls=0
  const client=createGoogleLogin({signInWithPopup:()=>{calls++;return Promise.reject({code:'auth/popup-closed-by-user'})}}, {}, {}, async()=>{})
  await client.prepareLogin()
  await assert.rejects(()=>client.login(),{code:'auth/popup-closed-by-user'})
  await assert.rejects(()=>client.login(),{code:'auth/popup-closed-by-user'})
  assert.equal(calls,2)
})
test('Safariとホーム画面の実行形態を区別する',()=>{
  assert.equal(isStandalone({standalone:true}),true)
  assert.equal(isStandalone({standalone:false},()=>({matches:true})),true)
  assert.equal(isStandalone({standalone:false},()=>({matches:false})),false)
})
test('SDKエラーは日本語とコードに変換し、認証URLやトークンを表示しない',()=>{
  const error={code:'auth/invalid-oauth-client-id',message:'Firebase: https://example.test/?eventId=secret'}
  const message=loginErrorMessage(error)
  assert.match(message,/OAuth/);assert.match(message,/auth\/invalid-oauth-client-id/)
  assert.doesNotMatch(message,/eventId|secret/)
  assert.match(loginErrorMessage({code:'auth/popup-closed-by-user',message:'Firebase: popup closed'}),/The requested action is invalid/)
})
