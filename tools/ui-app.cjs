// Serves the real main page (web/templates/index.html + the built web/static/app/main.js) to
// Playwright with every /api/* call stubbed. Shared by the test-*.cjs files that drive the main UI.
//   const { openApp } = require('./ui-app.cjs');
//   const { page, errors } = await openApp(browser, { api: async (pathname, body, route) => ({ success: true }) });
// `api` returns the JSON reply (undefined = empty success), or fulfills the route itself and returns null.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ORIGIN = 'http://manymail.test';
const BUNDLE = path.join(WEB, 'static/app/main.js');

assert.ok(fs.existsSync(BUNDLE), 'web/static/app/main.js missing: run npm ci && npm run build in frontend/ (tools/test-ui.sh does this)');

const PAGE = fs.readFileSync(path.join(WEB, 'templates/index.html'), 'utf8')
  .replace('{{asset "css/app.css"}}', '/static/css/app.css')
  .replace('{{shared "i18n.js"}}', '/i18n.js')
  .replace('{{asset "app/main.js"}}', '/static/app/main.js');
assert.ok(!PAGE.includes('{{'), 'unhandled template tag in index.html');

// tools/test-ui.sh installs the template's bootstrap / bootstrap-icons / quill versions under
// UI_TEST_MODULES; /npm/<pkg>@<ver>/<path> maps to those files. Missing ones become stubs.
function cdnLocal(pathname) {
  const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(pathname);
  if (!m || !process.env.UI_TEST_MODULES) return null;
  const file = path.join(process.env.UI_TEST_MODULES, m[1], m[2]);
  return fs.existsSync(file) ? file : null;
}
const HAVE_REAL_CSS = Boolean(cdnLocal('/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css') && cdnLocal('/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css'));
const HAVE_QUILL = Boolean(cdnLocal('/npm/quill@2.0.3/dist/quill.js'));
const BOOTSTRAP_STUB = `window.bootstrap = {
  Modal: class { constructor(el) { this.el = el; } show() { this.el.style.display = 'block'; this.el.classList.add('show'); } hide() { this.el.style.display = 'none'; this.el.classList.remove('show'); } static getOrCreateInstance(el) { return el._m || (el._m = new this(el)); } },
  Offcanvas: class { static getInstance() { return null; } },
};`;

// UI text as the app shows it: zh/en from frontend/src/langs.ts, the rest from i18n/*.json.
const langsSrc = fs.readFileSync(path.join(ROOT, 'frontend/src/langs.ts'), 'utf8');
const start = langsSrc.indexOf('{', langsSrc.indexOf('const LANGS = {'));
const LANGS = vm.runInNewContext('(' + langsSrc.slice(start, langsSrc.indexOf('\n};', start) + 2) + ')');
function text(code, key) {
  if (LANGS[code]) return LANGS[code][key];
  const file = path.join(ROOT, 'i18n', code + '.json');
  const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return (json.app || {})[key] || LANGS[code === 'zh-TW' ? 'zh' : 'en'][key];
}

async function launch() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  return chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
}

async function openApp(browser, { locale = 'zh-CN', viewport = { width: 1366, height: 900 }, api, extra, storage, beforeGoto } = {}) {
  const context = await browser.newContext({ locale, viewport });
  if (storage) await context.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } }, storage);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'cdn.jsdelivr.net') {
      const local = cdnLocal(url.pathname);
      if (local) return route.fulfill({ path: local });
      if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: url.pathname.includes('bootstrap') ? BOOTSTRAP_STUB : '' });
      return route.fulfill({ contentType: 'text/css', body: '' });
    }
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    if (url.pathname === '/i18n.js' || url.pathname === '/email-privacy.js') return route.fulfill({ path: path.join(WEB, 'shared', url.pathname) });
    if (url.pathname.startsWith('/static/')) return route.fulfill({ path: path.join(WEB, url.pathname) });
    // extra(url, route) handles the request by returning route.fulfill(...)'s promise, or returns undefined
    const handled = extra ? extra(url, route) : undefined;
    if (handled !== undefined) return handled;
    if (url.pathname === '/api/domains' && req.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, domains: [{ domain: 'example.test', is_active: true }, { domain: 'other.test', is_active: true }] }) });
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const reply = api ? await api(url.pathname, body, route, url) : undefined;
    if (reply === null) return; // handler fulfilled the route itself
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply === undefined ? { success: true, messages: [], total: 0 } : reply) });
  });
  if (beforeGoto) await beforeGoto(page, context);
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('#mail-layout');
  return { page, context, errors };
}

// Pick a language from the navbar menu, as a user would.
async function chooseLanguage(page, name) {
  await page.locator('#btn-lang').click();
  await page.locator('#lang-menu button', { hasText: name }).evaluate((b) => b.click());
}

// Query a mailbox through the left panel.
async function queryMailbox(page, prefix, domain = 'example.test') {
  await page.locator('#inbox-domain').selectOption(domain);
  await page.locator('#inbox-prefix').fill(prefix);
  await page.locator('#inbox-prefix').press('Enter');
}

module.exports = { ORIGIN, HAVE_REAL_CSS, HAVE_QUILL, cdnLocal, launch, openApp, chooseLanguage, queryMailbox, text };
