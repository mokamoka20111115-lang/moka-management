import test from 'node:test'
import assert from 'node:assert/strict'
import { numberFields, calculateMonth } from './calculations.js'
import { createBackup, parseBackup } from './backup.js'
import { createCloudStore, planMigration, assertWriteLimit, entryPath } from './cloudData.js'
const entry = (date, sales = 1000) => ({date,...Object.fromEntries(numberFields.map(key=>[key,key==='dineIn'?sales:0]))})
function database(initial = {}, options = {}) {
  let docs = new Map(Object.entries(initial).map(([key,value])=>[key,structuredClone(value)]))
  let calls = 0
  const api = {
    async get(path) { if(options.failRead)throw new Error('offline');return structuredClone(docs.get(path)) },
    async list(path) { if(options.failRead)throw new Error('offline');return [...docs].filter(([key])=>key.startsWith(path+'/')).map(([,value])=>structuredClone(value)) },
    async transaction(fn) {
      calls++
      const pending = new Map(docs)
      await fn({get:async path=>structuredClone(pending.get(path)),set:(path,value)=>pending.set(path,structuredClone(value)),delete:path=>pending.delete(path)})
      if(options.failWrite)throw new Error('offline')
      docs=pending
    },
  }
  return {api,read:path=>docs.get(path),calls:()=>calls}
}
const state='users/alice/state/current',path=date=>entryPath('alice',date)

test('ユーザーごとの保存先を使い、別UIDの記録を読み込まない',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01'),'users/bob/entries/2026-10-02':entry('2026-10-02')})
  assert.deepEqual((await createCloudStore(db.api,'alice').load()).entries,[entry('2026-10-01')])
  assert.throws(()=>entryPath('alice/bob','2026-10-01'))
})
test('クラウドの空データは空のままでサンプルを生成しない',async()=>{
  const db=database()
  assert.deepEqual(await createCloudStore(db.api,'alice').load(),{entries:[],revision:0})
  assert.equal(db.calls(),0)
})
test('保存後に他の端末から同じ記録と更新番号を読み込める',async()=>{
  const db=database(),iphone=createCloudStore(db.api,'alice'),pc=createCloudStore(db.api,'alice')
  const saved=await iphone.save(await iphone.load(),entry('2026-10-04'),null)
  assert.deepEqual(await pc.load(),saved)
  assert.equal(db.read(state).revision,1)
  assert.deepEqual(calculateMonth(saved.entries),{sales:1000,costs:0,fees:0,grossProfit:1000})
})
test('別端末の先行更新を上書きせず拒否する',async()=>{
  const db=database(),a=createCloudStore(db.api,'alice'),b=createCloudStore(db.api,'alice')
  const old=await a.load()
  await b.save(await b.load(),entry('2026-10-04',2000),null)
  await assert.rejects(()=>a.save(old,entry('2026-10-04',3000),null),/他の端末/)
  assert.equal(db.read(path('2026-10-04')).dineIn,2000)
})
test('同じ日付への新規入力と日付移動の衝突を拒否する',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01'),[path('2026-10-02')]:entry('2026-10-02')})
  const store=createCloudStore(db.api,'alice'),snapshot=await store.load()
  await assert.rejects(()=>store.save(snapshot,entry('2026-10-02',2000),null),/変更先/)
  await assert.rejects(()=>store.save(snapshot,entry('2026-10-02',2000),'2026-10-01'),/変更先/)
  assert.equal(db.calls(),0)
})
test('営業日の変更を原子的に処理する',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01')})
  const store=createCloudStore(db.api,'alice')
  await store.save(await store.load(),entry('2026-10-02'),'2026-10-01')
  assert.equal(db.read(path('2026-10-01')),undefined)
  assert.deepEqual(db.read(path('2026-10-02')),entry('2026-10-02'))
})
test('移行は既存同一データを飛ばし、新規だけ保存して再実行で重複しない',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01')})
  const store=createCloudStore(db.api,'alice'),local=[entry('2026-10-01'),entry('2026-10-02')],original=JSON.stringify(local)
  const plan=planMigration(local,(await store.load()).entries)
  assert.equal(plan.additions.length,1);assert.equal(plan.unchanged.length,1)
  await store.migrate(await store.load(),local)
  const count=db.calls()
  await store.migrate(await store.load(),local)
  assert.equal(db.calls(),count);assert.equal((await store.load()).entries.length,2)
  assert.equal(JSON.stringify(local),original)
})
test('移行の金額競合は一部の新規記録も含め何も保存しない',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01',2000)})
  const store=createCloudStore(db.api,'alice')
  await assert.rejects(()=>store.migrate({entries:[entry('2026-10-01',2000)],revision:0},[entry('2026-10-01'),entry('2026-10-02')]),/金額が違う/)
  assert.equal(db.calls(),0);assert.equal(db.read(path('2026-10-02')),undefined)
})
test('確認後に追加された同日記録を移行で上書きしない',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01',2000)})
  const store=createCloudStore(db.api,'alice')
  await assert.rejects(()=>store.migrate({entries:[],revision:0},[entry('2026-10-01')]),/追加されています/)
  assert.equal(db.read(path('2026-10-01')).dineIn,2000)
})
test('通信失敗時に元の記録、更新番号、入力オブジェクトが変わらない',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01'),[state]:{revision:1}},{failWrite:true})
  const store=createCloudStore(db.api,'alice'),snapshot=await store.load(),input=entry('2026-10-02')
  await assert.rejects(()=>store.save(snapshot,input,null),/offline/)
  assert.equal(db.read(path('2026-10-02')),undefined);assert.equal(db.read(state).revision,1)
  assert.deepEqual(input,entry('2026-10-02'));assert.equal(snapshot.entries.length,1)
})
test('取得失敗を空のデータと扱わない',async()=>{
  const db=database({}, {failRead:true})
  await assert.rejects(()=>createCloudStore(db.api,'alice').load(),/offline/)
})
test('確認付き全件復元と空の復元、旧JSONとクラウドJSONの互換性',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01')})
  const store=createCloudStore(db.api,'alice')
  const old=parseBackup(JSON.stringify(createBackup(JSON.stringify([entry('2026-09-01')]))))
  await assert.rejects(()=>store.replace({entries:[entry('2026-10-01')],revision:0},old.entries,false),/確認/)
  const restored=await store.replace(await store.load(),old.entries,true)
  assert.equal(db.read(path('2026-10-01')),undefined)
  const cloud=parseBackup(JSON.stringify(createBackup(JSON.stringify(restored.entries),new Date(),'firestore')))
  assert.deepEqual(cloud.entries,old.entries)
  await store.replace(await store.load(),[],true)
  assert.deepEqual((await store.load()).entries,[])
})
test('復元中の通信失敗や確認後の競合で元のクラウド記録を保持する',async()=>{
  const db=database({[path('2026-10-01')]:entry('2026-10-01')},{failWrite:true})
  const store=createCloudStore(db.api,'alice')
  await assert.rejects(async()=>store.replace(await store.load(),[entry('2026-10-02')],true),/offline/)
  assert.deepEqual(db.read(path('2026-10-01')),entry('2026-10-01'));assert.equal(db.read(path('2026-10-02')),undefined)
  await assert.rejects(()=>store.replace({entries:[],revision:99},[],true),/他の端末/)
})
test('大量の一括書き込みは実行前に止め、不正な営業日や金額を拒否する',async()=>{
  assert.throws(()=>assertWriteLimit(401),/400件/)
  const db=database(),store=createCloudStore(db.api,'alice')
  await assert.rejects(()=>store.save({entries:[],revision:0},entry('2026-02-29'),null))
  await assert.rejects(()=>store.save({entries:[],revision:0},entry('2026-10-01',-1),null))
  assert.equal(db.calls(),0)
})
test('読み込み中の更新を検出して整合したスナップショットを取り直す',async()=>{
  let revision=0
  const api={get:async()=>({revision}),list:async()=>{revision++;return []}}
  await assert.rejects(()=>createCloudStore(api,'alice').load(),/読み込み中/)
})
test('400件を超える移行・全件復元はトランザクション開始前に拒否する',async()=>{
  const entries=Array.from({length:401},(_,i)=>entry(new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10)))
  const db=database(),store=createCloudStore(db.api,'alice'),snapshot=await store.load()
  await assert.rejects(()=>store.migrate(snapshot,entries),/400件/)
  await assert.rejects(()=>store.replace(snapshot,entries,true),/400件/)
  assert.equal(db.calls(),0)
})
