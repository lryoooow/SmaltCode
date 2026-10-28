"""Default local dialogs, optional associations and independent attachment copies."""
from _desktop_review_harness import *
import _desktop_review_harness as harness

shots = root / 'docs/screenshots/local-dialogs'
shots.mkdir(parents=True, exist_ok=True)
harness.shots = shots

def settings(app):
    panel = app.page.get_by_role('region', name='对话所属项目', exact=True)
    if not panel.is_visible(): app.nav('选择对话所属项目')
    expect(panel).to_be_visible()
    return panel

def project(app, ident):
    settings(app).get_by_label('新对话所属项目', exact=True).select_option(ident)
    expect(app.page.get_by_role('region', name='对话所属项目', exact=True)).not_to_be_visible()

def create_project(app, name, instruction):
    app.nav('创建项目')
    dialog = app.page.get_by_role('dialog', name='创建项目', exact=True)
    dialog.get_by_label('项目名称', exact=True).fill(name)
    dialog.get_by_label('项目说明', exact=True).fill(instruction)
    assert dialog.get_by_role('button', name='选择项目默认本机文件夹', exact=True).count() == 0
    dialog.get_by_role('button', name='创建项目', exact=True).click()
    expect(app.page.get_by_role('heading', name=name, exact=True)).to_be_visible()
    return next(v for v in app.page.evaluate("()=>window.smalt.call('project/list').then(v=>v.projects)") if v['name'] == name)

def thread(app, prompt):
    app.page.get_by_label('任务输入', exact=True).fill(prompt)
    app.nav('发送')
    until(lambda: any(v['title'] == prompt for v in app.page.evaluate("()=>window.smalt.call('thread/list').then(v=>v.threads)")))
    return next(v for v in app.page.evaluate("()=>window.smalt.call('thread/list').then(v=>v.threads)") if v['title'] == prompt)

with sync_playwright() as p:
    app = Desktop('LOCAL_DEFAULT')
    app.local_default_only = True
    app.file_pick = app.dir / 'file-pick'
    app.folder_pick = app.dir / 'folder-pick'
    app.native_calls = app.dir / 'native-calls.json'
    app.fail_space = app.dir / 'fail-local-once'
    app.hold_space = app.dir / 'hold-space'
    app.space_ready = app.dir / 'space-ready'
    app.release_space = app.dir / 'space-release'
    supplied = app.dir / '用户附件.txt'
    supplied.write_text('ATTACHMENT_ONLY_LOCAL_UNIQUE\n', encoding='utf8')
    linked = app.dir / '显式关联的资料'; linked.mkdir(); (linked/'工作说明.txt').write_text('WORK_FILE_ONLY',encoding='utf8')
    app.file_pick.write_text(str(supplied), encoding='utf8')
    app.folder_pick.write_text(str(linked), encoding='utf8')
    paths = {name: str(getattr(app, name)) for name in ['file_pick', 'folder_pick', 'native_calls', 'fail_space', 'hold_space', 'space_ready', 'release_space']}
    delayed = {name: str(app.dir / ('create-' + name)) for name in ['hold', 'ready', 'release']}
    app.harness.write_text('require(' + json.dumps(str(root / 'scripts/fixtures/project-create-delay.cjs')) + ')(' + json.dumps(delayed) + ');\n' + app.harness.read_text(encoding='utf8') + "\n{const {dialog,ipcMain}=require('electron'),fs=require('node:fs'),p=" + json.dumps(paths) + ";const calls=[],ask=dialog.showMessageBox;dialog.showMessageBox=async o=>{calls.push(o.title);fs.writeFileSync(p.native_calls,JSON.stringify(calls));return ask(o)};dialog.showOpenDialog=async o=>({canceled:false,filePaths:[fs.readFileSync(o.properties.includes('openDirectory')?p.folder_pick:p.file_pick,'utf8')]});const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,fn)=>handle(name,async(...args)=>{if(name==='smalt:local-space'&&args[1]==='create'&&fs.existsSync(p.fail_space)){fs.unlinkSync(p.fail_space);throw Error('测试：本地磁盘暂不可写')}if(name==='smalt:local-space'&&args[1]==='create'&&fs.existsSync(p.hold_space)){fs.unlinkSync(p.hold_space);fs.writeFileSync(p.space_ready,'ready');await new Promise(resolve=>{const end=Date.now()+8000;const poll=()=>fs.existsSync(p.release_space)||Date.now()>end?resolve():setTimeout(poll,20);poll()})}return fn(...args)});}", encoding='utf8')
    try:
        app.launch(p)
        expect(app.page.get_by_test_id('context-project-name')).to_have_text('不加入项目')
        expect(app.page.get_by_test_id('context-location')).to_have_text('本地自动保存')
        first = thread(app, 'EDIT_HOST LOCAL_AUTO_SAVE_A')
        app.page.get_by_role('button', name='允许', exact=True).click()
        until(lambda: (Path(first['cwd']) / 'notes.md').exists())
        until(lambda: app.page.evaluate("id=>window.smalt.call('thread/read',{threadId:id}).then(v=>v.status.lifecycle)", first['id']) == 'idle')
        info = app.page.evaluate("()=>window.smalt.localSpace('info')")
        assert first['localSpace'] and not first.get('projectId') and Path(first['cwd']).parent == Path(info['files'])
        assert Path(first['cwd']) != app.workspace
        assert Path(first['cwd']).drive.upper() != os.environ.get('SystemDrive', 'C:').upper()
        assert (Path(first['cwd']) / 'notes.md').read_text(encoding='utf8') == 'HOST_CHANGED_BY_REMOTE\n'
        assert not (app.workspace / 'notes.md').read_text(encoding='utf8').startswith('HOST_CHANGED')
        calls = json.loads(app.native_calls.read_text()) if app.native_calls.exists() else []
        assert '允许访问工作区' not in calls
        checks.append('no project/folder/file selection is required: a real model write lands in a private non-system local space without a folder-consent prompt')

        app.nav('新建任务')
        app.page.get_by_label('任务输入', exact=True).fill('附件与草稿随当前对话保留')
        app.nav('添加文件引用')
        refs = app.page.get_by_test_id('context-references')
        expect(refs.get_by_role('button', name='预览引用 用户附件.txt', exact=True)).to_be_visible()
        expect(app.page.get_by_test_id('context-check-toggle')).to_have_count(1)
        expect(app.page.get_by_test_id('context-location')).to_have_text('本地自动保存')
        a = create_project(app, '项目仅用于分组', 'LOCAL_GROUP_A_ONLY')
        assert not a.get('cwd')
        expect(refs.get_by_role('button', name='预览引用 用户附件.txt', exact=True)).to_be_visible()
        expect(app.page.get_by_label('任务输入', exact=True)).to_have_value('附件与草稿随当前对话保留')
        project(app, '')
        expect(refs.get_by_role('button', name='预览引用 用户附件.txt', exact=True)).to_be_visible()
        project(app, a['id'])
        expect(refs.get_by_role('button', name='预览引用 用户附件.txt', exact=True)).to_be_visible()
        checks.append('creating/choosing/removing a project changes grouping only; the same draft and attachment stay visible and no project folder picker is shown')

        app.nav('打开资料与产物')
        panel=app.page.get_by_test_id('file-context-panel')
        panel.get_by_role('button',name='添加资料文件夹',exact=True).click()
        expect(panel).to_contain_text(str(linked))
        expect(app.page.get_by_test_id('context-location')).to_have_text('本地自动保存')
        panel.get_by_role('tab',name='执行环境',exact=True).click()
        panel.get_by_role('button',name='添加可修改的工作目录',exact=True).click()
        expect(app.page.get_by_test_id('context-location')).to_contain_text('执行于')
        expect(refs.get_by_role('button',name='预览引用 用户附件.txt',exact=True)).to_be_visible()
        expect(panel.get_by_test_id('file-execution-path')).to_have_text(str(linked))
        app.shot('explicit-folder-association.png')
        panel.get_by_role('button',name='改用自动本地空间',exact=True).click()
        expect(app.page.get_by_test_id('context-location')).to_have_text('本地自动保存')
        app.nav('关闭资料与产物')
        second = thread(app, 'ATTACH_ONLY LOCAL_AUTO_SAVE_B')
        assert second['localSpace'] and second.get('projectId') == a['id'] and second['cwd'] != first['cwd']
        assert Path(second['cwd']).parent == Path(info['files']) and Path(second['cwd']) != linked
        until(lambda: any('ATTACH_ONLY LOCAL_AUTO_SAVE_B' in json.dumps(v.get('messages', [])) for v in requests))
        payload = next(v for v in requests if 'ATTACH_ONLY LOCAL_AUTO_SAVE_B' in json.dumps(v.get('messages', [])))
        assert 'ATTACHMENT_ONLY_LOCAL_UNIQUE' in json.dumps(payload) and 'LOCAL_GROUP_A_ONLY' in json.dumps(payload)
        assert 'HOST_MODEL_KEY_NEVER_EXPOSE' not in json.dumps(payload)
        assert supplied.read_text(encoding='utf8') == 'ATTACHMENT_ONLY_LOCAL_UNIQUE\n'
        assert len(list((app.home / 'attachments').glob('*.data'))) == 1
        checks.append('adding a file keeps an independent local copy; folder association/unlinking neither drops attachments nor edits the original, and project grouping does not change the save directory')

        attachment = next((app.home / 'attachments').glob('*.json')).stem
        before = supplied.read_bytes()
        copied = app.page.evaluate("v=>window.smalt.artifacts('attachment-copy',v)", {'threadId': second['id'], 'path': 'attachment:' + attachment, 'dark': False})
        assert copied.get('id')
        copies = list(Path(second['cwd']).glob('*-副本-*.txt'))
        assert len(copies) == 1 and copies[0].read_bytes() == before and supplied.read_bytes() == before
        assert (app.home / 'attachments' / (attachment + '.data')).read_bytes() == before
        until(lambda: any('artifact.html' in page.url for context in app.browser.contexts for page in context.pages))
        artifact = next(page for context in app.browser.contexts for page in context.pages if 'artifact.html' in page.url)
        expect(artifact.get_by_label('成果文本编辑', exact=True)).to_have_value('ATTACHMENT_ONLY_LOCAL_UNIQUE\n')
        artifact.close()
        checks.append('creating an editable attachment copy needs no project or save-location dialog, opens the real text editor and preserves both the original and immutable attachment')

        app.nav('新建任务')
        app.nav('打开资料与产物')
        panel=app.page.get_by_test_id('file-context-panel')
        panel.get_by_role('button',name='添加原文件',exact=True).click()
        panel.get_by_role('button').filter(has_text='用户附件.txt').first.click()
        panel.get_by_role('button',name='用户附件.txt',exact=True).click()
        expect(panel).to_contain_text('只读原文件')
        panel.get_by_role('button',name='引用当前版本',exact=True).click()
        expect(app.page.get_by_test_id('context-references')).to_contain_text('只读')
        panel.get_by_role('button',name='返回文件列表',exact=True).click()
        panel.get_by_role('tab',name='执行环境',exact=True).click()
        panel.get_by_role('button',name='添加可修改的工作目录',exact=True).click()
        expect(panel.get_by_test_id('file-execution-path')).to_have_text(str(linked))
        panel.get_by_role('button',name='浏览工作文件',exact=True).click()
        panel.get_by_role('button',name='显式关联的资料 / 工作说明.txt',exact=True).click()
        expect(panel).to_contain_text('WORK_FILE_ONLY')
        expect(panel).to_contain_text('工作目录文件')
        panel.get_by_role('button',name='返回文件列表',exact=True).click()
        panel.get_by_role('tab',name='产物',exact=True).click()
        output=Path(panel.get_by_test_id('file-output-path').inner_text())
        assert output != linked
        app.nav('关闭资料与产物')
        generated=thread(app,'GENERATE_DELIVERABLE SOURCE_REFERENCE_WITH_SEPARATE_WORK')
        app.page.get_by_role('button',name='允许',exact=True).click()
        until(lambda:(output/'最终报告.md').exists())
        assert generated['cwd']==str(linked) and not (linked/'最终报告.md').exists()
        assert supplied.read_bytes()==before
        payload=next(v for v in requests if 'SOURCE_REFERENCE_WITH_SEPARATE_WORK' in json.dumps(v.get('messages',[])))
        assert 'ATTACHMENT_ONLY_LOCAL_UNIQUE' in json.dumps(payload)
        app.nav('打开资料与产物');panel=app.page.get_by_test_id('file-context-panel')
        panel.get_by_role('tab',name='产物',exact=True).click()
        expect(panel.get_by_test_id('file-output-path')).to_have_text(str(output))
        panel.get_by_role('button',name='最终报告.md',exact=False).first.click()
        expect(panel).to_contain_text('独立产物')
        exported=app.dir/'导出的报告.md';app.export.write_text(str(exported),encoding='utf8')
        panel.get_by_role('button',name='另存副本',exact=True).click()
        until(lambda:exported.exists());assert exported.read_bytes()==(output/'最终报告.md').read_bytes()
        assert panel.get_by_role('button',name='已保存版本（1）',exact=True).count()==0
        expect(panel).to_contain_text('已保存版本（1）')
        app.shot('separate-output-preview.png');app.nav('关闭资料与产物')
        app.nav('打开资料与产物');panel=app.page.get_by_test_id('file-context-panel');panel.get_by_role('tab',name='产物',exact=True).click()
        panel.get_by_role('button',name='最终报告.md',exact=False).first.click();panel.get_by_role('button',name='引用当前版本',exact=True).click();app.nav('关闭资料与产物')
        app.nav('检查引用');expect(app.page.get_by_test_id('context-inspection-entry')).to_contain_text('独立产物');app.page.keyboard.press('Escape')
        app.page.get_by_label('任务输入',exact=True).fill('REFERENCE_SAVED_OUTPUT_AGAIN');app.nav('发送')
        until(lambda:any('REFERENCE_SAVED_OUTPUT_AGAIN' in json.dumps(v.get('messages',[])) for v in requests))
        payload=next(v for v in requests if 'REFERENCE_SAVED_OUTPUT_AGAIN' in json.dumps(v.get('messages',[])))
        assert 'DELIVERABLE_ONLY_OUTPUT' in json.dumps(payload)
        web=output/'交互报告.html';web.write_text('<!doctype html><html><body>OUTPUT_HTML_SCOPED</body></html>',encoding='utf8')
        opened=app.page.evaluate("v=>window.smalt.browser('open',v)",{'threadId':generated['id'],'path':str(web)})
        assert opened['id']
        app.page.evaluate("v=>window.smalt.browser('close',v)",{'threadId':generated['id'],'id':opened['id']})
        checks.append('separate output is selectable, passes context inspection, reaches the model again, and HTML from that output opens through the existing isolated browser without changing execution cwd')
        checks.append('native readonly original is referenced with a fixed digest; resource_write publishes in a separate output directory, preview and native Save As preserve original and command cwd')

        b=create_project(app,'共享资料项目','SHARED_PROJECT_CONTEXT')
        app.nav('选择对话所属项目');app.nav('项目设置')
        dialog=app.page.get_by_role('dialog',name='编辑项目',exact=True)
        dialog.get_by_role('button',name='资料文件夹',exact=True).click()
        dialog.get_by_role('button',name='工作目录',exact=True).click()
        dialog.get_by_role('button',name='保存项目',exact=True).click()
        expect(app.page.get_by_role('heading',name=b['name'],exact=True)).to_be_visible()
        expect(app.page.get_by_test_id('context-location')).to_have_text('本地自动保存')
        app.nav('打开资料与产物');panel=app.page.get_by_test_id('file-context-panel');expect(panel).to_contain_text(str(linked));app.nav('关闭资料与产物')
        app.nav('使用项目默认目录');expect(app.page.get_by_test_id('context-location')).to_contain_text('执行于')
        project(app,'');expect(app.page.get_by_test_id('context-location')).to_contain_text('执行于')
        app.nav('打开资料与产物');panel=app.page.get_by_test_id('file-context-panel');expect(panel).to_contain_text('无需添加资料')
        panel.get_by_role('tab',name='执行环境',exact=True).click();panel.get_by_role('button',name='改用自动本地空间',exact=True).click();app.nav('关闭资料与产物')
        checks.append('project shared materials apply to new draft without silently changing cwd; explicitly adopting its default is separate and clearing project removes inherited materials without retargeting the chosen environment')

        app.nav('新建任务')
        Path(delayed['hold']).write_text('hold')
        app.page.get_by_label('任务输入', exact=True).fill('DELAYED_LOCAL_CREATE')
        app.nav('发送'); until(lambda: Path(delayed['ready']).exists())
        project(app, a['id'])
        app.page.get_by_label('任务输入', exact=True).fill('关联项目后保留的新草稿')
        Path(delayed['release']).write_text('release')
        until(lambda: any('DELAYED_LOCAL_CREATE' in json.dumps(v.get('messages', [])) for v in requests))
        expect(app.page.get_by_test_id('home')).to_be_visible()
        expect(app.page.get_by_label('任务输入', exact=True)).to_have_value('关联项目后保留的新草稿')
        third = thread(app, 'LOCAL_AFTER_DELAY')
        old = next(v for v in app.page.evaluate("()=>window.smalt.call('thread/list').then(v=>v.threads)") if v['title'] == 'DELAYED_LOCAL_CREATE')
        assert old['cwd'] != third['cwd']
        checks.append('a delayed creation followed by a project change keeps the new draft and creates a different private space; the old receipt cannot steal navigation')

        app.fail_space.write_text('fail')
        app.nav('新建任务')
        expect(app.page.get_by_test_id('local-storage-error')).to_contain_text('本地磁盘暂不可写')
        app.page.get_by_label('任务输入', exact=True).fill('存储重试时保留的草稿')
        expect(app.page.get_by_role('button', name='发送', exact=True)).to_be_disabled()
        app.nav('重试本地存储')
        expect(app.page.get_by_test_id('local-storage-error')).not_to_be_visible()
        expect(app.page.get_by_label('任务输入', exact=True)).to_have_value('存储重试时保留的草稿')
        expect(app.page.get_by_role('button', name='发送', exact=True)).to_be_enabled()
        checks.append('local storage failure is directly visible and retry restores sending without losing the draft or falling back to a system disk')

        app.hold_space.write_text('hold')
        app.nav('新建任务')
        until(lambda: app.space_ready.exists())
        app.nav('持续任务')
        app.release_space.write_text('release')
        app.nav('新建持续任务')
        dialog = app.page.get_by_role('dialog', name='持续任务设置', exact=True)
        expect(dialog).to_contain_text(info['files'])
        expect(dialog).not_to_contain_text('请先选择工作区')
        dialog.get_by_role('button', name='取消', exact=True).click()
        app.nav('对话')
        expect(app.page.get_by_test_id('context-location')).to_have_text('本地自动保存')
        checks.append('navigation while local space creation is pending keeps preparation alive and supplies a default location to the continuous-task form without choosing a folder')

        for theme in ['light', 'dark']:
            if theme == 'dark': app.nav('切换主题')
            for factor in [1, 1.25, 1.5, 2]:
                app.ack.unlink(missing_ok=True); ready = app.zoom.with_name('zoom-ready'); ready.write_text(str(factor)); ready.replace(app.zoom); until(lambda: app.ack.exists())
                toggle = app.page.get_by_role('button', name='选择对话所属项目', exact=True); toggle.scroll_into_view_if_needed(); expect(toggle).to_be_in_viewport()
                permission=app.page.get_by_role('button',name='权限模式',exact=True)
                assert permission.evaluate('e=>e.scrollHeight<=e.clientHeight+1'), 'permission label overflows its button'
                app.shot('local-summary-' + theme + '-' + str(factor) + '.png')
                panel = settings(app); selector = panel.get_by_label('新对话所属项目', exact=True); selector.scroll_into_view_if_needed(); expect(selector).to_be_in_viewport()
                assert panel.evaluate('e=>e.scrollWidth<=e.clientWidth+1') and app.page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                app.shot('local-settings-' + theme + '-' + str(factor) + '.png'); app.page.keyboard.press('Escape')
        checks.append('a single compact context control and optional-association panel remain usable in light/dark 100/125/150/200 percent zoom without horizontal overflow')
        assert not errors, errors
    except Exception:
        try: app.shot('failure.png'); print(app.page.locator('body').inner_text()[-5000:])
        except Exception: pass
        raise
    finally:
        release.set(); Path(delayed['release']).touch(exist_ok=True); app.release_space.touch(exist_ok=True)
        try: app.close()
        except Exception:
            if app.process and app.process.poll() is None: app.process.terminate(); app.process.wait(timeout=10)
        app.log.close(); server.shutdown()
    result = {'passed': True, 'checks': checks, 'rendererErrors': errors, 'fixture': str(run), 'screenshots': str(shots), 'externalModels': False}
    (run / 'local-dialog-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
