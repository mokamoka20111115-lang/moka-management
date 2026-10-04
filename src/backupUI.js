import { createBackup, parseBackup, restoreBackup, summarize, STORAGE_KEY, MAX_FILE_BYTES } from './backup.js'

export function bindBackupControls(app, onRestore, storageOptions = {}) {
  app.querySelector('[data-backup]').onclick = () => openBackup(storageOptions)
  app.querySelector('[data-restore]').onclick = () => openRestore(onRestore, storageOptions)
}

function dialog(title) {
  const wrap = document.createElement('div')
  wrap.className = 'overlay'
  wrap.innerHTML = `<section class="modal backup-modal" role="dialog" aria-modal="true" aria-label="${title}"><header><h2>${title}</h2><button class="icon-btn" aria-label="閉じる" data-close>×</button></header><div class="modal-body"><div data-content></div><p role="status" aria-live="polite" data-status></p></div><footer><button class="ghost" data-close>キャンセル</button></footer></section>`
  const previousFocus = document.activeElement
  const cleanups = []
  const close = () => { if (wrap.dataset.saving === 'true') return; cleanups.forEach(fn => fn()); wrap.remove(); previousFocus?.focus() }
  wrap.querySelectorAll('[data-close]').forEach(button => button.onclick = close)
  wrap.onclick = event => { if (event.target === wrap) close() }
  wrap.onkeydown = event => {
    if (event.key === 'Escape') close()
    if (event.key === 'Tab') {
      const controls = [...wrap.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')].filter(el => !el.hidden)
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }
  document.body.append(wrap)
  wrap.querySelector('[data-close]').focus()
  return { wrap, content: wrap.querySelector('[data-content]'), status: wrap.querySelector('[data-status]'), cleanups, close }
}

const describe = entries => {
  const summary = summarize(entries)
  return `${summary.count}件 ／ ${summary.count ? `${summary.first} 〜 ${summary.last}` : '日付なし'}`
}
const warning = '以前のアプリで保存されたデータには、サンプルが含まれている可能性があります。自動判別・削除はしません。日付と金額を確認してください。'

function showRecords(content, entries) {
  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = '日付・金額を確認する'
  details.append(summary)
  const list = document.createElement('div')
  list.className = 'backup-records'
  for (const entry of entries) {
    const row = document.createElement('p')
    row.textContent = `${entry.date} ｜ 店内 ${entry.dineIn}円 ｜ Uber 注文/入金 ${entry.uberOrder}/${entry.uberPaid}円 ｜ 出前館 ${entry.demaeOrder}/${entry.demaePaid}円 ｜ Rocket ${entry.rocketOrder}/${entry.rocketPaid}円 ｜ 食材 ${entry.ingredients}円 ｜ 備品 ${entry.supplies}円`
    list.append(row)
  }
  details.append(list)
  content.append(details)
}

async function openBackup(options) {
  const ui = dialog('バックアップ')
  try {
    const state = options.read ? await options.read() : { raw: localStorage.getItem(STORAGE_KEY), source: 'localStorage' }
    if (!ui.wrap.isConnected) return
    const backup = createBackup(state.raw, new Date(), state.source)
    ui.content.innerHTML = `<p>${state.source === 'firestore' ? 'クラウドの全営業データ' : 'この端末の営業データ'}：${describe(backup.entries)}</p><p>${warning}</p><p>「ファイルに保存」を押し、共有画面の「ファイルに保存」を選んでください。共有できない場合は「ダウンロード」を使います。</p><button class="primary" data-share>ファイルに保存</button> <a class="ghost" data-download>ダウンロード</a>`
    showRecords(ui.content, backup.entries)
    const file = new File([JSON.stringify(backup, null, 2)], `moka-backup-${backup.exportedAt.replace(/[:.]/g, '-')}.json`, { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const link = ui.content.querySelector('[data-download]')
    link.href = url; link.download = file.name
    ui.cleanups.push(() => URL.revokeObjectURL(url))
    ui.content.querySelector('[data-share]').onclick = async () => {
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: 'MOKA営業データのバックアップ' })
          if (ui.wrap.isConnected) ui.status.textContent = '保存先でファイルが保存されていることを確認してください。'
        } else {
          link.click()
          ui.status.textContent = 'ダウンロード先を確認してください。JSONが開いた場合は共有メニューから「ファイルに保存」を選んでください。'
        }
      } catch (error) {
        ui.status.textContent = error.name === 'AbortError' ? '保存操作をキャンセルしました。' : '共有できませんでした。「ダウンロード」をお試しください。'
      }
    }
  } catch (error) { ui.status.textContent = error.message }
}

function openRestore(onRestore, options) {
  const ui = dialog('復元')
  ui.content.innerHTML = '<p>「ファイルを選ぶ」から保存したMOKAのJSONファイルを選んでください。選ぶだけではデータは変更されません。</p><input type="file" accept=".json,application/json" aria-label="復元するファイルを選ぶ"><div data-preview></div>'
  const input = ui.content.querySelector('input')
  const preview = ui.content.querySelector('[data-preview]')
  let request = 0
  input.onchange = async () => {
    const currentRequest = ++request
    preview.replaceChildren(); ui.status.textContent = ''
    const file = input.files[0]
    if (!file) return
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('ファイルは5MB以下にしてください。')
      const backup = parseBackup(await file.text())
      if (request !== currentRequest || !ui.wrap.isConnected) return
      const state = options.read ? await options.read() : { raw: localStorage.getItem(STORAGE_KEY), token: localStorage.getItem(STORAGE_KEY), source: 'localStorage' }
      if (request !== currentRequest || !ui.wrap.isConnected) return
      const expectedRaw = state.raw
      let existing = '保存済みデータなし'
      if (expectedRaw !== null) {
        try { existing = describe(JSON.parse(expectedRaw)) } catch { existing = '読み取れない保存データあり（上書き対象）' }
      }
      preview.innerHTML = `<p>復元するデータ：${describe(backup.entries)}</p><p>現在のデータ（${state.source === 'firestore' ? 'クラウド・全端末に反映' : 'この端末'}）：${existing}</p><p>${warning}</p><p>復元すると現在の記録全体を置き換えます。先に現在のデータをファイルへバックアップしてください。空のバックアップの場合は全記録が空になります。</p>`
      showRecords(preview, backup.entries)
      const label = document.createElement('label')
      label.className = 'restore-confirm'
      const check = document.createElement('input'); check.type = 'checkbox'
      label.append(check, document.createTextNode('内容を確認し、現在のデータを置き換えることに同意します'))
      const button = document.createElement('button'); button.className = 'primary'; button.textContent = '確認して復元する'; button.disabled = true
      preview.append(label, button)
      check.onchange = () => { button.disabled = !check.checked }
      button.onclick = async () => {
        if (!check.checked) return
        try {
          button.disabled = true; input.disabled = true; check.disabled = true; ui.wrap.dataset.saving = 'true'
          ui.status.textContent = '復元中です。画面を閉じずにお待ちください。'
          const entries = options.restore ? await options.restore(backup, state.token) : restoreBackup(localStorage, backup, { confirmed: check.checked, expectedRaw })
          ui.wrap.dataset.saving = 'false'
          onRestore(entries)
          input.disabled = true; button.disabled = true; check.disabled = true
          ui.status.textContent = '復元しました。ダッシュボードで内容を確認してください。'
        } catch (error) { ui.wrap.dataset.saving = 'false'; button.disabled = false; input.disabled = false; check.disabled = false; ui.status.textContent = `復元の完了を確認できませんでした。${error.message} クラウドの場合は最新データを読み込んで確認してください。 保存容量不足やブラウザの設定も確認してください。` }
      }
    } catch (error) {
      if (request === currentRequest && ui.wrap.isConnected) ui.status.textContent = error.message
    }
  }
}
