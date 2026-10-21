const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openApp } = require('./ui-app.cjs');
const root = path.resolve(__dirname, '..');
const imapPublic = path.join(root, 'imap-bridge/public');
const html = fs.readFileSync(path.join(imapPublic, 'index.html'), 'utf8');
const imapCss = fs.readFileSync(path.join(imapPublic, 'style.css'), 'utf8');
const imapJs = fs.readFileSync(path.join(imapPublic, 'app.js'), 'utf8');
const privacy = fs.readFileSync(path.join(root, 'imap-bridge/public/email-privacy.js'), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1366, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'manymail.test') return route.abort();
        if (url.pathname.endsWith('email-privacy.js')) return route.fulfill({ contentType: 'text/javascript', body: privacy });
        if (url.pathname.endsWith('/i18n.js')) return route.fulfill({ path: path.join(imapPublic, 'i18n.js') });
        if (url.pathname.endsWith('/app.js')) return route.fulfill({ contentType: 'text/javascript', body: imapJs });
        if (url.pathname.endsWith('/style.css')) return route.fulfill({ contentType: 'text/css', body: imapCss });
        if (url.pathname.includes('/api/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'text/html', body: html });
      });
      await page.goto('http://manymail.test/?embedded=1');
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => {
        document.getElementById('account-list').innerHTML = '<div class="account-item active" onclick="selectAccount(1)">personal@example.test</div><div class="account-item" onclick="selectAccount(2)">work@example.test</div>';
        mailCache = Array.from({ length: 30 }, (_, index) => ({ uid: index + 1, from: { name: 'Sender ' + index, address: 'sender@example.test' }, subject: 'A readable message subject for mobile ' + index, date: new Date().toISOString(), seen: false }));
        renderMailList(mailCache);
        syncResponsiveView();
      });
      const geometry = await page.locator('#mail-list').boundingBox();
      if (viewport.width < 992) {
        assert.ok(geometry.height >= viewport.height * 0.55, JSON.stringify({ viewport, geometry }));
        assert.ok(geometry.y + geometry.height <= viewport.height + 1);
        assert.equal(await page.locator('.sidebar').isVisible(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1), true);
        const typography = await page.locator('.mail-row').first().evaluate(row => {
          const sender = getComputedStyle(row.querySelector('.mail-from'));
          const subject = getComputedStyle(row.querySelector('.mail-subject'));
          return { senderSize: sender.fontSize, subjectSize: subject.fontSize, wrap: subject.whiteSpace, height: row.querySelector('.mail-subject').getBoundingClientRect().height };
        });
        assert.equal(typography.senderSize, '14px');
        assert.equal(typography.subjectSize, '14px');
        assert.equal(typography.wrap, 'nowrap');
        assert.equal(typography.height, 22);
        assert.match(await page.locator('.mail-date').first().textContent(), /^\d{2}:\d{2}$/);
        if (process.env.MOBILE_SCREENSHOT && viewport.width === 390) await page.screenshot({ path: process.env.MOBILE_SCREENSHOT });
        await page.locator('#mobile-nav-toggle').click();
        assert.equal(await page.locator('.sidebar').isVisible(), true);
        await page.locator('.account-item').nth(1).click();
        assert.equal(await page.locator('.sidebar').isVisible(), false);
        await page.evaluate(() => {
          document.getElementById('mail-detail').innerHTML = '<button class="detail-back" onclick="showMailListView()">Back</button>' + '<p>Long mail body</p>'.repeat(100);
          detailVisible = true;
          syncResponsiveView();
        });
        assert.equal(await page.locator('#mail-list').isVisible(), false);
        const detail = await page.locator('#mail-detail').boundingBox();
        assert.ok(detail.height >= viewport.height * 0.75);
        assert.ok(detail.y + detail.height <= viewport.height + 1);
        await page.locator('.detail-back').click();
        assert.equal(await page.locator('#mail-list').isVisible(), true);
      } else {
        assert.equal(await page.locator('.sidebar').isVisible(), true);
        assert.equal(await page.locator('#mobile-nav-toggle').isVisible(), false);
      }
      console.log(viewport.width + 'x' + viewport.height + ': list height=' + Math.round(geometry.height) + ', list top=' + Math.round(geometry.y) + '; navigation and detail passed');
      if (viewport.width < 992) {
        // The real main page hosting the IMAP sub-app on its IMAP tab
        const host = await openApp(browser, {
          viewport,
          extra: (url, route) => {
            if (!url.pathname.startsWith('/imap/')) return undefined;
            const file = url.pathname.slice('/imap/'.length);
            if (file === '') return route.fulfill({ contentType: 'text/html', body: html });
            if (file.startsWith('api/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
            return route.fulfill({ path: path.join(imapPublic, file) });
          },
        });
        await host.page.locator('#tab-imap').click();
        await host.page.frameLocator('#imap-frame').locator('#mail-list').waitFor();
        await host.page.waitForTimeout(100);
        const frame = await host.page.locator('#imap-frame').boundingBox();
        assert.ok(frame.y + frame.height <= viewport.height, JSON.stringify(frame));
        const list = await host.page.frameLocator('#imap-frame').locator('#mail-list').boundingBox();
        assert.ok(list.height > frame.height * 0.5);
        assert.equal(await host.page.locator('#btn-left-drawer').isVisible(), false, 'drawer button hidden on the IMAP tab');
        assert.deepEqual(host.errors, []);
        console.log('Nested host: list height=' + Math.round(list.height) + ', no outer overflow');

        // Main mail view on a phone: list first, detail replaces it, back returns
        await host.page.locator('#tab-mail').click();
        assert.equal(await host.page.locator('#btn-left-drawer').isVisible(), true);
        assert.equal(await host.page.locator('#mail-detail-column').isVisible(), false);
        assert.equal(await host.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'main page scrolls sideways');
        await host.context.close();
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
