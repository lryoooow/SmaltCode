"""Native SSH workflow routing; isolated profile, localhost mock model, no real login."""
from _desktop_review_harness import *
import _desktop_review_harness as harness
shots=root/'docs/screenshots/ssh-password-routing';shots.mkdir(parents=True,exist_ok=True);harness.shots=shots
with sync_playwright() as p:
 app=Desktop('SSH_ROUTE');app.local_default_only=True
 try:
  app.launch(p);app.page.get_by_label('任务输入',exact=True).fill('SSH_SETUP_ROUTE 连接服务器');app.nav('发送')
  expect(app.page.get_by_test_id('ssh-setup-notice')).to_contain_text('用户名和密码')
  expect(app.page.get_by_test_id('approval')).to_have_count(0)
  app.shot('native-ssh-route.png');app.nav('打开 SSH 连接');expect(app.page.get_by_test_id('ssh-page')).to_be_visible()
  app.nav('添加 SSH 项目');form=app.page.get_by_role('dialog',name='添加 SSH 项目',exact=True)
  expect(form.get_by_label('SSH 用户名',exact=True)).to_be_visible();expect(form.get_by_label('SSH 端口',exact=True)).to_be_visible();expect(form.get_by_label('SSH 连接密码',exact=True)).to_have_attribute('type','password');expect(form.get_by_label('SSH 认证方式',exact=True)).to_have_value('password')
  app.shot('native-username-password.png');form.get_by_role('button',name='关闭 SSH 对话框',exact=True).click()
  assert app.page.evaluate("()=>window.smalt.ssh('list').then(v=>v.connections.length)")==0
  app.nav('新建任务');app.page.get_by_label('任务输入',exact=True).fill('SSH_DISCOVER_ROUTE 查询软件连接');app.nav('发送');expect(app.page.get_by_test_id('ssh-setup-notice')).to_be_visible()
  app.nav('打开 SSH 连接');expect(app.page.get_by_test_id('ssh-page')).to_be_visible();assert not errors,errors
  checks.extend(['unbound local SSH is blocked before approval/spawn and exposes native connection action','action lands on SSH page for the current chat, with separate username, password and port fields','connection discovery reveals no credentials and does not start a connection or read user config'])
 finally:
  release.set();app.close();app.log.close();server.shutdown()
 print(json.dumps({'passed':True,'checks':checks,'rendererErrors':errors,'externalHosts':False,'externalModels':False,'fixture':str(run)},ensure_ascii=False,indent=2))
