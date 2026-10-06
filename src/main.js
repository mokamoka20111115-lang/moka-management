import { calculateDay, calculateMonth, emptyEntry, localDate, numberFields } from './calculations.js'
import { bindBackupControls } from './backupUI.js'
import { openMigration } from './migrationUI.js'
import { validateEntries, createBackup, STORAGE_KEY } from './backup.js'
import { bindModalViewport } from './modalViewport.js'
import { moveMonth } from './monthNavigation.js'

const yen=n=>`¥${Math.round(n).toLocaleString('ja-JP')}`, pct=n=>`${n.toFixed(1)}%`, currentMonth=localDate().slice(0,7)
const seed=[
  [1,48500,12800,8960,8200,6150,4300,3440,15200,2100],[2,42000,9500,6650,6800,5100,3600,2880,13800,1600],[3,56700,15200,10640,9200,6900,5100,4080,18100,2400],[4,39800,8800,6160,7100,5325,2900,2320,12100,1200],[5,61200,18400,12880,10500,7875,6200,4960,21200,3200],[6,58400,16600,11620,9800,7350,5400,4320,19500,2800],[7,36200,7900,5530,5900,4425,2500,2000,11000,900]
].map(v=>Object.fromEntries(['date',...numberFields].map((k,i)=>[k,i? v[i]:`${currentMonth}-${String(v[0]).padStart(2,'0')}`])))
let entries=[], demo=false, localValid=true, month=currentMonth
let user=null, cloud=null, snapshot=null, authClient=null, authLoading=true, status='この端末に保存しています', session=0, reloadRequest=0, busy=false
const drafts=new Map()
function loadLocal(){
  try { localValid=true;const raw=localStorage.getItem(STORAGE_KEY);demo=raw===null;entries=demo?seed:validateEntries(JSON.parse(raw)) }
  catch{entries=[];demo=false;localValid=false;status='この端末の保存データを読み取れません。元データは変更していません。バックアップ・復元から確認してください。'}
}
loadLocal()
const errorMessage=error=>{
  if(error.code==='permission-denied')return 'アクセスが拒否されました。FirebaseのFirestoreルールを確認してください。'
  if(error.code==='auth/unauthorized-domain')return 'Firebaseの承認済みドメインにこのサイトを追加してください。'
  if(error.code==='auth/popup-blocked')return 'ログイン画面が開けません。Safariでこのサイトを開き、もう一度ログインしてください。'
  if(error.code==='auth/popup-closed-by-user')return 'ログインをキャンセルしました。'
  return error.message||'通信に失敗しました。インターネット接続を確認してください。'
}
async function reloadCloud(){
  const active=session, request=++reloadRequest, store=cloud
  if(!store)return
  status='クラウドから読み込み中…';render()
  try{const result=await store.load();if(active!==session||request!==reloadRequest)return;snapshot=result;entries=result.entries;demo=false;status='クラウドの最新データを読み込みました';render()}
  catch(error){if(active!==session||request!==reloadRequest)return;status='読み込み失敗：'+errorMessage(error);render()}
}
function cloudBackupOptions(){
  const active=session, store=cloud
  const ensure=()=>{if(active!==session||!store)throw new Error('ログイン状態が変わりました。操作をやり直してください。')}
  return {
    async read(){ensure();const token=await store.load();ensure();return {raw:JSON.stringify(token.entries),token,source:'firestore'}},
    async restore(backup,token){
      ensure();busy=true
      try{
        // ブラウザ内にUID別の復元前バックアップを保存。退避失敗時はクラウドを変更しない。
        localStorage.setItem('moka-cloud-before-restore-'+store.uid,JSON.stringify(createBackup(JSON.stringify(token.entries),new Date(),'firestore')))
        const result=await store.replace(token,backup.entries,true);ensure();snapshot=result
        const verified=await store.load();ensure()
        if(JSON.stringify(verified.entries)!==JSON.stringify(result.entries))throw new Error('保存後に別の更新がありました。最新データを確認してください。')
        snapshot=verified;entries=verified.entries;status='クラウドへ復元済み';return verified.entries
      }finally{busy=false;const button=app.querySelector('[data-auth]');if(button)button.disabled=authLoading}
    },
  }
}
const app=document.querySelector('#app')
const icon=(name)=>`<span class="ui-icon" aria-hidden="true">${({coffee:'☕',chart:'▥',calendar:'▦',store:'⌂',plus:'＋',wallet:'¥',edit:'✎',close:'×'}[name])}</span>`
const stat=(label,value,sub,tone='')=>`<article class="stat ${tone}"><div class="stat-label">${label}</div><strong>${value}</strong><small>${sub}</small></article>`

function chart(data){const vals=data.map(e=>calculateDay(e).sales),max=Math.max(...vals,1),x=i=>data.length===1?50:i/(data.length-1)*100, pts=vals.map((v,i)=>`${x(i)},${92-v/max*78}`).join(' ');return `<div class="chart-wrap"><div class="chart-y"><span>${yen(max)}</span><span>${yen(max/2)}</span><span>¥0</span></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="日別売上推移"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bf5b3f" stop-opacity=".28"/><stop offset="1" stop-color="#bf5b3f" stop-opacity="0"/></linearGradient></defs><path d="M 0,92 L ${pts} L 100,92 Z" fill="url(#area)"/><polyline points="${pts}" fill="none" stroke="#ad4c32" stroke-width="2.3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${vals.map((v,i)=>`<circle cx="${x(i)}" cy="${92-v/max*78}" r="1.5" fill="#fff" stroke="#ad4c32" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}</svg><div class="chart-x">${data.map(e=>`<span>${+e.date.slice(8)}日</span>`).join('')}</div></div>`}

function render(){const data=entries.filter(e=>e.date.startsWith(month)).sort((a,b)=>a.date.localeCompare(b.date)), totals=calculateMonth(data), costRate=totals.sales?totals.costs/totals.sales*100:0, delivery=data.reduce((s,e)=>s+calculateDay(e).deliverySales,0), target=Math.min(totals.sales/10000,100), label=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long'}).format(new Date(`${month}-01T00:00:00`));app.innerHTML=`
<aside><div class="brand"><div>${icon('coffee')}</div><span>CAFE REST<br><b>MOKA</b></span></div><nav><a class="active">${icon('chart')}ダッシュボード</a><a>${icon('calendar')}営業データ</a></nav><div class="aside-foot">${icon('store')}<span>カフェレスト モカ<small>経営管理システム</small></span></div></aside>
<main><section class="cloud-tools"><p data-account></p><button class="ghost" data-auth ${authLoading||busy?'disabled':''}>${user?'ログアウト':'Googleでログイン'}</button>${user?'<button class="ghost" data-reload>最新データを読み込む</button><button class="ghost" data-migrate>この端末の記録をクラウドへ移行</button>':''}<p role="status" aria-live="polite" data-cloud-status></p></section><header class="top"><div><span class="eyebrow">MANAGEMENT DASHBOARD</span><h1>月間ダッシュボード</h1><p>今日も一日、おつかれさまです。</p></div><button class="primary add" data-new>${icon('plus')}営業データを入力</button></header>
<section class="backup-tools"><button class="ghost" data-backup>バックアップ</button><button class="ghost" data-restore>復元</button><p>${user ? 'ログイン中のアカウントのクラウドデータを表示しています。バックアップ・復元は全営業記録が対象です。' : demo ? 'サンプル表示です。サンプルはバックアップされません。最初の入力保存から実際の記録を開始します。' : '保存済みデータを表示しています。以前の記録にはサンプルが含まれる可能性があるため、バックアップ前に内容をご確認ください。'}</p></section>
<section class="month-nav"><button data-move="-1">‹</button><strong>${label}</strong><button data-move="1">›</button></section>
<section class="stats">${stat('月間累計売上',yen(totals.sales),`${data.length}日分の営業データ`,'main-stat')}${stat('原価',yen(totals.costs),`原価率 ${pct(costRate)}`)}${stat('粗利益',yen(totals.grossProfit),`粗利率 ${pct(totals.sales?totals.grossProfit/totals.sales*100:0)}`,'profit')}${stat('デリバリー手数料',yen(totals.fees),`手数料率 ${pct(delivery?totals.fees/delivery*100:0)}`)}</section>
<section class="target"><div class="target-icon">${icon('wallet')}</div><div class="target-copy"><span>月商目標 <b>¥1,000,000</b></span><strong>あと ${yen(Math.max(1000000-totals.sales,0))}</strong><div class="progress"><i style="width:${target}%"></i></div></div><div class="rate"><strong>${pct(target)}</strong><span>達成率</span></div></section>
<section class="dashboard-grid"><article class="panel chart-panel"><header><div><span class="eyebrow">SALES TREND</span><h2>日別売上推移</h2></div><span class="legend"><i></i>総売上</span></header>${data.length?chart(data):'<div class="empty">この月のデータはまだありません</div>'}</article>
<article class="panel records"><header><div><span class="eyebrow">RECENT RECORDS</span><h2>営業データ</h2></div></header><div class="record-list">${data.length?data.slice().reverse().map(e=>{const d=calculateDay(e);return `<button data-edit="${e.date}"><span class="date-badge"><b>${+e.date.slice(8)}</b><small>日</small></span><span class="record-money"><small>総売上</small><b>${yen(d.sales)}</b></span><span class="record-profit"><small>粗利益</small><b>${yen(d.grossProfit)}</b></span>${icon('edit')}</button>`}).join(''):'<div class="empty">データを入力してください</div>'}</div></article></section></main>`
  app.querySelector('[data-account]').textContent=user?`ログイン中：${user.email||user.displayName||user.uid}`:'未ログイン：この端末の記録を表示しています'
  app.querySelector('[data-cloud-status]').textContent=status
  app.querySelector('[data-auth]').onclick=()=>{
    if(!authClient){status='ログイン機能を再読み込みしてください。ローカル機能は引き続き使えます。';render();return}
    if(document.querySelector('.overlay')){alert('入力・復元画面を閉じてからログアウトしてください。');return}
    const promise=user?authClient.logout():authClient.login()
    promise.catch(error=>{status=errorMessage(error);render()})
  }
  if(user){
    app.querySelector('[data-reload]').onclick=reloadCloud
    app.querySelector('[data-migrate]').onclick=()=>{
      const active=session,store=cloud
      openMigration(()=>store.load(),async(token,local)=>{
        if(active!==session)throw new Error('ログイン状態が変わりました。')
        busy=true
        try{
          const result=await store.migrate(token,local)
          const verified=await store.load()
          if(active!==session)throw new Error('ログイン状態が変わりました。')
          const byDate=new Map(verified.entries.map(entry=>[entry.date,entry]))
          for(const entry of result.entries){if(JSON.stringify(byDate.get(entry.date))!==JSON.stringify(entry))throw new Error('保存後の内容が変わりました。最新データを確認してください。')}
          snapshot=verified;entries=verified.entries;demo=false;status='クラウドへ移行済み';busy=false;render()
        }finally{busy=false;const button=app.querySelector('[data-auth]');if(button)button.disabled=authLoading}
      },()=>active===session)
    }
  }
  bindBackupControls(app, restored=>{entries=restored;demo=false;localValid=true;month=restored.at(-1)?.date.slice(0,7)||currentMonth;render()},user?cloudBackupOptions():{})
  if(user&&!snapshot){for(const selector of ['.stats','.target','.dashboard-grid'])app.querySelector(selector).style.display='none'}
  app.querySelector('[data-new]').disabled=user?!snapshot:!localValid
  app.querySelectorAll('[data-edit]').forEach(button=>button.disabled=!!user&&!snapshot)
  app.querySelector('[data-new]').onclick=()=>openModal(emptyEntry(),true);app.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>{month=moveMonth(month,Number(b.dataset.move));render()});app.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openModal(demo?emptyEntry(b.dataset.edit):entries.find(e=>e.date===b.dataset.edit)))
}
const money=(label,name,value)=>`<label class="money-input"><span>${label}</span><div><b>¥</b><input inputmode="numeric" name="${name}" value="${value||''}" placeholder="0"></div></label>`
function openModal(initial,newRecord=false){const originalInitial=initial;const active=session,store=cloud,token=snapshot,draftKey=user?.uid||'local';const pendingDraft=drafts.get(draftKey);const draft=pendingDraft&&(newRecord||pendingDraft.oldDate===initial.date)?pendingDraft:null;initial=draft?.entry||initial;const oldDate=draft?draft.oldDate:(newRecord?null:initial.date), wrap=document.createElement('div');wrap.className='overlay entry-overlay';wrap.innerHTML=`<div class="modal entry-modal"><header><div><span class="eyebrow">DAILY RECORD</span><h2>営業データを入力</h2></div><button class="icon-btn" data-close aria-label="閉じる">${icon('close')}</button></header><form><div class="modal-body"><label class="date-field">${icon('calendar')}<span>営業日</span><input name="date" type="date" value="${initial.date}" required></label>
${group('店内売上','rust',money('店内での売上','dineIn',initial.dineIn))}${group('デリバリー売上','gold',[['Uber Eats','uber'],['出前館','demae'],['Rocket Now','rocket']].map(([label,key])=>`<div class="delivery-row"><strong>${label}</strong>${money('注文売上',key+'Order',initial[key+'Order'])}${money('実入金',key+'Paid',initial[key+'Paid'])}</div>`).join(''))}${group('経費','green',`<div class="two-col">${money('食材仕入','ingredients',initial.ingredients)}${money('備品・消耗品','supplies',initial.supplies)}</div>`)}<div class="preview"><span>この日の総売上<strong data-sales>¥0</strong></span><span>粗利益<strong data-profit>¥0</strong></span></div></div><footer><button type="button" class="ghost" data-close>キャンセル</button><button class="primary">保存する</button></footer></form></div>`;document.body.append(wrap);const disposeViewport=bindModalViewport(wrap);const form=wrap.querySelector('form'),close=()=>{if(wrap.dataset.saving==='true')return;disposeViewport();wrap.remove()},update=()=>{const data=Object.fromEntries(new FormData(form));wrap.querySelector('[data-sales]').textContent=yen(calculateDay(data).sales);wrap.querySelector('[data-profit]').textContent=yen(calculateDay(data).grossProfit)};wrap.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);wrap.onclick=e=>{if(e.target===wrap)close()};form.querySelectorAll('input').forEach(i=>{i.oninput=()=>{if(i.type!=='date')i.value=i.value.replace(/\D/g,'');drafts.set(draftKey,{entry:Object.fromEntries(new FormData(form)),oldDate});update()}});form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));numberFields.forEach(k=>data[k]=Number(data[k])||0);if(active!==session){alert('ログイン状態が変わりました。入力はアカウント別の下書きとして保持しています。');return}
const saveButton=form.querySelector('button.primary');if(saveButton.disabled)return;saveButton.disabled=true;busy=true;wrap.dataset.saving='true'
const message=document.createElement('p');message.setAttribute('role','status');message.textContent='保存中…';form.querySelector('.modal-body').append(message)
try{
  validateEntries([data])
  if(store){
    const result=await store.save(token,data,oldDate)
    if(active!==session)return
    snapshot=result;entries=result.entries;status='クラウドへ保存済み'
  }else{
    if(!localValid)throw new Error('元の保存データを読み取れないため、上書きせず中止しました。')
    const next=(demo?[]:entries).filter(x=>x.date!==oldDate&&x.date!==data.date).concat(data).sort((a,b)=>a.date.localeCompare(b.date))
    localStorage.setItem(STORAGE_KEY,JSON.stringify(next));entries=next;status='この端末に保存済み'
  }
  wrap.dataset.saving='false';drafts.delete(draftKey);demo=false;month=data.date.slice(0,7);close();busy=false;render()
}catch(error){wrap.dataset.saving='false';message.textContent='保存失敗：'+errorMessage(error)+' 入力は残っています。';saveButton.disabled=false}
finally{busy=false;const button=app.querySelector('[data-auth]');if(button)button.disabled=authLoading}};if(draft){const note=document.createElement('p');note.textContent='前回の未保存の入力を表示しています。';form.querySelector('.modal-body').append(note);const discard=document.createElement('button');discard.type='button';discard.textContent='下書きを破棄';discard.className='ghost';discard.onclick=()=>{if(wrap.dataset.saving==='true')return;drafts.delete(draftKey);close();openModal(originalInitial,newRecord)};form.querySelector('.modal-body').append(discard)}update();form.querySelector('input').focus()}
const group=(title,color,content)=>`<section class="input-group"><h3><span class="dot ${color}"></span>${title}</h3>${content}</section>`
render()

// SDK準備前はログインだけ無効。既存のローカル画面はすぐ表示する。
import('./firebaseClient.js').then(module=>module.initializeFirebase((nextUser,store)=>{
  if(user?.uid===nextUser?.uid&&cloud)return
  session++;reloadRequest++;busy=false
  document.querySelectorAll('.overlay').forEach(element=>element.remove())
  user=nextUser;cloud=store;snapshot=null;entries=[];demo=false
  if(user){status='クラウドへ接続しています';reloadCloud()}
  else{status='この端末に保存しています';loadLocal();render()}
})).then(client=>{authClient=client;authLoading=false;render()}).catch(error=>{
  authLoading=false;status='Googleログインの準備に失敗しました。再読み込みをお試しください。ローカル機能は使えます。';render()
})
