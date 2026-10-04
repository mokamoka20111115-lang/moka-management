import { validateEntries } from './backup.js'

export function planMigration(local, cloud) {
  const source = validateEntries(local), target = validateEntries(cloud)
  const byDate = new Map(target.map(entry => [entry.date, entry]))
  const additions = [], conflicts = [], unchanged = []
  for (const entry of source) {
    const existing = byDate.get(entry.date)
    if (!existing) additions.push(entry)
    else if (JSON.stringify(existing) === JSON.stringify(entry)) unchanged.push(entry.date)
    else conflicts.push(entry.date)
  }
  return { additions, conflicts, unchanged, source }
}

export function planSave(current, entry, oldDate) {
  const [checked] = validateEntries([entry])
  const entries = validateEntries(current)
  if (oldDate !== checked.date && entries.some(item => item.date === checked.date)) {
    throw new Error('変更先の日付に記録があります。上書きせず、その日の記録を開いて編集してください。')
  }
  return validateEntries(entries.filter(item => item.date !== oldDate && item.date !== checked.date).concat(checked))
}

// 全件置換と移行は1回の原子的な処理に収める。超過時は何も書き込まない。
export function assertWriteLimit(count) {
  if (count > 400) throw new Error('一度に変更できるのは400件までです。データは変更していません。')
}

export function assertRevision(actual, expected) {
  if (actual !== expected) throw new Error('他の端末でデータが更新されています。入力画面を閉じて「最新データを読み込む」を押し、入力画面を開き直して内容を確認してください。下書きは画面を開き直しても保持します。')
}

export function entryPath(uid, date) {
  if (!uid || uid.includes('/') || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('保存先が不正です。')
  return `users/${uid}/entries/${date}`
}

// Firestore APIを注入し、通信・競合・原子性を単体テストできるようにする。
export function createCloudStore(api, uid) {
  const statePath = `users/${uid}/state/current`
  const readRevision = async tx => (await tx.get(statePath))?.revision ?? 0
  return {
    uid,
    async load() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = (await api.get(statePath))?.revision ?? 0
        const entries = validateEntries(await api.list(`users/${uid}/entries`))
        const after = (await api.get(statePath))?.revision ?? 0
        if (before === after) return { entries, revision: after }
      }
      throw new Error('読み込み中にデータが更新されました。もう一度読み込んでください。')
    },
    async save(snapshot, entry, oldDate) {
      const next = planSave(snapshot.entries, entry, oldDate)
      await api.transaction(async tx => {
        assertRevision(await readRevision(tx), snapshot.revision)
        if (oldDate !== entry.date && snapshot.entries.some(item => item.date === oldDate)) tx.delete(entryPath(uid, oldDate))
        tx.set(entryPath(uid, entry.date), validateEntries([entry])[0])
        tx.set(statePath, { revision: snapshot.revision + 1 })
      })
      return { entries: next, revision: snapshot.revision + 1 }
    },
    async migrate(snapshot, local) {
      const plan = planMigration(local, snapshot.entries)
      if (plan.conflicts.length) throw new Error(`クラウドと金額が違う日付があります：${plan.conflicts.join('、')}。上書きせず移行を中止しました。`)
      assertWriteLimit(plan.additions.length)
      if (!plan.additions.length) return snapshot
      await api.transaction(async tx => {
        assertRevision(await readRevision(tx), snapshot.revision)
        // 初期データや外部からの書き込みも確認し、同日を無断上書きしない。
        for (const entry of plan.additions) {
          if (await tx.get(entryPath(uid, entry.date))) throw new Error('同じ日付の記録が追加されています。再読み込みしてください。')
        }
        for (const entry of plan.additions) tx.set(entryPath(uid, entry.date), entry)
        tx.set(statePath, { revision: snapshot.revision + 1 })
      })
      return { entries: validateEntries(snapshot.entries.concat(plan.additions)), revision: snapshot.revision + 1 }
    },
    async replace(snapshot, entries, confirmed) {
      if (!confirmed) throw new Error('置き換えの確認が必要です。')
      const checked = validateEntries(entries)
      const dates = new Set(checked.map(entry => entry.date))
      const removed = snapshot.entries.filter(entry => !dates.has(entry.date))
      assertWriteLimit(removed.length + checked.length)
      await api.transaction(async tx => {
        assertRevision(await readRevision(tx), snapshot.revision)
        for (const entry of removed) tx.delete(entryPath(uid, entry.date))
        for (const entry of checked) tx.set(entryPath(uid, entry.date), entry)
        tx.set(statePath, { revision: snapshot.revision + 1 })
      })
      return { entries: checked, revision: snapshot.revision + 1 }
    },
  }
}
