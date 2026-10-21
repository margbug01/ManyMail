// 主界面切换语言：已打开的邮件头部、按钮、占位提示要立刻换语言，正文 iframe 不重载；
// 选择要记住，没选过时按浏览器语言来。接口全是桩，全程用界面操作驱动。
const assert = require('node:assert/strict');
const { HAVE_REAL_CSS, launch, openApp, chooseLanguage, queryMailbox, text } = require('./ui-app.cjs');

const MESSAGES = [
  { id: 'm1', from: { name: 'Alice', address: 'alice@example.test' }, subject: 'Hello', intro: 'hi', createdAt: '2026-03-01T08:00:00Z', seen: false },
  { id: 'm2', from: { name: 'Bob', address: 'bob@example.test' }, subject: 'Second', intro: 'yo', createdAt: '2026-03-02T08:00:00Z', seen: true },
];

async function api(pathname, body) {
  if (pathname === '/api/inbox/query') return { success: true, messages: MESSAGES, total: MESSAGES.length };
  if (pathname === '/api/inbox/detail') {
    const msg = MESSAGES.find((m) => m.id === body.message_id);
    return { success: true, detail: { ...msg, to: [{ address: 'me@example.test' }], text: 'Body text', html: '<p id="body-marker">Body</p><img src="https://tracker.example/pixel.png">' } };
  }
  if (pathname === '/api/sent/query') return { success: true, messages: [{ id: 's1', to: ['x@example.test'], subject: 'S', createdAt: '2026-03-01T08:00:00Z', text: 'hi' }], total: 1 };
  if (pathname === '/api/sent/detail') return { success: false };
  return undefined;
}

const setLang = (page, code) => page.evaluate((c) => {
  const lang = ManyMailI18n.languages.find((l) => l.code === c);
  document.querySelector('#btn-lang').click();
  [...document.querySelectorAll('#lang-menu button')].find((b) => b.textContent === lang.name).click();
}, code);
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const headText = (page) => page.locator('#mail-detail-head').innerText();

(async () => {
  const browser = await launch();
  try {
    // 1. 浏览器是中文：默认中文；打开一封邮件后切英文，头部立刻变，正文 iframe 是同一个
    const { page, context, errors } = await openApp(browser, { api });
    assert.equal(await page.locator('#lang-label').textContent(), '中');
    assert.equal(await page.locator('#lang-menu button').count(), 9);
    await queryMailbox(page, 'me');
    await page.locator('.mail-item[data-msg-id="m1"] .mail-item-body').click();
    await page.waitForSelector('#mail-detail-head');
    assert.match(await headText(page), /回复/);
    await page.evaluate(() => { document.getElementById('mail-body-frame').dataset.keep = '1'; });

    await chooseLanguage(page, 'English');
    let head = await headText(page);
    assert.match(head, /Reply/);
    assert.match(head, /From/);
    assert.doesNotMatch(head, /回复|发件人/);
    assert.equal(await page.evaluate(() => document.getElementById('mail-body-frame').dataset.keep), '1', 'body iframe was rebuilt');
    assert.equal(await page.locator('.mail-item.active').getAttribute('data-msg-id'), 'm1', 'active row lost');
    assert.equal(await page.locator('#lang-label').textContent(), 'EN');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US');

    // 外部图片按钮在正文 iframe 外面，也要跟着换
    const privacyBtn = page.locator('[data-email-privacy="control"]');
    assert.equal(await privacyBtn.textContent(), 'External images blocked · Load for this message');
    await setLang(page, 'zh-TW');
    assert.equal(await privacyBtn.textContent(), '外部圖片已封鎖 · 載入這封郵件的圖片');
    await setLang(page, 'de');
    assert.equal(await privacyBtn.textContent(), 'Externe Bilder blockiert · Für diese Nachricht laden');

    // 正文 iframe 高度贴着内容：窗口宽窄来回切后底下不能越攒越多空白
    const bodyGap = () => page.evaluate(() => {
      const f = document.getElementById('mail-body-frame');
      // iframe 自带 min-height:200px，短邮件按 200 算
      return f.offsetHeight - Math.max(200, Math.round(f.contentDocument.body.getBoundingClientRect().bottom));
    });
    for (const width of [390, 700, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const gap = await bodyGap();
      assert.ok(gap >= 0 && gap <= 4, `mail body iframe leaves ${gap}px blank @ ${width}px`);
    }

    // 2. 日语：按钮、字段名、时间格式都跟着变
    await setLang(page, 'ja');
    head = await headText(page);
    assert.match(head, /返信/);
    assert.match(head, /2026\/3\/1/);
    assert.equal(await page.locator('#lang-label').textContent(), '日');
    assert.equal(await page.locator('#lang-menu .dropdown-item.active').textContent(), '日本語');

    // 3. 切到纯文本后换语言，切换按钮保持“看 HTML”的状态
    await page.locator('#btn-toggle-plain').click();
    await setLang(page, 'de');
    assert.equal((await page.locator('#btn-toggle-plain').innerText()).trim(), text('de', 'viewHtml'));
    assert.equal(await page.locator('#mail-body-plain').isVisible(), true);

    // 4. 已发送邮件的详情（详情接口失败时用列表里的那份）
    await page.locator('#tab-sent').click();
    await page.locator('.mail-item[data-msg-id="s1"]').click();
    await page.waitForSelector('#sent-body-frame');
    await setLang(page, 'fr');
    assert.match(await headText(page), new RegExp(text('fr', 'to')));
    assert.doesNotMatch(await headText(page), /Empfänger|收件人/);

    // 5. 没打开邮件时，占位提示也要换
    await page.locator('#tab-inbox').click();
    await setLang(page, 'ru');
    assert.equal((await page.locator('#mail-detail-content').innerText()).trim(), text('ru', 'selectMailHint'));
    assert.notEqual(text('ru', 'selectMailHint'), '请选择一封邮件查看详情');

    // 中栏卡片头：任何语言、桌面常见宽度下都在一行（法语、俄语比中英文长得多）
    await page.evaluate(() => { const b = document.getElementById('unread-badge'); b.textContent = '99+'; b.style.display = 'inline'; });
    if (!HAVE_REAL_CSS) console.log('SKIP list header layout: bootstrap CSS not installed (run via tools/test-ui.sh)');
    for (const width of HAVE_REAL_CSS ? [992, 1100, 1366, 1920] : []) {
      await page.setViewportSize({ width, height: 900 });
      for (const code of ['zh', 'en', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'ru']) {
        await setLang(page, code);
        await settle(page);
        const oneLine = await page.evaluate(() => {
          const kids = document.querySelector('.mail-list-header').children;
          return kids[kids.length - 1].getBoundingClientRect().top < kids[0].getBoundingClientRect().bottom - 1;
        });
        assert.ok(oneLine, `list header wraps: ${code} @ ${width}px`);
      }
    }
    // 桌面端邮件三栏和 IMAP 的底边对齐，而且卡片完整在屏幕内
    for (const [width, height] of HAVE_REAL_CSS ? [[1100, 700], [1366, 768], [1920, 1080]] : []) {
      await page.setViewportSize({ width, height });
      await page.locator('#tab-mail').click();
      await settle(page);
      const mailBottoms = await page.evaluate(() => ['#mail-list-column > .card', '#mail-detail-column > .card'].map(q => Math.round(document.querySelector(q).getBoundingClientRect().bottom)));
      await page.locator('#tab-imap').click();
      await settle(page);
      const imapBottom = await page.evaluate(() => Math.round(document.getElementById('imap-frame').getBoundingClientRect().bottom));
      assert.deepEqual(mailBottoms, [imapBottom, imapBottom], `bottoms differ @ ${width}x${height}: mail ${mailBottoms} imap ${imapBottom}`);
      assert.ok(imapBottom < height - 16, `cards should end above the window edge @ ${width}x${height}: ${imapBottom}`);
    }
    await page.locator('#tab-mail').click();
    await setLang(page, 'ru');
    assert.deepEqual(errors, []);

    // 6. 刷新后记住选择
    await page.reload();
    await page.waitForSelector('#lang-label');
    assert.equal(await page.locator('#lang-label').textContent(), 'RU');
    await context.close();

    // 7. 没选过：按浏览器语言；不支持的语言用英文；繁体按地区识别
    for (const [locale, label] of [['fr-FR', 'FR'], ['zh-TW', '繁'], ['pt-BR', 'EN']]) {
      const r = await openApp(browser, { locale, api });
      assert.equal(await r.page.locator('#lang-label').textContent(), label, locale);
      assert.deepEqual(r.errors, []);
      await r.context.close();
    }
    console.log('language switch: open mail header, sent mail, placeholder, persistence, browser detection passed');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
