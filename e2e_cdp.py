#!/usr/bin/env python3
"""
e2e_cdp.py —— 用 Chrome DevTools Protocol（--remote-debugging-pipe，纯标准库）
真机验收 index.html：file:// 打开、模拟点选表单、断言分组/排序/筛选/空态，并出截图。

不依赖 playwright / websocket / 任何第三方包。
  python3 e2e_cdp.py            # 只用 python3 标准库
"""
import base64
import json
import os
import subprocess
import sys
import time
import glob

ROOT = os.path.dirname(os.path.abspath(__file__))
URL = 'file://' + os.path.join(ROOT, 'index.html')


def find_shell():
    pats = [
        os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
        os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]
    for p in pats:
        hit = sorted(glob.glob(p))
        if hit:
            return hit[-1]
    raise SystemExit('找不到可用的 chromium headless shell')


class CDP:
    """最小的 CDP 客户端：pipe 传输 + 按 id 收响应 + 收集事件。

    Chromium 的 --remote-debugging-pipe 约定：浏览器从 fd 3 读、往 fd 4 写。
    CPython 会在 preexec_fn 之后统一关闭非 pass_fds 的 fd，所以不能靠 dup2
    现搭 fd 3/4；这里直接把管道端点做成 3 和 4，再用 pass_fds 原样保留。
    """

    def __init__(self, binary):
        r_a, w_a = os.pipe()      # 浏览器读
        r_b, w_b = os.pipe()      # 浏览器写
        p_w = os.dup(w_a)         # 父进程写（保证不是 3/4）
        p_r = os.dup(r_b)         # 父进程读
        if w_b == 3:              # 先腾开，免得下面被 dup2 顺手关掉
            w_b = os.dup(w_b)
        if r_a == 4:
            r_a = os.dup(r_a)
        os.dup2(r_a, 3)
        os.dup2(w_b, 4)
        for fd in (r_a, w_a, r_b, w_b):
            if fd not in (3, 4):
                os.close(fd)

        self.w_in = p_w
        self.r_out = p_r
        self.proc = subprocess.Popen(
            [binary, '--remote-debugging-pipe', '--headless', '--no-sandbox',
             '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
             '--hide-scrollbars', '--force-device-scale-factor=1',
             '--user-data-dir=/tmp/cdp-prof-e2e', 'about:blank'],
            pass_fds=(3, 4),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(3)
        os.close(4)
        self.buf = b''
        self.next_id = 1
        self.events = []
        self.console_errors = []
        self.console_all = []
        self.requests = []

    # ---- 传输层 ----
    def _send(self, msg):
        os.write(self.w_in, json.dumps(msg).encode() + b'\0')

    def _pump(self, want_id=None, timeout=30):
        """读到目标响应为止，途中把事件存起来。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            while b'\0' in self.buf:
                raw, self.buf = self.buf.split(b'\0', 1)
                if not raw.strip():
                    continue
                msg = json.loads(raw)
                if 'id' in msg and (want_id is None or msg['id'] == want_id):
                    return msg
                if 'method' in msg:
                    self.events.append(msg)
                    if msg['method'] == 'Network.requestWillBeSent':
                        self.requests.append(msg['params']['request']['url'])
                    if msg['method'] == 'Runtime.consoleAPICalled':
                        line = self._text(msg['params'])
                        self.console_all.append(line)
                        if msg['params'].get('type') == 'error':
                            self.console_errors.append(line)
                    if msg['method'] == 'Runtime.exceptionThrown':
                        self.console_errors.append(str(msg['params'].get('exceptionDetails', {}))[:200])
            try:
                chunk = os.read(self.r_out, 1 << 20)
            except OSError:
                break
            if not chunk:
                break
            self.buf += chunk
        raise TimeoutError('CDP 等待超时 id=%s' % want_id)

    def call(self, method, params=None, session=None, timeout=60):
        mid = self.next_id
        self.next_id += 1
        msg = {'id': mid, 'method': method, 'params': params or {}}
        if session:
            msg['sessionId'] = session
        self._send(msg)
        res = self._pump(mid, timeout)
        if 'error' in res:
            raise RuntimeError(f'{method} -> {res["error"]}')
        return res.get('result', {})

    @staticmethod
    def _text(params):
        return ' '.join(str(a.get('value', a.get('description', ''))) for a in params.get('args', []))

    # ---- 常用动作 ----
    def evaluate(self, expr, session, timeout=120):
        r = self.call('Runtime.evaluate', {
            'expression': expr, 'returnByValue': True, 'awaitPromise': True,
            'userGesture': True,
        }, session=session, timeout=timeout)
        if r.get('exceptionDetails'):
            raise RuntimeError('页面 JS 异常: ' + json.dumps(r['exceptionDetails'])[:400])
        return r['result'].get('value')

    def screenshot(self, path, session):
        r = self.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False}, session=session)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))
        return os.path.getsize(path)

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# --------------------------------------------------------------------------
# 在页面里跑的验收脚本：模拟真人操作 + 断言，返回结构化结果
# --------------------------------------------------------------------------
PAGE_SCRIPT = r"""
(async () => {
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, ok: !!cond, extra: cond ? '' : String(extra) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const click = async (sel, text) => {
    const el = text ? $$(sel).find(e => e.textContent.includes(text)) : $(sel);
    if (!el) throw new Error('找不到元素: ' + sel + ' / ' + text);
    el.click(); await sleep(80);
  };
  const setVal = (sel, v) => {
    const el = $(sel); el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.__errs = window.__errs || [];
  window.addEventListener('error', e => window.__errs.push(String(e.message)));

  // ---------- 1. 打开就有诊断，且只给 6 条 ----------
  for (let i = 0; i < 60 && !$('.card'); i++) await sleep(50);
  ok('打开即有诊断区块', $$('.diagnosis').length === 1);
  ok('诊断标题是【现状诊断】', $('.diagnosis h2').textContent.includes('现状诊断'), $('.diagnosis h2').textContent);
  ok('诊断含 核心矛盾 + 性价比策略', $('.diagnosis').textContent.includes('核心矛盾') && $('.diagnosis').textContent.includes('性价比策略'));
  ok('默认最多 6 张卡片', $$('.card').length <= 6, $$('.card').length);
  ok('卡片数正好 = 精选 3 + 备选 3', $$('.card').length === 6, $$('.card').length);
  ok('精选区标题为「精选 Top 3」', $$('.results-head h2').some(h => h.textContent.includes('精选 Top 3')),
     $$('.results-head h2').map(h => h.textContent).join('|'));
  ok('精选卡片带 hero 样式', $$('.card.hero').length === 3, $$('.card.hero').length);

  // ---------- 2. 诊断的「行动启示」 ----------
  const rx = $$('.diagnosis ol li');
  ok('行动启示有 3 条', rx.length === 3, rx.length);
  ok('每条行动启示都带出处（第 X 节 · 第 Y 条）',
     rx.every(li => /第 \d+ 节 · 第 \d+ 条/.test(li.textContent)),
     rx.map(li => li.textContent.slice(-18)).join(' | '));
  ok('行动启示带分类标签', rx.every(li => li.querySelector('.action-tag')));
  ok('诊断标注了依据来源', /诊断依据/.test($('.diagnosis').textContent));
  ok('诊断声明无模型推断', /无模型推断/.test($('.diagnosis').textContent));

  // ---------- 3. 卡片做减法 ----------
  const c0 = $$('.card')[0];
  ok('卡片有标题', !!c0.querySelector('h3') && c0.querySelector('h3').textContent.length > 2);
  ok('卡片有性价比徽章', /性价比 (极高|高|一般)/.test(c0.querySelector('.badge').textContent), c0.querySelector('.badge').textContent);
  ok('卡片有证据等级徽章', /证据 [ABC]/.test(c0.textContent));
  ok('卡片始终显示出处（第 X 节 · 第 Y 条）', /第 \d+ 节 · 第 \d+ 条/.test(c0.querySelector('.ref').textContent), c0.querySelector('.ref').textContent);
  ok('卡片有行动高亮行', !!c0.querySelector('.action .action-text') && c0.querySelector('.action-text').textContent.length >= 4,
     c0.querySelector('.action-text') ? c0.querySelector('.action-text').textContent : 'none');
  // details 关闭时元素仍在 DOM 里，所以判断「可见性」而不是「存在性」
  const shown = (el) => !!el && (el.checkVisibility ? el.checkVisibility() : el.offsetHeight > 0);
  ok('默认不显示成本标签', !shown(c0.querySelector('.cost-line')));
  ok('默认不显示正文全文', !shown(c0.querySelector('.full')));
  ok('默认不显示成本仪表', !shown(c0.querySelector('.meter')));
  await click('.card summary', '展开详情');
  ok('点开详情后成本标签可见', shown($('.card .cost-line')) && /0 元|几十到几百元|上千元以上/.test($('.card .cost-line').textContent));
  ok('点开详情后正文可见', shown($('.card .full')) && $('.card .full').textContent.includes('正文：'));
  ok('点开详情后原书出处可见', $('.card .full').textContent.includes('原书出处'));
  ok('详情里有打分明细', $('.card .why ul') && $('.card .why li').textContent.includes('+'));

  // ---------- 4. 展开其余建议 ----------
  const btn = $('#expand');
  ok('默认有「展开查看其他相关建议（共 X 条）」按钮',
     !!btn && /展开查看其他相关建议（共 \d+ 条）/.test(btn.textContent), btn ? btn.textContent : 'none');
  const before = $$('.card').length;
  await click('#expand');
  const after = $$('.card').length;
  ok('点开后渲染出更多卡片', after > before, before + ' -> ' + after);
  ok('展开后仍在分批（不是一次性几百张）', after <= before + 60 + 3, after);
  ok('展开后有「收起」按钮', !!$('#collapse'));
  await click('#collapse');
  ok('收起后回到 6 条', $$('.card').length === 6, $$('.card').length);

  // ---------- 5. 场景快捷标签 ----------
  await click('#scenarios .chip', '失业 / 辞职过渡');
  await sleep(200);
  ok('场景一键带入：收入=低', $('#income').value === '低', $('#income').value);
  ok('场景一键带入：时间=紧张', $('#time').value === '紧张', $('#time').value);
  ok('场景一键带入：职业=待业', $('#job').value === '待业', $('#job').value);
  ok('场景一键带入：困惑已填', $('#query').value.length > 4, $('#query').value);
  ok('场景带入后自动重新生成（仍有 ≤6 条）', $$('.card').length > 0 && $$('.card').length <= 6, $$('.card').length);
  ok('场景按钮显示为选中态', $('#scenarios .chip[aria-pressed=true]') !== null);

  // ---------- 6. 场景四：职业/创业 ----------
  await click('#scenarios .chip', '职业 / 创业选择');
  await sleep(200);
  ok('职业场景带入成功', $('#query').value.includes('创业'), $('#query').value);

  // ---------- 7. 硬伤复验：在职 + 想辞职考研，第 1 条不是失业金 ----------
  setVal('#age', '28'); setVal('#job', '在职'); setVal('#income', '低');
  setVal('#family', '单身'); setVal('#time', '紧张'); setVal('#grit', '中');
  setVal('#query', '28岁想辞职考研，父母催婚，存款不多');
  await click('#go'); await sleep(250);
  const firstTitle = $('.card h3').textContent;
  const jobless = $$('.card h3').map(h => h.textContent).filter(t => /失业金|失业保险|失业登记/.test(t));
  ok('在职用户第 1 条不是失业金条款', !/失业金|失业保险|失业登记/.test(firstTitle), firstTitle);
  ok('该场景仍然 ≤6 条', $$('.card').length <= 6, $$('.card').length);
  ok('诊断依据写在页面上', /诊断依据/.test($('.diagnosis').textContent));
  const diagTxt = $('.diagnosis').textContent;
  ok('诊断给出了学历/换轨相关判断', /学历|换轨/.test(diagTxt), diagTxt.slice(0, 60));
  ok('在职场景下失业金条款若出现也排在精选之后', jobless.length === 0 || $$('.card.hero h3').every(h => !/失业金|失业保险/.test(h.textContent)),
     jobless.join('|'));
  ok('扩充检索词显示在页面上', /扩充的检索词/.test(diagTxt), diagTxt.slice(-80));

  // ---------- 8. 强制出处 + 免责声明 ----------
  ok('每张卡片都显示节号与条号', $$('.card').every(c => /第 \d+ 节 · 第 \d+ 条/.test(c.querySelector('.ref').textContent)));
  const dis = $('.disclaimer');
  ok('底部有免责声明', !!dis);
  ok('免责声明包含「不是医疗/法律/财务诊断」', dis.textContent.includes('不是医疗/法律/财务诊断'), dis.textContent);
  ok('免责声明要求核对原文', dis.textContent.includes('核对原文'), dis.textContent);

  // ---------- 9. 离线可用 ----------
  ok('无任何外链资源', $$('link[href],script[src],img[src],iframe[src]').length === 0,
     $$('link[href],script[src],img[src],iframe[src]').map(e => e.outerHTML.slice(0, 50)).join(' '));
  ok('页面无 JS 报错', window.__errs.length === 0, window.__errs.join(' | '));
  ok('顶部提示已限制 Top 6', $('#build-note') && $('#build-note').textContent.includes('Top 6'),
     $('#build-note') ? $('#build-note').textContent : 'none');

  return { checks, cards: $$('.card').length, firstName: firstTitle };
})()
"""


def main():
    binary = find_shell()
    print('浏览器：' + binary)
    cdp = CDP(binary)
    try:
        tid = cdp.call('Target.createTarget', {'url': URL})['targetId']
        sid = cdp.call('Target.attachToTarget', {'targetId': tid, 'flatten': True})['sessionId']
        cdp.call('Runtime.enable', session=sid)
        cdp.call('Page.enable', session=sid)
        cdp.call('Network.enable', session=sid)
        # 开了 Network 域之后再重新加载一次，这样请求日志里才包含文档本身的加载
        cdp.call('Page.reload', {'ignoreCache': True}, session=sid)
        for _ in range(80):
            if cdp.evaluate('document.readyState', sid) == 'complete':
                break
            time.sleep(0.15)
        cdp.call('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 1000, 'deviceScaleFactor': 1, 'mobile': False}, session=sid)
        # 确认真的加载完成了
        for _ in range(60):
            if cdp.evaluate('document.readyState', sid) == 'complete':
                break
            time.sleep(0.2)

        res = cdp.evaluate(PAGE_SCRIPT, sid)
        print('\n验收结果：')
        fails = []
        for c in res['checks']:
            print(('  ✓ ' if c['ok'] else '  ✗ ') + c['name'] + (('  → ' + c['extra']) if c['extra'] else ''))
            if not c['ok']:
                fails.append(c['name'])

        cdp.evaluate('window.scrollTo(0,0)', sid)
        size = cdp.screenshot(os.path.join(ROOT, 'shot-desktop.png'), sid)
        print(f'\n截图 shot-desktop.png ({size // 1024} KB)')
        cdp.evaluate("document.querySelector('.diagnosis').scrollIntoView({block:'start'})", sid)
        time.sleep(0.4)
        cdp.screenshot(os.path.join(ROOT, 'shot-cards.png'), sid)

        # 困惑直达：重放一个具体场景（低收入 + 时间紧 + 押金纠纷）
        cdp.evaluate("""(() => {
          const set = (s, v) => { const e = document.querySelector(s); e.value = v;
            e.dispatchEvent(new Event('change', {bubbles:true})); };
          set('#age','27'); set('#income','低'); set('#time','紧张'); set('#grit','低');
          set('#family','单身'); set('#job','在职');
          set('#query','房东不退押金 断水断电');
          document.querySelector('#go').click();
        })()""", sid)
        time.sleep(0.5)
        cdp.evaluate("window.scrollTo(0, document.querySelector('.diagnosis').offsetTop - 90)", sid)
        time.sleep(0.4)
        cdp.screenshot(os.path.join(ROOT, 'shot-direct.png'), sid)

        # 移动端
        cdp.call('Emulation.setDeviceMetricsOverride',
                 {'width': 390, 'height': 844, 'deviceScaleFactor': 2, 'mobile': True}, sid)
        cdp.evaluate('window.scrollTo(0,0)', sid)
        time.sleep(0.4)
        overflow = cdp.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth', sid)
        print(f'移动端横向溢出：{overflow}px')
        if overflow > 0:
            fails.append('移动端横向溢出')
        cdp.screenshot(os.path.join(ROOT, 'shot-mobile.png'), sid)

        external = [u for u in cdp.requests if not u.startswith(('file://', 'data:', 'about:', 'blob:'))]
        print('\n页面地址：file://…/index.html（本地文件直接打开）')
        print('网络请求总数：%d，其中外部请求：%d' % (len(cdp.requests), len(external)))
        for u in cdp.requests[:3]:
            print('  · ' + u.replace(ROOT, '…'))
        for u in external[:5]:
            print('  ! ' + u)
        if external:
            fails.append('存在外部网络请求')
        print(('  ✓ ' if not external else '  ✗ ') + '离线可用：没有任何外部网络请求')

        note_ok = any('修改完成，已强制限制为 Top 6 建议' in m for m in cdp.console_all)
        print(('  ✓ ' if note_ok else '  ✗ ') + '控制台输出「修改完成，已强制限制为 Top 6 建议」')
        if not note_ok:
            fails.append('控制台缺少提示')
            print('    实际 console:', cdp.console_all[:5])
        ok_note = cdp.evaluate("document.querySelector('#build-note').textContent", sid)
        print('  页脚提示：' + ok_note)

        if cdp.console_errors:
            print('\n浏览器控制台错误：')
            for e in cdp.console_errors[:5]:
                print('  ! ' + e)
            fails.append('控制台错误')

        print('\n' + ('✅ 全部通过（%d 项）' % len(res['checks']) if not fails else '❌ 失败：' + '、'.join(fails)))
        return 1 if fails else 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
