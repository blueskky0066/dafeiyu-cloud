import tempfile,subprocess,time,json,shutil,urllib.request,os
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1]
temp=tempfile.mkdtemp(prefix='cohabit-dsh-browser-')
proc=subprocess.Popen(['node','test/browser-fixture.mjs'],cwd=root,env={**os.environ,'QA_DATA':temp},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
errors=[]
try:
 for _ in range(50):
  try: urllib.request.urlopen('http://127.0.0.1:6382/api/health',timeout=1);break
  except Exception: time.sleep(.1)
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1000})
  page.on('pageerror',lambda err:errors.append(str(err)))
  page.on('console',lambda msg:errors.append(msg.text) if msg.type=='error' else None)
  page.route('**/learning/image/*',lambda route:route.fulfill(status=200,content_type='image/png',body=__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')))
  page.goto('http://127.0.0.1:6382/#character/dafeiyu/learning')
  page.get_by_label('管理密码',exact=True).fill('browser-test-only-12345')
  page.get_by_role('button',name='进入工作台').click()
  expect(page.get_by_role('heading',name='注释与表达参考',exact=True)).to_be_visible()
  page.get_by_role('button',name='注释这句').first.click()
  page.get_by_label('含义、适用场景与例外',exact=True).fill('这句是熟人之间的反话，不代表生气')
  page.get_by_role('button',name='保存注释',exact=True).click()
  expect(page.locator('.learning-note')).to_have_count(1)
  page.get_by_role('button',name='解释这张表情',exact=True).click()
  page.get_by_label('含义、适用场景与例外',exact=True).fill('表示无奈又好笑，通常是自嘲')
  page.get_by_role('button',name='保存注释',exact=True).click()
  expect(page.locator('.learning-note')).to_have_count(2)
  page.get_by_role('button',name='解释并确认',exact=True).click()
  page.get_by_label('含义、适用场景与例外',exact=True).fill('轻松表示赞同，不要每句都模仿')
  page.get_by_role('button',name='保存注释',exact=True).click()
  expect(page.locator('.learning-note')).to_have_count(3)
  page.get_by_label('测试一句话',exact=True).fill('好耶')
  page.get_by_role('button',name='查看会参考哪些解释',exact=True).click()
  expect(page.locator('#learning-preview-result')).to_contain_text('轻松表示赞同')
  page.get_by_role('button',name='编辑',exact=True).first.click()
  page.get_by_label('启用这条参考',exact=True).uncheck()
  page.get_by_role('button',name='保存注释',exact=True).click()
  expect(page.locator('.learning-note').filter(has_text='这句是熟人之间的反话')).to_contain_text('已停用')
  screenshot=root/'test-results';screenshot.mkdir(exist_ok=True)
  page.screenshot(path=str(screenshot/'learning-desktop.png'),full_page=True,animations='disabled')
  page.set_viewport_size({'width':390,'height':844})
  page.screenshot(path=str(screenshot/'learning-mobile.png'),full_page=True,animations='disabled')
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  assert not errors,errors
  print(json.dumps({'passed':True,'checks':['sentence annotation','sticker meaning','confirm expression candidate','recall preview','disable note','mobile layout'],'consoleErrors':errors},ensure_ascii=False))
  browser.close()
finally:
 proc.terminate()
 try:proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill()
 shutil.rmtree(temp,ignore_errors=True)
