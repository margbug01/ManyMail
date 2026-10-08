const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'mail-viewer/imap-mail-app/public/email-privacy.js'), 'utf8');
const viewer = fs.readFileSync(path.join(root, 'mail-viewer/templates/index.html'), 'utf8');
const imap = fs.readFileSync(path.join(root, 'mail-viewer/imap-mail-app/public/index.html'), 'utf8');
const viewerRenderer = viewer.slice(viewer.indexOf('        function _computeBodyScale('), viewer.indexOf('        function _updateUnreadBadge('));
const imapRenderer = imap.slice(imap.indexOf('      var renderProtectedBody = function('), imap.indexOf("      iframe.src = 'about:blank';"));
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6i0cAAAAASUVORK5CYII=';
const fixture = '<p id="text">Readable message</p>' +
  '<img src="https://tracker.invalid/pixel?id=unique" srcset="https://tracker.invalid/srcset 2x">' +
  '<img src="data:image/png;base64,' + pixel + '">' +
  '<style>@import "https://tracker.invalid/import"; p{background:url(https://tracker.invalid/css)} @font-face{font-family:track;src:url(https://tracker.invalid/font)} p{font-family:track}</style>' +
  '<p style="background:image-set(url(https://tracker.invalid/set) 1x)">CSS probe</p>' +
  '<img src="/api/image-proxy?url=https://tracker.invalid/injected">' +
  '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">' +
  '<a href="https://tracker.invalid/click" ping="https://tracker.invalid/ping">Link</a>' +
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
      const page = await browser.newPage();
      const leaks = [];
      await page.route('https://tracker.invalid/**', route => {
        leaks.push(route.request().url());
        return route.abort();
      });
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.addScriptTag({ content: shared });
      await page.evaluate(({ renderer, viewerRenderer, imapRenderer, fixture }) => {
        const iframe = document.querySelector('iframe');
        if (renderer === 'viewer') {
          window.renderFixture = new Function('iframe', 'content', 'var _mailBodyResizeObserver = null;' + viewerRenderer + '; _renderMailBodyIframe(iframe, content);');
        } else {
          window.renderFixture = new Function('iframe', 'content', 'var data = {html:content};' + imapRenderer + '; renderProtectedBody(false);');
        }
        window.renderFixture(iframe, fixture);
      }, { renderer, viewerRenderer, imapRenderer, fixture });
      await page.waitForTimeout(350);
      assert.equal(received.length, 0, renderer + ': automatic proxy requests');
      assert.equal(leaks.length, 0, renderer + ': direct tracking requests');
      assert.equal(await page.evaluate(() => !!window.compromised), false);
      assert.equal(await page.frameLocator('iframe').locator('#text').textContent(), 'Readable message');
      assert.equal(await page.frameLocator('iframe').locator('form,script,iframe').count(), 0);
      assert.equal(await page.frameLocator('iframe').locator('a').getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await page.frameLocator('iframe').locator('img[src^="data:"]').count(), 1);
      assert.ok(await page.frameLocator('iframe').locator('img[src^="data:"]').evaluate(image => image.naturalWidth > 0), renderer + ': inline image did not render');
      page.once('dialog', dialog => dialog.dismiss());
      await page.locator('[data-email-privacy]').click();
      await page.waitForTimeout(100);
      assert.equal(received.length, 0, renderer + ': canceled consent');
      page.once('dialog', dialog => dialog.accept());
      await page.locator('[data-email-privacy]').click();
      await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('img[src^="/api/image-proxy"]').complete);
      assert.equal(received.length, 1, renderer + ': explicit proxy request missing');
      assert.equal(received[0].referer, undefined, renderer + ': referrer leaked');
      assert.equal(leaks.length, 0, renderer + ': consent must not enable direct requests');
      await page.locator('[data-email-privacy]').click();
      await page.evaluate(fixture => window.renderFixture(document.querySelector('iframe'), fixture), fixture);
      await page.waitForTimeout(150);
      assert.equal(received.length, 1, renderer + ': consent persisted on reopen');
      assert.equal(await page.frameLocator('iframe').locator('img[src^="/api/image-proxy"]').count(), 0);
      console.log(renderer + ': default requests=0, canceled requests=0, consent proxy requests=1, direct requests=0, reopen requests=0');
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
