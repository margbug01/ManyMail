const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'mail-viewer/imap-mail-app/public/index.html'), 'utf8');
const hostTemplate = fs.readFileSync(path.join(root, 'mail-viewer/templates/index.html'), 'utf8');
const hostSizing = hostTemplate.slice(hostTemplate.indexOf('        function fitMobileImapFrame()'), hostTemplate.indexOf('        function ensureImapLoaded()'));
const privacy = fs.readFileSync(path.join(root, 'mail-viewer/imap-mail-app/public/email-privacy.js'), 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    for (const viewport of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1366, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'manymail.test') return route.abort();
        if (url.pathname === '/host') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}iframe{display:block;width:100%;border:0;min-height:80vh}</style><nav style="height:96px">Host navigation</nav><iframe id="imap-frame" src="/?embedded=1"></iframe><script>' + hostSizing + '; fitMobileImapFrame();</script>' });
        if (url.pathname.endsWith('email-privacy.js')) return route.fulfill({ contentType: 'text/javascript', body: privacy });
        if (url.pathname.includes('/api/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'text/html', body: html });
      });
      await page.goto('http://manymail.test/?embedded=1');
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => {
        document.getElementById('account-list').innerHTML = '<div class="account-item active">personal@example.test</div><div class="account-item">work@example.test</div>';
        document.getElementById('folder-section').style.display = 'block';
        document.getElementById('folder-list').innerHTML = ['INBOX', 'Sent', 'Drafts', 'Spam', 'Trash'].map(name => '<div class="folder-item" onclick="selectFolder(\'' + name + '\')">' + name + '</div>').join('');
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
        await page.locator('#mobile-nav-toggle').click();
        assert.equal(await page.locator('.sidebar').isVisible(), true);
        await page.locator('.folder-item').first().click();
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
        await page.goto('http://manymail.test/host');
        await page.waitForLoadState('networkidle');
        const frame = await page.locator('#imap-frame').boundingBox();
        assert.ok(frame.y + frame.height <= viewport.height);
        const list = await page.frameLocator('#imap-frame').locator('#mail-list').boundingBox();
        assert.ok(list.height > frame.height * 0.5);
        console.log('Nested host: list height=' + Math.round(list.height) + ', no outer overflow');
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
