import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDay, calculateMonth, localDate } from './calculations.js'
const entry={dineIn:50000,uberOrder:10000,uberPaid:7000,demaeOrder:5000,demaePaid:4000,rocketOrder:0,rocketPaid:0,ingredients:12000,supplies:3000}
test('日次の指標を計算する',()=>assert.deepEqual({...calculateDay(entry),feeRate:undefined,costRate:undefined},{sales:65000,paid:61000,deliverySales:15000,fees:4000,costs:15000,grossProfit:46000,feeRate:undefined,costRate:undefined}))
test('月間の合計を計算する',()=>assert.deepEqual(calculateMonth([entry,entry]),{sales:130000,costs:30000,fees:8000,grossProfit:92000}))
test('端末のローカル日付を使う',()=>assert.equal(localDate(new Date('2026-10-02T15:30:00.000Z')),'2026-10-02'))
