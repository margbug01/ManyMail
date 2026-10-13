// 主界面切换语言：已打开的邮件头部、按钮、占位提示要立刻换语言，正文 iframe 不重载；
// 选择要记住，没选过时按浏览器语言来。接口全是桩。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const VIEWER = path.resolve(__dirname, '../mail-viewer');
const ORIGIN = 'http://manymail.test';
const html = fs.readFileSync(path.join(VIEWER, 'templates/index.html'), 'utf8')
  .replace("{{ url_for('static', filename='favicon.svg') }}", '/static/favicon.svg')
  .replace("{{ asset_url('css/app.css') }}", '/static/css/app.css')
  .replace("{{ shared_url('i18n.js') }}", '/i18n.js')
  .replace("{{ asset_url('js/app.js') }}", '/static/js/app.js');
assert.ok(!html.includes('{{'), 'unhandled template tag in index.html');
const BOOTSTRAP_STUB = `window.bootstrap = {
  Modal: class { show() {} hide() {} static getInstance() { return null; } static getOrCreateInstance() { return new this(); } },
  Dropdown: class { show() {} hide() {} toggle() {} static getOrCreateInstance() { return new this(); } },
};`;

// tools/test-ui.sh 把模板里同版本的 bootstrap / bootstrap-icons 装在 UI_TEST_MODULES 下；
// /npm/<包>@<版本>/<路径> 对到本地文件，找不到就用空样式（布局检查跳过）
function cdnLocal(pathname) {
  const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(pathname);
  if (!m || !process.env.UI_TEST_MODULES) return null;
  const file = path.join(process.env.UI_TEST_MODULES, m[1], m[2]);
  return fs.existsSync(file) ? file : null;
}
const HAVE_REAL_CSS = Boolean(cdnLocal('/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css') && cdnLocal('/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css'));

const MESSAGES = [
  { id: 'm1', from: { name: 'Alice', address: 'alice@example.test' }, subject: 'Hello', intro: 'hi', createdAt: '2026-03-01T08:00:00Z', seen: false },
  { id: 'm2', from: { name: 'Bob', address: 'bob@example.test' }, subject: 'Second', intro: 'yo', createdAt: '2026-03-02T08:00:00Z', seen: true },
];

async function openPage(browser, locale, storage) {
  const context = await browser.newContext({ locale, viewport: { width: 1366, height: 900 } });
  if (storage) await context.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('manymail-lang', s); } }, storage);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdn.jsdelivr.net') {
      if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: url.pathname.includes('bootstrap') ? BOOTSTRAP_STUB : '' });
      const local = cdnLocal(url.pathname);
      return local ? route.fulfill({ path: local }) : route.fulfill({ contentType: 'text/css', body: '' });
    }
    if (url.origin !== ORIGIN) return route.abort();
    const json = (o) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/i18n.js') return route.fulfill({ path: path.join(VIEWER, 'imap-mail-app/public/i18n.js') });
    if (url.pathname.startsWith('/static/')) return route.fulfill({ path: path.join(VIEWER, url.pathname) });
    if (url.pathname === '/email-privacy.js') return route.fulfill({ path: path.join(VIEWER, 'imap-mail-app/public/email-privacy.js') });
    if (url.pathname === '/api/domains') return json({ success: true, domains: [{ domain: 'example.test', is_active: true }] });
    if (url.pathname === '/api/inbox/detail') {
      const { message_id } = JSON.parse(route.request().postData());
      const msg = MESSAGES.find((m) => m.id === message_id);
      return json({ success: true, detail: { ...msg, to: [{ address: 'me@example.test' }], text: 'Body text', html: '<p id="body-marker">Body</p><img src="https://tracker.example/pixel.png">' } });
    }
    return json({ success: true, messages: [], total: 0 });
  });
  await page.goto(ORIGIN + '/');
  await page.waitForLoadState('networkidle');
  return { page, context, errors };
}

const headText = (page) => page.locator('#mail-detail-head').innerText();

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    // 1. 浏览器是中文：默认中文；打开一封邮件后切英文，头部立刻变，正文 iframe 是同一个
    const { page, context, errors } = await openPage(browser, 'zh-CN');
    assert.equal(await page.locator('#lang-label').textContent(), '中');
    assert.equal(await page.locator('#lang-menu button').count(), 9);
    await page.evaluate((msgs) => { currentEmail = 'me@example.test'; currentTab = 'inbox'; renderMessages(msgs); }, MESSAGES);
    await page.evaluate(() => viewMailDetail('m1', document.querySelector('.mail-item[data-msg-id="m1"]')));
    await page.waitForSelector('#mail-detail-head');
    assert.match(await headText(page), /回复/);
    await page.evaluate(() => { document.getElementById('mail-body-frame').dataset.keep = '1'; });

    await page.locator('#btn-lang').click();
    await page.locator('#lang-menu button', { hasText: 'English' }).evaluate((b) => b.click());
    let head = await headText(page);
    assert.match(head, /Reply/);
    assert.match(head, /From/);
    assert.doesNotMatch(head, /回复|发件人/);
    assert.equal(await page.evaluate(() => document.getElementById('mail-body-frame').dataset.keep), '1', 'body iframe was rebuilt');
    assert.equal(await page.locator('.mail-item.active').getAttribute('data-msg-id'), 'm1', 'active row lost');
    assert.equal(await page.locator('#lang-label').textContent(), 'EN');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');

    // 外部图片按钮在正文 iframe 外面，也要跟着换（以前只认中/英，且切换后不重画）
    const privacyBtn = page.locator('[data-email-privacy="control"]');
    assert.equal(await privacyBtn.textContent(), 'External images blocked · Load for this message');
    await page.evaluate(() => setLang('zh-TW'));
    assert.equal(await privacyBtn.textContent(), '外部圖片已封鎖 · 載入這封郵件的圖片');
    await page.evaluate(() => setLang('de'));
    assert.equal(await privacyBtn.textContent(), 'Externe Bilder blockiert · Für diese Nachricht laden');

    // 2. 日语：按钮、字段名、时间格式都跟着变
    await page.evaluate(() => setLang('ja'));
    head = await headText(page);
    assert.match(head, /返信/);
    assert.match(head, /2026\/3\/1/);
    assert.equal(await page.locator('#lang-label').textContent(), '日');
    assert.equal(await page.locator('#lang-menu .dropdown-item.active').textContent(), '日本語');

    // 3. 切到纯文本后换语言，切换按钮保持“看 HTML”的状态
    await page.evaluate(() => togglePlainText());
    await page.evaluate(() => setLang('de'));
    const plainBtn = await page.locator('#btn-toggle-plain').innerText();
    assert.equal(plainBtn.trim(), await page.evaluate(() => t('viewHtml')));
    assert.equal(await page.locator('#mail-body-plain').isVisible(), true);

    // 4. 已发送邮件的详情
    await page.evaluate(() => viewSentDetail(null, { to: ['x@example.test'], subject: 'S', createdAt: '2026-03-01T08:00:00Z', text: 'hi' }));
    await page.evaluate(() => setLang('fr'));
    assert.match(await headText(page), new RegExp(await page.evaluate(() => t('to'))));
    assert.doesNotMatch(await headText(page), /Empfänger|收件人/);

    // 5. 没打开邮件时，占位提示也要换
    await page.evaluate(() => resetMailDetail());
    await page.evaluate(() => setLang('ru'));
    assert.equal((await page.locator('#mail-detail-content').innerText()).trim(), await page.evaluate(() => t('selectMailHint')));
    assert.notEqual(await page.evaluate(() => t('selectMailHint')), '请选择一封邮件查看详情');

    // 中栏卡片头：任何语言、桌面常见宽度下都在一行（法语、俄语比中英文长得多）
    await page.evaluate(() => { const b = document.getElementById('unread-badge'); b.textContent = '99+'; b.style.display = 'inline'; });
    if (!HAVE_REAL_CSS) console.log('SKIP list header layout: bootstrap CSS not installed (run via tools/test-ui.sh)');
    for (const width of HAVE_REAL_CSS ? [992, 1100, 1366, 1920] : []) {
      await page.setViewportSize({ width, height: 900 });
      for (const code of ['zh', 'en', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'ru']) {
        await page.evaluate((c) => setLang(c), code);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const oneLine = await page.evaluate(() => {
          const kids = document.querySelector('.mail-list-header').children;
          return kids[kids.length - 1].getBoundingClientRect().top < kids[0].getBoundingClientRect().bottom - 1;
        });
        assert.ok(oneLine, `list header wraps: ${code} @ ${width}px`);
      }
    }
    // 桌面端邮件三栏和 IMAP 的底边对齐，而且卡片完整在屏幕内（以前三栏被 gutter 顶出 24px，IMAP 靠 calc 各算各的）
    for (const [width, height] of HAVE_REAL_CSS ? [[1100, 700], [1366, 768], [1920, 1080]] : []) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => switchTab('inbox'));
      const mailBottoms = await page.evaluate(() => ['#mail-list-column > .card', '#mail-detail-column > .card'].map(q => Math.round(document.querySelector(q).getBoundingClientRect().bottom)));
      await page.evaluate(() => switchTab('imap'));
      const imapBottom = await page.evaluate(() => Math.round(document.getElementById('imap-frame').getBoundingClientRect().bottom));
      assert.deepEqual(mailBottoms, [imapBottom, imapBottom], `bottoms differ @ ${width}x${height}: mail ${mailBottoms} imap ${imapBottom}`);
      assert.ok(imapBottom < height - 16, `cards should end above the window edge @ ${width}x${height}: ${imapBottom}`);
    }
    await page.evaluate(() => switchTab('inbox'));
    await page.evaluate(() => setLang('ru'));
    assert.deepEqual(errors, []);

    // 6. 刷新后记住选择
    await page.reload();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#lang-label').textContent(), 'RU');
    await context.close();

    // 7. 没选过：按浏览器语言；不支持的语言用英文；繁体按地区识别
    for (const [locale, label] of [['fr-FR', 'FR'], ['zh-TW', '繁'], ['pt-BR', 'EN']]) {
      const r = await openPage(browser, locale);
      assert.equal(await r.page.locator('#lang-label').textContent(), label, locale);
      assert.deepEqual(r.errors, []);
      await r.context.close();
    }
    console.log('language switch: open mail header, sent mail, placeholder, persistence, browser detection passed');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
