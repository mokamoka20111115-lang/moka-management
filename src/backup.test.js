import test from 'node:test'
import assert from 'node:assert/strict'
import { numberFields, calculateMonth } from './calculations.js'
import { createBackup, parseBackup, restoreBackup, summarize, STORAGE_KEY, PRE_RESTORE_KEY, MAX_FILE_BYTES } from './backup.js'
const entry = date => ({ date, ...Object.fromEntries(numberFields.map((key, i) => [key, i * 100])) })
const records = [entry('2026-10-03'), entry('2025-12-31')]
const raw = JSON.stringify(records)
const backup = () => createBackup(raw, new Date('2026-10-03T12:00:00Z'))
function storage(initial = raw, failKey) {
  const values = new Map(initial === null ? [] : [[STORAGE_KEY, initial]])
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => {
    if (key === failKey) throw new Error('容量不足')
    values.set(key, value)
  } }
}

test('JSON書き出しと読み込みで全項目・計算結果が保持される', () => {
  const result = parseBackup(JSON.stringify(backup()))
  assert.deepEqual(result.entries, [...records].reverse())
  assert.deepEqual(calculateMonth(result.entries), calculateMonth(records))
  assert.equal(result.sampleStatus, 'unverified')
  assert.equal(result.exportedAt, '2026-10-03T12:00:00.000Z')
  assert.equal(raw, JSON.stringify(records))
})
test('件数と日付範囲、空データを正しく要約する', () => {
  assert.deepEqual(summarize(records), { count: 2, first: '2025-12-31', last: '2026-10-03' })
  assert.deepEqual(summarize([]), { count: 0, first: null, last: null })
  assert.deepEqual(parseBackup(JSON.stringify(createBackup('[]'))).entries, [])
})
test('保存されていない表示用サンプルをバックアップしない', () => {
  assert.throws(() => createBackup(null), /サンプル/)
})
test('不正JSON・別用途ファイル・未対応版を拒否する', () => {
  for (const text of ['{', 'null', '[]', raw, '{}', JSON.stringify({ ...backup(), version: 2 }), JSON.stringify({ ...backup(), format: 'other' })]) {
    assert.throws(() => parseBackup(text))
  }
  assert.throws(() => createBackup('{'))
  assert.deepEqual(parseBackup('\uFEFF' + JSON.stringify(backup())).entries, [...records].reverse())
})
test('日付・金額・項目・重複を検証し、うるう年に対応する', () => {
  for (const item of [entry('2026-02-29'), entry('2026-13-01'), entry('<script>'), { ...entry('2026-10-03'), dineIn: -1 },
    { ...entry('2026-10-03'), dineIn: '100' }, { ...entry('2026-10-03'), dineIn: 0.5 },
    { ...entry('2026-10-03'), dineIn: Number.MAX_SAFE_INTEGER + 1 }, { ...entry('2026-10-03'), extra: true },
    { date: '2026-10-03' }, null]) {
    assert.throws(() => parseBackup(JSON.stringify({ ...backup(), entries: [item] })))
  }
  assert.throws(() => parseBackup(JSON.stringify({ ...backup(), entries: [records[0], records[0]] })), /重複/)
  assert.equal(parseBackup(JSON.stringify({ ...backup(), entries: [entry('2024-02-29')] })).entries.length, 1)
})
test('大きすぎるファイルを拒否する', () => {
  assert.throws(() => parseBackup(' '.repeat(MAX_FILE_BYTES + 1)), /5MB/)
})
test('未確認と確認中のデータ変更では何も上書きしない', () => {
  const store = storage()
  assert.throws(() => restoreBackup(store, backup(), { expectedRaw: raw }), /確認/)
  assert.equal(store.getItem(STORAGE_KEY), raw)
  assert.equal(store.getItem(PRE_RESTORE_KEY), null)
  assert.throws(() => restoreBackup(store, backup(), { confirmed: true, expectedRaw: '[]' }), /変わりました/)
  assert.equal(store.getItem(STORAGE_KEY), raw)
})
test('確認後だけ復元し、直前のデータを退避する', () => {
  const store = storage('[]')
  const result = restoreBackup(store, backup(), { confirmed: true, expectedRaw: '[]' })
  assert.deepEqual(JSON.parse(store.getItem(STORAGE_KEY)), result)
  assert.equal(JSON.parse(store.getItem(PRE_RESTORE_KEY)).raw, '[]')
  const empty = storage(null)
  restoreBackup(empty, backup(), { confirmed: true, expectedRaw: null })
  assert.equal(JSON.parse(empty.getItem(PRE_RESTORE_KEY)).raw, null)
})
test('退避または復元の保存が失敗しても元データが残る', () => {
  for (const key of [PRE_RESTORE_KEY, STORAGE_KEY]) {
    const store = storage(raw, key)
    assert.throws(() => restoreBackup(store, backup(), { confirmed: true, expectedRaw: raw }), /容量不足/)
    assert.equal(store.getItem(STORAGE_KEY), raw)
  }
})
test('不正な復元内容は確認済みでも保存しない', () => {
  const store = storage()
  assert.throws(() => restoreBackup(store, { ...backup(), entries: [{ date: 'bad' }] }, { confirmed: true, expectedRaw: raw }))
  assert.equal(store.getItem(STORAGE_KEY), raw)
  assert.equal(store.getItem(PRE_RESTORE_KEY), null)
})
