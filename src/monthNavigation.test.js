import test from 'node:test'
import assert from 'node:assert/strict'
import { moveMonth } from './monthNavigation.js'

test('左右の操作で必ず1か月ずつ移動する', () => {
  assert.equal(moveMonth('2026-10', -1), '2026-09')
  assert.equal(moveMonth('2026-10', 1), '2026-11')
})

test('12月から翌年1月、1月から前年12月に移動する', () => {
  assert.equal(moveMonth('2026-12', 1), '2027-01')
  assert.equal(moveMonth('2026-01', -1), '2025-12')
})

test('連続操作と左右の往復で月がずれない', () => {
  let month = '2026-10'
  for (const expected of ['2026-09', '2026-08', '2026-07']) {
    month = moveMonth(month, -1)
    assert.equal(month, expected)
  }
  for (const expected of ['2026-08', '2026-09', '2026-10']) {
    month = moveMonth(month, 1)
    assert.equal(month, expected)
  }
  for (let i = 0; i < 24; i++) month = moveMonth(month, 1)
  assert.equal(month, '2028-10')
  for (let i = 0; i < 24; i++) month = moveMonth(month, -1)
  assert.equal(month, '2026-10')
})

test('日本時間・UTC・米国時間でも移動結果が同じ', () => {
  const originalTimezone = process.env.TZ
  try {
    for (const timezone of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
      process.env.TZ = timezone
      assert.deepEqual([
        moveMonth('2026-10', -1), moveMonth('2026-10', 1),
        moveMonth('2026-12', 1), moveMonth('2026-01', -1),
      ], ['2026-09', '2026-11', '2027-01', '2025-12'])
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }
})
