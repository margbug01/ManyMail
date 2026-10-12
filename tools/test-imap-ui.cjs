// IMAP 子应用的行为测试：刷新恢复视图、列表缓存与预取、新邮件轮询刷新、/imap 代理前缀。
// 接口全部用桩模拟（带人为延迟），只挂在 /imap/api/ 下，没带前缀的请求会被记成错误。
//   PLAYWRIGHT_MODULE=<playwright-core 路径> BROWSER_PATH=<chrome> node tools/test-imap-ui.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PUBLIC = path.resolve(__dirname, '../mail-viewer/imap-mail-app/public');
const ORIGIN = 'http://manymail.test';
const LIST_DELAY = 400;
const STATUS_DELAY = 800;
const BASE_TIME = Date.parse('2026-10-01T00:00:00Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 服务器端状态：每个「账号|文件夹」一组按 UID 递增的邮件；versions 是 /api/changes 的收件箱版本号
const store = {};
const versions = { 1: 0, 2: 0, 3: 0 };
const mailOf = (acc, folder, uid) => ({ uid, from: { name: 'S' + uid, address: 's' + uid + '@x.test' }, subject: acc + ':' + folder + ' #' + uid, date: new Date(BASE_TIME + uid * 60000).toISOString(), seen: true, flagged: false });
function mailbox(acc, folder) {
  const key = acc + '|' + folder;
  if (!store[key]) store[key] = Array.from({ length: acc === '3' && folder === 'INBOX' ? 40 : 3 }, (_, i) => mailOf(acc, folder, 100 + i));
  return store[key];
}
function deliver(acc) {
  const box = mailbox(String(acc), 'INBOX');
  box.push(mailOf(String(acc), 'INBOX', box[box.length - 1].uid + 1));
  versions[acc]++;
  return box[box.length - 1].uid;
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    const json = o => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (p === '/imap/') return route.fulfill({ path: path.join(PUBLIC, 'index.html'), contentType: 'text/html' });
    if (!p.startsWith('/imap/api/')) {
      if (p.startsWith('/imap/')) return route.fulfill({ path: path.join(PUBLIC, p.slice(6)) });
      errors.push('request without /imap prefix: ' + p);
      return route.abort();
    }
    const api = p.slice(5);
    requests.push(api + url.search);
    let m;
    if (api === '/api/accounts') return json([1, 2, 3].map(id => ({ id, email: 'u' + id + '@example.test' })));
    if (api === '/api/changes') return json({ accounts: Object.fromEntries(Object.entries(versions).map(([id, v]) => [id, { inbox: v }])) });
    if (/^\/api\/accounts\/\d+\/folders$/.test(api)) { await sleep(LIST_DELAY); return json([{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent' }]); }
    if (api.endsWith('/folders/status')) { await sleep(STATUS_DELAY); return json([{ path: 'INBOX', unseen: 1 }, { path: 'Sent', unseen: 0 }]); }
    if ((m = api.match(/^\/api\/accounts\/(\d+)\/mails$/))) {
      await sleep(LIST_DELAY);
      const box = mailbox(m[1], url.searchParams.get('folder'));
      const count = Number(url.searchParams.get('count')) || 30;
      const end = url.searchParams.get('before') ? Number(url.searchParams.get('before')) - 1 : box.length;
      const start = Math.max(1, end - count + 1);
      const mails = box.slice(start - 1, end).map((mail, i) => ({ ...mail, seq: start + i })).reverse();
      return json({ mails, total: box.length, unseen: null, hasMore: start > 1 });
    }
    if ((m = api.match(/^\/api\/accounts\/\d+\/mails\/(\d+)$/))) return json({ uid: Number(m[1]), subject: 'subject', from: { name: 'S', address: 's@x.test' }, to: [], date: new Date(BASE_TIME).toISOString(), text: 'body ' + m[1], html: null, attachments: [] });
    if (/\/search$/.test(api)) return json([{ uid: 999, seq: 1, from: { name: 'S', address: 's@x.test' }, subject: 'SEARCH HIT', date: new Date(BASE_TIME).toISOString(), seen: true }]);
    return json({});
  });

  const subjects = () => page.$$eval('.mail-row .mail-subject', els => els.map(e => e.textContent));
  const state = () => page.evaluate(() => ({ account: activeAccountId, folder: activeFolder, uid: mailCache[selectedMailIndex] ? mailCache[selectedMailIndex].uid : null, detail: document.getElementById('mail-detail').innerText }));
  const count = re => requests.filter(r => re.test(r)).length;
  const firstRowHas = text => page.waitForFunction(t => { const e = document.querySelector('.mail-row .mail-subject'); return e && e.textContent.includes(t); }, text, { timeout: 3000 });
  async function timeUntilRow(text, action) {
    const start = Date.now();
    await action();
    await page.waitForFunction(t => [...document.querySelectorAll('.mail-row .mail-subject')].some(e => e.textContent.includes(t)), text, { timeout: 5000 });
    return Date.now() - start;
  }
  const step = (name, detail) => console.log('ok  ' + name + (detail ? '  (' + detail + ')' : ''));

  await page.goto(ORIGIN + '/imap/?embedded=1');
  await sleep(300);
  assert.equal((await state()).account, null);
  step('fresh load selects nothing');

  let t = await timeUntilRow('2:INBOX #100', () => page.evaluate(() => { selectAccount(2); }));
  assert.ok(t >= LIST_DELAY - 50, 'uncached list should wait for the network: ' + t);
  assert.match(await page.textContent('#mail-info'), /^共 3 封$/);
  await sleep(STATUS_DELAY + 300);
  assert.match(await page.textContent('#mail-info'), /未读 1/);
  step('uncached account waits for network, unread count fills in later', t + 'ms');

  await sleep(1500 + 2 * 2 * LIST_DELAY + 500);  // 预取：其他账号的收件箱 + 文件夹
  assert.ok(count(/^\/api\/accounts\/1\/mails\?/) >= 1 && count(/^\/api\/accounts\/3\/mails\?/) >= 1, 'other accounts should be prefetched');
  t = await timeUntilRow('1:INBOX #102', () => page.evaluate(() => { selectAccount(1); }));
  assert.ok(t < 250, 'prefetched account should render from cache: ' + t);
  step('prefetched account renders instantly', t + 'ms');
  await sleep(LIST_DELAY + 200);

  const folderRequests = count(/\/folders$/);
  await timeUntilRow('1:Sent #100', () => page.evaluate(() => { selectFolder('Sent'); }));
  t = await timeUntilRow('1:INBOX #102', () => page.evaluate(() => { selectFolder('INBOX'); }));
  assert.ok(t < 250, 'revisited folder should render from cache: ' + t);
  assert.equal(count(/\/folders$/), folderRequests, 'switching folders must not refetch the folder list');
  step('switching back to a folder is instant, folder list not refetched', t + 'ms');
  await sleep(LIST_DELAY + 200);

  // 新邮件：打开着一封邮件时后台刷新，详情和选中都不能动
  await page.locator('.mail-row').nth(2).click();
  await sleep(300);
  assert.equal((await state()).uid, 100);
  let uid = deliver(1);
  await page.evaluate(() => pollChanges());
  await firstRowHas('#' + uid);
  let s = await state();
  assert.equal(s.uid, 100, 'selection must survive the background refresh');
  assert.ok(s.detail.includes('body 100'), 'open message must stay open');
  assert.equal(await page.locator('.mail-row.active').count(), 1);
  step('new mail appears on poll, open message and selection kept');

  // 「加载更多」翻出来的旧邮件在后台刷新后要还在
  await timeUntilRow('3:INBOX #139', () => page.evaluate(() => { selectAccount(3); }));
  await sleep(LIST_DELAY + 200);
  assert.equal((await subjects()).length, 30);
  await page.evaluate(() => loadMoreMails());
  assert.equal((await subjects()).length, 40);
  uid = deliver(3);
  await page.evaluate(() => pollChanges());
  await firstRowHas('#' + uid);
  assert.equal((await subjects()).length, 41, 'older mails from "load more" must be kept');
  step('background refresh keeps "load more" results', '41 rows');

  // 不在眼前的账号：缓存在后台更新，切过去直接是新的
  uid = deliver(2);
  await page.evaluate(() => pollChanges());
  await sleep(LIST_DELAY + 300);
  t = await timeUntilRow('2:INBOX #' + uid, () => page.evaluate(() => { selectAccount(2); }));
  assert.ok(t < 250, 'background-updated cache should already contain the new mail: ' + t);
  step('new mail in another account is already in its cache', t + 'ms');
  await sleep(LIST_DELAY + 200);

  // 搜索结果不能被轮询刷新顶掉，也不写进文件夹缓存
  await page.fill('#search-input', 'x');
  await page.evaluate(() => doSearch());
  await sleep(200);
  deliver(2);
  await page.evaluate(() => pollChanges());
  await sleep(LIST_DELAY + 300);
  assert.deepEqual(await subjects(), ['SEARCH HIT']);
  step('search results survive polling');

  // 刷新页面：回到原账号/文件夹/邮件，列表先从缓存画出来
  await page.evaluate(() => { selectFolder('INBOX'); });
  await sleep(LIST_DELAY + 300);
  await page.locator('.mail-row').nth(1).click();
  await sleep(300);
  const before = await state();
  const start = Date.now();
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.mail-row').length > 0, null, { timeout: 5000 });
  t = Date.now() - start;
  assert.ok(t < LIST_DELAY + 150, 'reload should paint the list from cache: ' + t);
  await sleep(LIST_DELAY + 500);
  s = await state();
  assert.equal(s.account, before.account);
  assert.equal(s.folder, before.folder);
  assert.equal(s.uid, before.uid);
  assert.ok(s.detail.includes('body ' + before.uid));
  step('reload restores account, folder and open message', 'list in ' + t + 'ms');

  await page.keyboard.press('Escape');
  await sleep(200);
  await page.reload();
  await sleep(LIST_DELAY + 500);
  s = await state();
  assert.equal(s.account, before.account);
  assert.equal(s.uid, null);
  step('closed message stays closed after reload');

  await page.evaluate(() => sessionStorage.setItem('manymail-imap-view', JSON.stringify({ account: 99, folder: 'INBOX', uid: 1 })));
  await page.reload();
  await sleep(LIST_DELAY + 300);
  assert.equal((await state()).account, null);
  step('stale saved account falls back to the default view');

  assert.deepEqual(errors, [], errors.join(' | '));
  await browser.close();
  console.log('IMAP UI: all passed');
// 失败时浏览器还开着，直接退出，免得部署门禁卡住
})().catch(error => { console.error(error); process.exit(1); });
