import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { environment } from '../test-support/dom.js'
import * as calculations from './calculations.js'
import { moveMonth } from './monthNavigation.js'
import { bindBackupControls } from './backupUI.js'
import { openMigration } from './migrationUI.js'
import { validateEntries, createBackup, STORAGE_KEY } from './backup.js'
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
async function appHarness({failSdk=false}={}) {
  const env=environment();Object.assign(globalThis,{document:env.document,localStorage:env.localStorage})
  let authChange
  const source=(await readFile(new URL('./main.js',import.meta.url),'utf8')).replace(/^import .* from .*\n/gm,'').replace("import('./firebaseClient.js')",'__firebaseImport()')
  const context={...env,...calculations,moveMonth,bindBackupControls,openMigration,validateEntries,createBackup,STORAGE_KEY,console,alert:()=>{},__firebaseImport:()=>failSdk?Promise.reject(new Error('SDK offline')):Promise.resolve({initializeFirebase:async callback=>{authChange=callback;callback(null,null);return {login:async()=>{},logout:async()=>callback(null,null)}}})}
  vm.runInNewContext(source,context);await tick()
  return {...env,authChange:async(user,store)=>{authChange(user,store);await tick()}}
}
const entry=date=>({date,...Object.fromEntries(calculations.numberFields.map(key=>[key,0]))})
function modalForm(env) {
  const overlay=env.document.querySelector('.overlay')
  const form=overlay.querySelector('form')
  const save=form.querySelector('button.primary')
  return {overlay,form,save,input:form.querySelectorAll('input').find(input=>input.name==='dineIn')}
}

test('SDK取得失敗でもローカル入力・月移動・バックアップを利用できる',async()=>{
  const env=await appHarness({failSdk:true})
  assert.match(env.app.querySelector('[data-cloud-status]').textContent,/準備に失敗/)
  const before=env.app.querySelector('.month-nav').querySelector('strong').textContent
  env.app.querySelector('[data-move="1"]').click();env.app.querySelector('[data-move="-1"]').click()
  assert.equal(env.app.querySelector('.month-nav').querySelector('strong').textContent,before)
  env.app.querySelector('[data-new]').click()
  const {form,input}=modalForm(env);input.value='12345';input.oninput()
  await form.onsubmit({preventDefault(){}})
  const saved=JSON.parse(env.localStorage.getItem(STORAGE_KEY))
  assert.equal(saved.length,1);assert.equal(saved[0].dineIn,12345)
  env.app.querySelector('[data-backup]').click();await tick()
  assert.match(env.document.querySelector('.overlay').textContent,/1件/)
})
test('クラウド保存失敗で入力と画面を保持し、再保存成功で状態表示を更新する',async()=>{
  const env=await appHarness(),local=JSON.stringify([entry('2026-09-01')]);env.localStorage.setItem(STORAGE_KEY,local)
  let fail=true,snapshot={entries:[],revision:0}
  const store={uid:'alice',load:async()=>snapshot,save:async(token,data)=>{if(fail)throw new Error('通信失敗');snapshot={entries:[data],revision:token.revision+1};return snapshot}}
  await env.authChange({uid:'alice',email:'alice@example.com'},store)
  assert.match(env.app.querySelector('[data-account]').textContent,/alice@example.com/)
  assert.equal(env.app.querySelectorAll('[data-edit]').length,0)
  env.app.querySelector('[data-new]').click()
  const {form,input,overlay}=modalForm(env);input.value='9000';input.oninput()
  await form.onsubmit({preventDefault(){}})
  assert.equal(input.value,'9000');assert.equal(overlay.isConnected,true)
  assert.match(form.textContent,/保存失敗/)
  fail=false;await form.onsubmit({preventDefault(){}})
  assert.equal(overlay.isConnected,false)
  assert.match(env.app.querySelector('[data-cloud-status]').textContent,/クラウドへ保存済み/)
  assert.equal(env.localStorage.getItem(STORAGE_KEY),local)
})
test('初回クラウド取得失敗は0件と扱わず、入力を無効にする',async()=>{
  const env=await appHarness()
  await env.authChange({uid:'alice'},{uid:'alice',load:async()=>{throw new Error('offline')}})
  assert.match(env.app.querySelector('[data-cloud-status]').textContent,/読み込み失敗/)
  assert.equal(env.app.querySelector('[data-new]').disabled,true)
  assert.equal(env.app.querySelector('.stats').style.display,'none')
})
test('アカウント変更で旧データと入力画面を消し、他UIDに下書きを表示しない',async()=>{
  const env=await appHarness()
  await env.authChange({uid:'alice',email:'alice@example.com'},{uid:'alice',load:async()=>({entries:[entry('2026-10-01')],revision:1})})
  env.app.querySelector('[data-new]').click();const first=modalForm(env);first.input.value='999';first.input.oninput()
  await env.authChange({uid:'bob',email:'bob@example.com'},{uid:'bob',load:async()=>({entries:[],revision:0})})
  assert.equal(first.overlay.isConnected,false);assert.equal(env.app.querySelectorAll('[data-edit]').length,0)
  env.app.querySelector('[data-new]').click();assert.equal(modalForm(env).input.value,'')
})
test('サンプル表示をクラウド移行対象にしない',async()=>{
  const env=await appHarness();let writes=0
  await env.authChange({uid:'alice'},{uid:'alice',load:async()=>({entries:[],revision:0}),migrate:async()=>{writes++}})
  env.app.querySelector('[data-migrate]').click();await tick()
  assert.match(env.document.querySelector('.overlay').textContent,/サンプルは移行しません/)
  assert.equal(writes,0)
})
test('クラウドJSON復元は同意するまで書き込まず、元データを退避して全件置換する',async()=>{
  const env=await appHarness();let writes=0,snapshot={entries:[entry('2026-10-01')],revision:1}
  const store={uid:'alice',load:async()=>snapshot,replace:async(token,entries,confirmed)=>{assert.equal(confirmed,true);assert.equal(token.revision,1);writes++;snapshot={entries,revision:2};return snapshot}}
  await env.authChange({uid:'alice'},store)
  env.app.querySelector('[data-restore]').click()
  const overlay=env.document.querySelector('.overlay'),fileInput=overlay.querySelector('input')
  const backup=createBackup(JSON.stringify([entry('2026-09-01')]))
  const text=JSON.stringify(backup);fileInput.files=[{size:text.length,text:async()=>text}]
  await fileInput.onchange()
  const preview=overlay.querySelector('[data-preview]'),button=preview.querySelector('button.primary'),check=preview.querySelectorAll('input').find(input=>input.type==='checkbox')
  assert.equal(button.disabled,true);assert.equal(writes,0)
  assert.match(preview.textContent,/クラウド・全端末に反映/)
  check.checked=true;check.onchange();await button.onclick()
  assert.equal(writes,1);assert.match(overlay.textContent,/復元しました/)
  assert.deepEqual(snapshot.entries,[entry('2026-09-01')])
  const retired=parseJSON(env.localStorage.getItem('moka-cloud-before-restore-alice'))
  assert.deepEqual(retired.entries,[entry('2026-10-01')]);assert.equal(retired.source,'firestore')
})
function parseJSON(text){return JSON.parse(text)}
test('遅い旧アカウントの読み込み結果を新アカウントに表示しない',async()=>{
  const env=await appHarness();let resolve
  const delayed=new Promise(done=>{resolve=done})
  await env.authChange({uid:'alice'},{uid:'alice',load:()=>delayed})
  await env.authChange({uid:'bob',email:'bob@example.com'},{uid:'bob',load:async()=>({entries:[],revision:0})})
  resolve({entries:[entry('2026-10-01')],revision:1});await tick()
  assert.match(env.app.querySelector('[data-account]').textContent,/bob@example.com/)
  assert.equal(env.app.querySelectorAll('[data-edit]').length,0)
})
test('未保存入力を開き直して復元し、明示的に下書きを破棄できる',async()=>{
  const env=await appHarness()
  await env.authChange({uid:'alice'},{uid:'alice',load:async()=>({entries:[],revision:0}),save:async()=>{throw new Error('offline')}})
  env.app.querySelector('[data-new]').click();let modal=modalForm(env);modal.input.value='789';modal.input.oninput()
  await modal.form.onsubmit({preventDefault(){}})
  modal.overlay.querySelector('[data-close]').click()
  env.app.querySelector('[data-new]').click();modal=modalForm(env)
  assert.equal(modal.input.value,'789')
  const discard=modal.form.querySelectorAll('button').find(button=>button.textContent==='下書きを破棄')
  assert.ok(discard);discard.click()
  assert.equal(modalForm(env).input.value,'')
})
