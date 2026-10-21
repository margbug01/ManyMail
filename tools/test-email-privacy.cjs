const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { openApp, queryMailbox } = require('./ui-app.cjs');

const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'imap-bridge/public/email-privacy.js'), 'utf8');
const imap = fs.readFileSync(path.join(root, 'imap-bridge/public/app.js'), 'utf8');
const imapRenderer = imap.slice(imap.indexOf('      var renderProtectedBody = function('), imap.indexOf("      iframe.src = 'about:blank';"));
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6i0cAAAAASUVORK5CYII=';
const fixture = '<p id="text">Readable message</p>' +
  '<img src="https://tracker.invalid/pixel?id=unique" srcset="https://tracker.invalid/srcset 2x">' +
  '<img src="data:image/png;base64,' + pixel + '">' +
  '<style>@import "https://tracker.invalid/import"; p{background:url(https://tracker.invalid/css)} @font-face{font-family:track;src:url(https://tracker.invalid/font)} p{font-family:track}</style>' +
  '<p style="background:image-set(url(https://tracker.invalid/set) 1x)">CSS probe</p>' +
  '<img src="/api/image-proxy?url=https://tracker.invalid/injected">' +
  '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">' +
  '<a href="https://tracker.invalid/click?id=7&amp;utm_source=mail&amp;utm_campaign=x&amp;fbclid=abc&amp;mc_eid=u1" ping="https://tracker.invalid/ping">Link</a>' +
  '<a id="wrapped" href="https://www.google.com/url?q=https%3A%2F%2Fshop.invalid%2Fitem%3Fsku%3D9%26gclid%3Dzz&amp;sa=D">Wrapped</a>' +
  '<iframe src="https://tracker.invalid/frame"></iframe><form action="https://tracker.invalid/form"><input></form>' +
  '<meta http-equiv="refresh" content="0;url=https://tracker.invalid/refresh">' +
  '<script>parent.compromised=true</script><img onerror="parent.compromised=true">';

(async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/api/image-proxy')) {
      received.push({ url: request.url, referer: request.headers.referer });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      response.end(Buffer.from(pixel, 'base64'));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="en"><body><div id="message"><iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div></body></html>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH, headless: true } : { headless: true });
    for (const renderer of ['viewer', 'imap']) {
      received.length = 0;
      const leaks = [];
      let page;
      let frameSel = 'iframe';
      if (renderer === 'viewer') {
        // The main UI as shipped: open a mail whose body is the fixture.
        frameSel = '#mail-body-frame';
        ({ page } = await openApp(browser, {
          api: async (pathname, body, route) => {
            if (pathname === '/api/image-proxy') {
              received.push({ url: route.request().url(), referer: (await route.request().allHeaders()).referer });
              await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: Buffer.from(pixel, 'base64') });
              return null;
            }
            if (pathname === '/api/inbox/query') return { success: true, messages: [{ id: 'p1', subject: 'Probe', createdAt: '2026-03-01T08:00:00Z', seen: true }], total: 1 };
            if (pathname === '/api/inbox/detail') return { success: true, detail: { id: 'p1', subject: 'Probe', html: fixture, text: 'Readable message' } };
            return undefined;
          },
        }));
        await queryMailbox(page, 'me');
        page.renderFixture = async () => {
          await page.locator('.mail-item[data-msg-id="p1"] .mail-item-body').click();
          await page.waitForSelector('#mail-body-frame');
        };
      } else {
        page = await browser.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.addScriptTag({ content: shared });
        await page.evaluate(({ imapRenderer }) => {
          window.renderFixture = new Function('iframe', 'content', 'var data = {html:content};' + imapRenderer + '; renderProtectedBody(false);');
        }, { imapRenderer });
        page.renderFixture = () => page.evaluate(fixture => window.renderFixture(document.querySelector('iframe'), fixture), fixture);
      }
      // Registered last so it wins over the app harness route.
      await page.route('https://tracker.invalid/**', route => {
        leaks.push(route.request().url());
        return route.abort();
      });
      await page.renderFixture();
      await page.waitForTimeout(350);
      assert.equal(received.length, 0, renderer + ': automatic proxy requests');
      assert.equal(leaks.length, 0, renderer + ': direct tracking requests');
      assert.equal(await page.evaluate(() => !!window.compromised), false);
      assert.equal(await page.frameLocator(frameSel).locator('#text').textContent(), 'Readable message');
      assert.equal(await page.frameLocator(frameSel).locator('form,script,iframe').count(), 0);
      const link = page.frameLocator(frameSel).locator('a').first();
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      // 追踪参数去掉、业务参数保留；悬停能看到真实地址；跳转包装直接拆到目标
      assert.equal(await link.getAttribute('href'), 'https://tracker.invalid/click?id=7', renderer + ': tracking params not stripped');
      assert.equal(await link.getAttribute('title'), 'https://tracker.invalid/click?id=7');
      assert.equal(await page.frameLocator(frameSel).locator('#wrapped').getAttribute('href'), 'https://shop.invalid/item?sku=9', renderer + ': redirect wrapper not unwrapped');
      assert.equal(await page.frameLocator(frameSel).locator('img[src^="data:"]').count(), 1);
      assert.ok(await page.frameLocator(frameSel).locator('img[src^="data:"]').evaluate(image => image.naturalWidth > 0), renderer + ': inline image did not render');
      page.once('dialog', dialog => dialog.dismiss());
      await page.locator('[data-email-privacy]').click();
      await page.waitForTimeout(100);
      assert.equal(received.length, 0, renderer + ': canceled consent');
      page.once('dialog', dialog => dialog.accept());
      await page.locator('[data-email-privacy]').click();
      await page.waitForFunction(sel => document.querySelector(sel).contentDocument.querySelector('img[src^="/api/image-proxy"]')?.complete, frameSel);
      assert.equal(received.length, 1, renderer + ': explicit proxy request missing');
      assert.equal(received[0].referer, undefined, renderer + ': referrer leaked');
      assert.equal(leaks.length, 0, renderer + ': consent must not enable direct requests');
      await page.locator('[data-email-privacy]').click();
      await page.renderFixture();
      await page.waitForTimeout(150);
      assert.equal(received.length, 1, renderer + ': consent persisted on reopen');
      assert.equal(await page.frameLocator(frameSel).locator('img[src^="/api/image-proxy"]').count(), 0);
      console.log(renderer + ': default requests=0, canceled requests=0, consent proxy requests=1, direct requests=0, reopen requests=0');
      await page.context().close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
