"""実ブラウザでスクロール/保存ボタンを検証。python3 + playwrightが必要。
python3 scripts/test-mobile-modal.py （外部サービスへ通信せずローカルページを使用）
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from functools import partial
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(root)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
url = f'http://127.0.0.1:{server.server_port}/'
with sync_playwright() as playwright:
    for name, engine, executable in [('Chromium', playwright.chromium, '/usr/bin/chromium')]:
        browser = engine.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
        for width, height in [(390, 844), (375, 667), (320, 568), (844, 390), (390, 430), (1280, 800)]:
            page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            # SDK/Googleフォント等の外部通信を止め、localStorageの入力だけで検証する。
            page.route('https://**/*', lambda route: route.abort())
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url)
            page.locator('[data-new]').click()
            body = page.locator('.entry-modal .modal-body')
            footer = page.locator('.entry-modal footer')
            save = page.locator('.entry-modal footer .primary')
            assert body.evaluate('(el) => el.scrollHeight > el.clientHeight'), (name, width, height, 'no overflow')
            before = save.bounding_box()
            assert before['y'] >= 0 and before['y'] + before['height'] <= height + 1, (width, height, before)
            body.evaluate('(el) => { el.scrollTop = el.scrollHeight; }')
            assert body.evaluate('(el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1'), (width, height, 'cannot reach bottom')
            after = save.bounding_box()
            assert abs(before['y'] - after['y']) <= 1, (width, height, 'footer moved while scrolling')
            assert page.locator('input[name=supplies]').is_visible()
            # 同じスクロール位置で最後の項目を入力して保存できること。
            page.locator('input[name=supplies]').fill('123')
            save.click()
            page.wait_for_selector('.entry-overlay', state='detached')
            records = page.evaluate("JSON.parse(localStorage.getItem('moka-entries-v1'))")
            assert len(records) == 1 and records[0]['supplies'] == 123, (width, height, 'save failed')
            assert not errors, errors
            print(f'{name} {width}x{height}: bottom reachable, footer visible, saved')
            page.close()
        browser.close()
server.shutdown()
