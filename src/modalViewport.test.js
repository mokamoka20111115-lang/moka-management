import test from 'node:test'
import assert from 'node:assert/strict'
import { bindModalViewport } from './modalViewport.js'
function events() {
  const listeners=new Map()
  return {listeners,addEventListener(type,fn){listeners.set(type,fn)},removeEventListener(type){listeners.delete(type)},emit(type){listeners.get(type)?.()}}
}
function fixture(height=844,top=0) {
  const values=new Map(),overlay={isConnected:true,style:{setProperty:(key,value)=>values.set(key,value)}}
  const viewport={...events(),height,offsetTop:top}
  let notify,disconnected=false
  const browser={...events(),visualViewport:viewport,innerHeight:844,document:{body:{}},MutationObserver:class {constructor(fn){notify=fn}observe(){}disconnect(){disconnected=true}}}
  return {overlay,browser,values,viewport,notify:()=>notify(),disconnected:()=>disconnected}
}
test('iPhone 12の表示高とキーボードによる縮小・スクロールへ追従する',()=>{
  const f=fixture();const dispose=bindModalViewport(f.overlay,f.browser)
  assert.equal(f.values.get('--entry-viewport-height'),'844px')
  f.viewport.height=430;f.viewport.offsetTop=48;f.viewport.emit('resize')
  assert.equal(f.values.get('--entry-viewport-height'),'430px');assert.equal(f.values.get('--entry-viewport-top'),'48px')
  f.viewport.offsetTop=80;f.viewport.emit('scroll');assert.equal(f.values.get('--entry-viewport-top'),'80px')
  f.viewport.height=844;f.viewport.offsetTop=0;f.viewport.emit('resize');assert.equal(f.values.get('--entry-viewport-height'),'844px')
  dispose()
})
test('横向きの短い画面とホーム画面サイズの変化へ追従する',()=>{
  const f=fixture(390);const dispose=bindModalViewport(f.overlay,f.browser)
  assert.equal(f.values.get('--entry-viewport-height'),'390px')
  f.viewport.height=810;f.browser.emit('orientationchange');assert.equal(f.values.get('--entry-viewport-height'),'810px')
  dispose()
})
test('VisualViewportがないブラウザではinnerHeightへフォールバックする',()=>{
  const f=fixture();delete f.browser.visualViewport;const dispose=bindModalViewport(f.overlay,f.browser)
  assert.equal(f.values.get('--entry-viewport-height'),'844px');assert.equal(f.values.get('--entry-viewport-top'),'0px')
  f.browser.innerHeight=640;f.browser.emit('resize');assert.equal(f.values.get('--entry-viewport-height'),'640px')
  dispose()
})
test('閉じる・認証切り替えによる外部削除でリスナーを解放する',()=>{
  const f=fixture();const dispose=bindModalViewport(f.overlay,f.browser)
  f.overlay.isConnected=false;f.notify()
  assert.equal(f.browser.listeners.size,0);assert.equal(f.viewport.listeners.size,0);assert.equal(f.disconnected(),true)
  dispose();assert.equal(f.viewport.listeners.size,0)
})
test('無効な表示高でモーダルを潰さず、DOMなしでも既存機能を妨げない',()=>{
  const f=fixture();const dispose=bindModalViewport(f.overlay,f.browser)
  f.viewport.height=0;f.viewport.offsetTop=-1;f.viewport.emit('resize')
  assert.equal(f.values.get('--entry-viewport-height'),'844px');assert.equal(f.values.get('--entry-viewport-top'),'0px')
  dispose();assert.doesNotThrow(()=>bindModalViewport({},undefined)())
})
