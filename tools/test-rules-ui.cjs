// 规则页 /rules：列表渲染、新建/编辑提交的 JSON、试运行、开关、删除、.env 规则只读、防注入、英文界面。
// 接口全是桩（/api/router/*），bootstrap 换成最小桩，不碰网络。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ORIGIN = 'http://manymail.test';
const VIEWER = path.resolve(__dirname, '../web');
const html = fs.readFileSync(path.join(VIEWER, 'templates/rules.html'), 'utf8')
  .replace('{{asset "js/rules.js"}}', '/static/js/rules.js')
  .replace('{{shared "i18n.js"}}', '/i18n.js');
const BOOTSTRAP_STUB = `window.bootstrap = { Modal: class {
  constructor(el) { this.el = el; }
  show() { this.el.style.display = 'block'; this.el.classList.add('show'); }
  hide() { this.el.style.display = 'none'; this.el.classList.remove('show'); }
} };`;

const EVIL = '<img src=x onerror="window.pwned=1">';

function freshRules() {
  return [
    { _id: 'env-forward', name: 'Forward hello@example.com', managed_by: 'env', enabled: true, order: 0,
      match: { to: ['hello@example.com'] }, actions: [{ type: 'forward', to: ['me@gmail.com'], from: 'hi@example.com' }], problems: [] },
    { _id: 'otp', name: EVIL, enabled: true, order: 10, stop: true,
      match: { to: ['otp-*@example.com'], subject: ['code'], source: ['smtp', 'imap'] },
      actions: [{ type: 'ntfy', topic: 'secret-topic', priority: 4 }, { type: 'tag', tags: ['otp'] }], problems: [] },
  ];
}

async function run(lang) {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const calls = [];
  let rules = freshRules();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((l) => localStorage.setItem('manymail-lang', l), lang);
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status, o) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.hostname === 'cdn.jsdelivr.net') {
      if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: BOOTSTRAP_STUB });
      return route.fulfill({ contentType: 'text/css', body: '' });
    }
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/rules') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/static/js/rules.js') return route.fulfill({ path: path.join(VIEWER, 'static/js/rules.js') });
    if (url.pathname === '/i18n.js') return route.fulfill({ path: path.join(VIEWER, 'shared/i18n.js') });
    if (!url.pathname.startsWith('/api/router/')) return route.fulfill({ status: 404, body: '' });
    const api = url.pathname.slice('/api/router/'.length);
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    calls.push({ method: req.method(), api, body, type: req.headers()['content-type'] });
    if (api === 'rules' && req.method() === 'GET') return json(200, { rules });
    if (api === 'rules' && req.method() === 'POST') {
      if (body.name === 'bad') return json(400, { error: 'invalid rule', problems: ['actions[0].topic is required'] });
      rules.push({ ...body, _id: 'new-rule', problems: [] });
      return json(201, { rule: body, created: true });
    }
    let m;
    if ((m = api.match(/^rules\/([^/]+)$/))) {
      if (req.method() === 'PUT') { rules = rules.map((r) => (r._id === m[1] ? { ...body, problems: [] } : r)); return json(200, { rule: body }); }
      if (req.method() === 'DELETE') { rules = rules.filter((r) => r._id !== m[1]); return json(200, { deleted: m[1] }); }
    }
    if ((m = api.match(/^rules\/([^/]+)\/enabled$/))) {
      rules = rules.map((r) => (r._id === m[1] ? { ...r, enabled: body.enabled } : r));
      return json(200, { id: m[1] });
    }
    if (api === 'dry-run') return json(200, { checked: 100, matched: [{ source: 'imap', from: 'a@bank.test', to: ['me@gmail.com'], subject: 'Your code 123456', created_at: '2026-10-13T06:00:00' }] });
    if (api === 'test') return json(200, { results: [{ type: 'ntfy', ok: true, detail: 'ntfy abc' }] });
    if (api.startsWith('status')) return json(200, { messages: [{ source: 'smtp', subject: 'Hello', status: 'done', rules: ['otp'], errors: [], created_at: '2026-10-13T06:01:00' }] });
    return json(404, { error: 'not found' });
  });

  await page.goto(ORIGIN + '/rules');
  await page.waitForSelector('#rules-body tr.rule-row');
  const rows = page.locator('#rules-body tr.rule-row');
  assert.equal(await rows.count(), 2);
  assert.equal(await page.evaluate(() => window.pwned), undefined, 'rule names must not be parsed as HTML');
  assert.equal(await rows.nth(1).locator('img').count(), 0);
  assert.ok((await rows.nth(1).innerText()).includes('<img src=x'), 'the raw name is shown as text');
  // .env rule: toggle disabled, no delete button, view-only editor
  assert.equal(await rows.nth(0).locator('input[type=checkbox]').isDisabled(), true);
  assert.equal(await rows.nth(0).locator('.btn-outline-danger').count(), 0);
  await rows.nth(0).locator('button').first().click();
  // bootstrap CSS is stubbed out, so check the d-none class rather than visibility
  const hidden = (sel) => page.locator(sel).evaluate((n) => n.classList.contains('d-none'));
  assert.equal(await hidden('#editor-readonly'), false);
  assert.equal(await hidden('#btn-save'), true);
  assert.equal(await page.locator('#f-name').isDisabled(), true);
  assert.equal(await page.locator('#actions-box input').first().isDisabled(), true);
  await page.evaluate(() => document.querySelector('[data-bs-dismiss=modal]').click());

  if (lang === 'en') {
    assert.equal(await page.locator('h1 [data-i18n=title]').innerText(), 'Forwarding & push rules');
    assert.ok((await rows.nth(1).innerText()).includes('to: otp-*@example.com'));
    await browser.close();
    assert.deepEqual(errors, []);
    return;
  }

  // Edit the ntfy rule: fields come back, the PUT carries the same structure
  await rows.nth(1).locator('button[title="编辑"]').click();
  assert.equal(await page.locator('#f-to').inputValue(), 'otp-*@example.com');
  assert.equal(await page.locator('#f-src-imap').isChecked(), true);
  assert.equal(await page.locator('#f-stop').isChecked(), true);
  assert.equal(await page.locator('[data-key=topic]').inputValue(), 'secret-topic');
  assert.equal(await page.locator('[data-key=priority]').inputValue(), '4');
  await page.fill('#f-subject', 'code\n验证码');
  await page.click('#btn-save');
  await page.waitForFunction(() => document.getElementById('ruleModal').style.display === 'none');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.api, 'rules/otp');
  assert.equal(put.type, 'application/json');
  assert.deepEqual(put.body, {
    name: EVIL, order: 10, enabled: true, stop: true, _id: 'otp',
    match: { to: ['otp-*@example.com'], subject: ['code', '验证码'], source: ['smtp', 'imap'] },
    actions: [{ type: 'ntfy', topic: 'secret-topic', priority: 4 }, { type: 'tag', tags: ['otp'] }],
  });

  // New rule: defaults to smtp only (no source key), one ntfy action; add a tag action; dry run + test
  await page.click('#btn-new');
  assert.equal(await page.locator('#actions-box .action-card').count(), 1);
  await page.fill('#f-name', 'Bank alerts');
  await page.fill('#f-from', '*@bank.test, alerts@card.test');
  await page.selectOption('#f-attach', 'false');
  await page.fill('[data-key=topic]', 'bank-7f3a');
  await page.selectOption('#add-action-type', 'mark_read');
  await page.click('#btn-add-action');
  await page.click('#btn-dry-run');
  await page.waitForSelector('#editor-result:not(.d-none)');
  assert.ok((await page.locator('#editor-result-title').innerText()).includes('最近 100 封里命中 1 封'));
  assert.ok((await page.locator('#editor-result-body').innerText()).includes('Your code 123456'));
  await page.click('#btn-test');
  await page.waitForFunction(() => document.getElementById('editor-result-title').textContent === '测试推送结果');
  assert.ok((await page.locator('#editor-result-body').innerText()).includes('ntfy abc'));
  const dry = calls.find((c) => c.api === 'dry-run');
  assert.deepEqual(dry.body.rule.match, { from: ['*@bank.test', 'alerts@card.test'], has_attachments: false });
  assert.equal(dry.body.limit, 100);
  await page.click('#btn-save');
  await page.waitForFunction(() => document.getElementById('ruleModal').style.display === 'none');
  const post = calls.filter((c) => c.method === 'POST' && c.api === 'rules').pop();
  assert.deepEqual(post.body.actions, [{ type: 'ntfy', topic: 'bank-7f3a' }, { type: 'mark_read' }]);
  assert.equal('_id' in post.body, false);
  await page.waitForFunction(() => document.querySelectorAll('#rules-body tr.rule-row').length === 3);

  // Server-side validation errors are shown in the editor
  await page.click('#btn-new');
  await page.fill('#f-name', 'bad');
  await page.click('#btn-save');
  await page.waitForSelector('#editor-error:not(.d-none)');
  assert.ok((await page.locator('#editor-error').innerText()).includes('actions[0].topic is required'));
  await page.evaluate(() => document.querySelector('[data-bs-dismiss=modal]').click());

  // Toggle and delete
  await page.locator('#rules-body tr.rule-row').nth(1).locator('input[type=checkbox]').click();
  await page.waitForFunction(() => document.querySelectorAll('#rules-body tr.rule-off').length === 1);
  assert.deepEqual(calls.find((c) => c.api === 'rules/otp/enabled').body, { enabled: false });
  await page.locator('#rules-body tr.rule-row').nth(1).locator('.btn-outline-danger').click();
  await page.waitForFunction(() => document.querySelectorAll('#rules-body tr.rule-row').length === 2);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.api === 'rules/otp'));

  assert.ok((await page.locator('#status-body').innerText()).includes('Hello'));
  await browser.close();
  assert.deepEqual(errors, []);
}

(async () => {
  await run('zh');
  await run('en');
  console.log('rules page: list, edit, new, dry run, test push, validation, toggle, delete, read-only env rule, escaping, English passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
