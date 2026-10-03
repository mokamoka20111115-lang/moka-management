import { numberFields } from './calculations.js'
export const STORAGE_KEY = 'moka-entries-v1'
export const PRE_RESTORE_KEY = 'moka-before-restore-v1'
export const MAX_FILE_BYTES = 5 * 1024 * 1024

export function validateEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('営業データの形式が正しくありません。')
  const seen = new Set()
  const result = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).length !== numberFields.length + 1 ||
        typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error('営業データの項目や日付が正しくありません。')
    const date = new Date(`${entry.date}T00:00:00Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.date || seen.has(entry.date)) {
      throw new Error('存在しない日付、または同じ日付の重複があります。')
    }
    seen.add(entry.date)
    const clean = { date: entry.date }
    for (const field of numberFields) {
      if (!Number.isSafeInteger(entry[field]) || entry[field] < 0) throw new Error('金額は0以上の整数である必要があります。')
      clean[field] = entry[field]
    }
    return clean
  })
  return result.sort((a, b) => a.date.localeCompare(b.date))
}

export function summarize(entries) {
  const sorted = validateEntries(entries)
  return { count: sorted.length, first: sorted[0]?.date || null, last: sorted.at(-1)?.date || null }
}

export function createBackup(raw, now = new Date()) {
  // 表示用サンプルではなく、保存されている値だけを読み取る。
  if (raw === null) throw new Error('保存済みの営業データがありません。表示中のサンプルはバックアップしません。')
  let entries
  try { entries = JSON.parse(raw) } catch { throw new Error('保存データが読めません。元のデータは変更していません。') }
  return { format: 'moka-management-backup', version: 1, exportedAt: now.toISOString(),
    source: 'localStorage', sampleStatus: 'unverified', entries: validateEntries(entries) }
}

export function parseBackup(text) {
  if (new Blob([text]).size > MAX_FILE_BYTES) throw new Error('ファイルは5MB以下にしてください。')
  let data
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('JSONファイルを読み取れません。') }
  if (!data || data.format !== 'moka-management-backup' || data.version !== 1 ||
      data.source !== 'localStorage' || data.sampleStatus !== 'unverified' ||
      typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt))) {
    throw new Error('このアプリのバックアップファイルではないか、未対応の形式です。')
  }
  return { ...data, entries: validateEntries(data.entries) }
}

export function restoreBackup(storage, backup, { confirmed = false, expectedRaw } = {}) {
  if (!confirmed) throw new Error('内容と上書きの確認が必要です。')
  const checked = parseBackup(JSON.stringify(backup))
  const before = storage.getItem(STORAGE_KEY)
  if (before !== expectedRaw) throw new Error('確認中に保存データが変わりました。もう一度ファイルを選んでください。')
  // setItemは失敗時に既存の値を変えない。退避に失敗した場合も上書きしない。
  storage.setItem(PRE_RESTORE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), raw: before }))
  storage.setItem(STORAGE_KEY, JSON.stringify(checked.entries))
  return checked.entries
}
