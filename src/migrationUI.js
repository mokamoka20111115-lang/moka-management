import { STORAGE_KEY, summarize, validateEntries } from './backup.js'
import { planMigration } from './cloudData.js'

export async function openMigration(read, migrate, sessionValid) {
  const wrap = document.createElement('div')
  wrap.className = 'overlay'
  wrap.innerHTML = '<section class="modal backup-modal" role="dialog" aria-modal="true" aria-label="クラウドへ移行"><header><h2>この端末の記録をクラウドへ移行</h2></header><div class="modal-body"><div data-preview></div><p role="status" data-status>内容を確認しています…</p></div><footer><button class="ghost" data-close>キャンセル</button></footer></section>'
  document.body.append(wrap)
  wrap.querySelector('[data-close]').onclick = () => wrap.remove()
  const status = wrap.querySelector('[data-status]'), preview = wrap.querySelector('[data-preview]')
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) throw new Error('この端末に保存済みの記録はありません。表示用サンプルは移行しません。')
    const local = validateEntries(JSON.parse(raw))
    const snapshot = await read()
    if (!sessionValid() || !wrap.isConnected) return
    const plan = planMigration(local, snapshot.entries), summary = summarize(local)
    const text = document.createElement('p')
    text.textContent = `${summary.count}件 ／ ${summary.first || '日付なし'} 〜 ${summary.last || '日付なし'}。新規 ${plan.additions.length}件、同一内容 ${plan.unchanged.length}件、金額が違う日付 ${plan.conflicts.length}件。`
    preview.append(text)
    const note = document.createElement('p')
    note.textContent = '先にJSONバックアップを保存してください。以前の保存データにはサンプルが含まれる可能性があります。下の日付・金額を確認してください。クラウドの既存記録は上書きせず、この端末の元データも削除しません。'
    preview.append(note)
    const details = document.createElement('details'), heading = document.createElement('summary')
    heading.textContent = '移行対象の日付・金額を確認する'; details.append(heading)
    const list = document.createElement('div'); list.className = 'backup-records'
    for (const entry of local) {
      const row = document.createElement('p'); row.textContent = Object.entries(entry).map(([key, value]) => `${({date:'営業日',dineIn:'店内売上',uberOrder:'Uber注文',uberPaid:'Uber入金',demaeOrder:'出前館注文',demaePaid:'出前館入金',rocketOrder:'Rocket注文',rocketPaid:'Rocket入金',ingredients:'食材',supplies:'備品'}[key])}：${value}`).join(' ／ '); list.append(row)
    }
    details.append(list); preview.append(details)
    if (plan.conflicts.length) throw new Error(`次の日付はクラウドと金額が違います：${plan.conflicts.join('、')}。移行は実行しません。`)
    if (!plan.additions.length) { status.textContent = '追加する記録はありません。'; return }
    const label = document.createElement('label'); label.className = 'restore-confirm'
    const check = document.createElement('input'); check.type = 'checkbox'
    label.append(check, document.createTextNode('日付・金額とログイン中のアカウントを確認し、移行に同意します'))
    const button = document.createElement('button'); button.className = 'primary'; button.textContent = '確認して移行する'; button.disabled = true
    preview.append(label, button); status.textContent = ''
    check.onchange = () => { button.disabled = !check.checked }
    button.onclick = async () => {
      if (!check.checked || !sessionValid()) return
      button.disabled = true; check.disabled = true; wrap.querySelector('[data-close]').disabled = true
      status.textContent = '移行中です。画面を閉じずにお待ちください。'
      try {
        if (localStorage.getItem(STORAGE_KEY) !== raw) throw new Error('この端末の記録が変わりました。移行画面を開き直してください。')
        await migrate(snapshot, local)
        status.textContent = 'クラウドへ保存し、サーバーから内容を確認しました。元のデータはこの端末に残しています。'
        wrap.querySelector('[data-close]').disabled = false
      } catch (error) {
        wrap.querySelector('[data-close]').disabled = false
        status.textContent = `移行の完了を確認できませんでした。${error.message} 元のデータは残っています。最新データを読み込み、再度移行してください。`
      }
    }
  } catch (error) { status.textContent = error.message }
}
