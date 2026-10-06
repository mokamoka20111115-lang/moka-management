// iOSのソフトキーボードは100dvhだけでは反映されない場合がある。
// Visual Viewportを使って、実際に見えている範囲へ入力モーダルを収める。
export function bindModalViewport(overlay, browser = globalThis.window) {
  if (!browser || !overlay.style?.setProperty) return () => {}
  const viewport = browser.visualViewport
  let disposed = false
  const update = () => {
    if (disposed) return
    const height = viewport?.height ?? browser.innerHeight
    const top = viewport?.offsetTop ?? 0
    if (Number.isFinite(height) && height > 0) overlay.style.setProperty('--entry-viewport-height', `${height}px`)
    if (Number.isFinite(top) && top >= 0) overlay.style.setProperty('--entry-viewport-top', `${top}px`)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    browser.removeEventListener('resize', update)
    browser.removeEventListener('orientationchange', update)
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    observer?.disconnect()
  }
  // 認証状態変更等で外側からremoveされた場合もリスナーを解除する。
  const observer = browser.MutationObserver ? new browser.MutationObserver(() => {
    if (!overlay.isConnected) dispose()
  }) : null
  browser.addEventListener('resize', update)
  browser.addEventListener('orientationchange', update)
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  if (browser.document?.body) observer?.observe(browser.document.body, { childList: true })
  update()
  return dispose
}
