// 主界面关键操作（frontend/ 构建出的 Solid 版）：查询与分页、切换邮箱和点邮件时的请求竞态、
// 搜索、勾选与批量、删除撤销、自动刷新合并、回收站/已发送、写信（真 Quill）、设置、刷新恢复、窄屏主从视图。
// 接口全是桩，服务端状态在下面的 server 里。
const assert = require('node:assert/strict');
const { HAVE_QUILL, launch, openApp, queryMailbox, text } = require('./ui-app.cjs');

const T = (key, params) => {
  let s = text('zh', key);
  for (const [k, v] of Object.entries(params || {})) s = s.replace(`{${k}}`, v);
  return s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = Date.parse('2026-03-01T08:00:00Z');
const mail = (id, n, extra = {}) => ({ id, from: { name: 'Sender ' + n, address: `s${n}@remote.test` }, subject: 'Subject ' + n, intro: 'intro ' + n, createdAt: new Date(BASE - n * 60000).toISOString(), seen: n % 2 === 0, ...extra });

const server = {
  boxes: {
    'me@example.test': Array.from({ length: 35 }, (_, i) => mail('i' + (i + 1), i + 1, i === 0 ? { extracted_code: '483920' } : {})),
    'other@example.test': [mail('o1', 1), mail('o2', 2)],
  },
  trash: { 'me@example.test': [] },
  queryDelay: {},
  // next inbox query answers with the mailbox as it is now, but only after this many ms
  queryLagOnce: 0,
  keyReply: { success: true, message: 'saved' },
  detailDelay: {},
  calls: [],
  sent: null,
};

async function api(pathname, body) {
  server.calls.push({ pathname, body });
  const box = body && server.boxes[body.email];
  switch (pathname) {
    case '/api/inbox/query': {
      await sleep(server.queryDelay[body.email] || 0);
      if (!box) return { success: false, message: 'no such mailbox' };
      const reply = { success: true, messages: box.slice(body.offset, body.offset + body.limit), total: box.length };
      if (server.queryLagOnce) {
        const lag = server.queryLagOnce;
        server.queryLagOnce = 0;
        await sleep(lag);
      }
      return reply;
    }
    case '/api/inbox/detail': {
      await sleep(server.detailDelay[body.message_id] || 0);
      const m = box.find((x) => x.id === body.message_id) || (server.trash[body.email] || []).find((x) => x.id === body.message_id);
      return m ? { success: true, detail: { ...m, to: [{ address: body.email }], text: 'text of ' + m.subject, html: `<p id="b">${m.subject}</p>`, attachments: [{ id: 'a1', filename: 'report.pdf', size: 2048 }] } } : { success: false, message: 'gone' };
    }
    case '/api/inbox/search':
      return { success: true, messages: box.filter((m) => m.subject.includes(body.query)) };
    case '/api/inbox/batch': {
      if (body.action === 'mark_read') box.forEach((m) => { if (body.message_ids.includes(m.id)) m.seen = true; });
      if (body.action === 'delete') moveToTrash(body.email, body.message_ids);
      if (body.action === 'restore') restore(body.email, body.message_ids);
      return { success: true };
    }
    case '/api/inbox/delete': moveToTrash(body.email, [body.message_id]); return { success: true };
    case '/api/inbox/restore': restore(body.email, [body.message_id]); return { success: true, message: 'ok' };
    case '/api/inbox/permanent-delete': server.trash[body.email] = server.trash[body.email].filter((m) => m.id !== body.message_id); return { success: true };
    case '/api/trash/query': return { success: true, messages: server.trash[body.email] || [], total: (server.trash[body.email] || []).length };
    case '/api/sent/query': return { success: true, messages: [{ id: 's1', to: ['x@remote.test'], subject: 'Sent one', createdAt: new Date(BASE).toISOString() }], total: 1 };
    case '/api/sent/detail': return { success: true, detail: { id: 's1', to: ['x@remote.test'], subject: 'Sent one', html: '<p>sent body</p>', createdAt: new Date(BASE).toISOString() } };
    case '/api/send': server.sent = body; return { success: true };
    case '/api/settings/sender-keys': return { success: true, domains: [{ domain: 'example.test', hint: 're_…abcd', source: 'settings' }, { domain: 'other.test' }] };
    default:
      if (pathname.startsWith('/api/settings/sender-keys/')) return server.keyReply;
      return undefined;
  }
}

function moveToTrash(email, ids) {
  const box = server.boxes[email];
  server.trash[email] = (server.trash[email] || []).concat(box.filter((m) => ids.includes(m.id)));
  server.boxes[email] = box.filter((m) => !ids.includes(m.id));
}
function restore(email, ids) {
  const back = server.trash[email].filter((m) => ids.includes(m.id));
  server.trash[email] = server.trash[email].filter((m) => !ids.includes(m.id));
  server.boxes[email] = server.boxes[email].concat(back).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

const rowIds = (page) => page.locator('#mail-list .mail-item').evaluateAll((els) => els.map((e) => e.dataset.msgId));
const until = async (fn, what, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out: ' + what);
    await sleep(50);
  }
};

(async () => {
  const browser = await launch();
  try {
    const { page, context, errors } = await openApp(browser, { api, beforeGoto: (p) => p.clock.install() });

    // 域名下拉、空前缀报错
    assert.deepEqual(await page.locator('#inbox-domain option').allTextContents(), ['example.test', 'other.test']);
    assert.equal(await page.locator('#inbox-domain-display').textContent(), '@example.test');
    await page.locator('#btn-query-inbox').click();
    assert.equal(await page.locator('#inbox-error').textContent(), T('enterPrefixErr'));

    // 查询 + 分页 + 未读数 + 最近邮箱
    await queryMailbox(page, 'me');
    await until(async () => (await rowIds(page)).length === 30, 'first page');
    assert.equal(await page.locator('#inbox-error').count(), 0);
    assert.match(await page.locator('#btn-load-more').textContent(), /\(30\/35\)/);
    assert.equal(await page.locator('#unread-badge').textContent(), '15');
    assert.equal(await page.locator('.recent-pill-label').first().textContent(), 'me@example.test');
    assert.equal(await page.locator('.mail-item[data-msg-id="i1"] .code-badge').textContent(), '483920');
    await page.locator('#btn-load-more').click();
    await until(async () => (await rowIds(page)).length === 35, 'second page');
    assert.equal(await page.locator('#btn-load-more').count(), 0);

    // 竞态 1：慢的旧邮箱查询晚回来，不能盖掉后查的新邮箱
    server.queryDelay['me@example.test'] = 600;
    await queryMailbox(page, 'me');
    await queryMailbox(page, 'other');
    await sleep(900);
    assert.deepEqual(await rowIds(page), ['o1', 'o2'], 'stale mailbox reply overwrote the list');
    assert.equal(await page.locator('#btn-query-inbox').isDisabled(), false);
    server.queryDelay = {};

    // 竞态 2：先点的邮件详情晚回来，不能盖掉后点的
    await page.locator('.recent-pill-label', { hasText: 'me@example.test' }).click();
    await until(async () => (await rowIds(page)).length === 30, 'back to me');
    server.detailDelay.i1 = 600;
    await page.locator('.mail-item[data-msg-id="i1"] .mail-item-body').click();
    await page.locator('.mail-item[data-msg-id="i2"] .mail-item-body').click();
    await sleep(900);
    assert.match(await page.locator('#mail-detail-head').innerText(), /Subject 2/);
    assert.equal(await page.locator('.mail-item.active').getAttribute('data-msg-id'), 'i2');
    assert.match(await page.locator('#mail-detail-head a[download]').getAttribute('href'), /^\/api\/inbox\/attachment\/i2\/a1\?email=me%40example\.test&filename=report\.pdf$/);
    assert.equal(await page.frameLocator('#mail-body-frame').locator('#b').textContent(), 'Subject 2');
    server.detailDelay = {};

    // 打开未读邮件后变已读
    await page.locator('.mail-item[data-msg-id="i3"] .mail-item-body').click();
    await until(async () => !(await page.locator('.mail-item[data-msg-id="i3"]').getAttribute('class')).includes('mail-unread'), 'i3 read');
    assert.equal(await page.locator('#unread-badge').textContent(), '14');

    // 勾选 + 批量已读
    await page.locator('.mail-checkbox[value="i5"]').check();
    await page.locator('.mail-checkbox[value="i7"]').check();
    assert.equal(await page.locator('#selected-count').textContent(), T('selected', { n: 2 }));
    await page.locator('#btn-batch-read').click();
    await until(async () => !(await page.locator('.mail-item[data-msg-id="i5"]').getAttribute('class')).includes('mail-unread'), 'batch read');
    assert.equal(await page.locator('#unread-badge').textContent(), '12');
    assert.equal(await page.locator('#selected-count').textContent(), '');

    // 批量删除 + 撤销
    await page.locator('.mail-checkbox[value="i9"]').check();
    await page.locator('#btn-batch-delete').click();
    await until(async () => !(await rowIds(page)).includes('i9'), 'batch delete');
    await page.locator('.app-toast-action').click();
    await until(async () => (await rowIds(page)).includes('i9'), 'undo batch delete');
    assert.deepEqual(server.calls.filter((c) => c.pathname === '/api/inbox/batch').map((c) => c.body.action), ['mark_read', 'delete', 'restore']);

    // 自动刷新：新邮件插到最前；已加载的第二页、打开的邮件、勾选都保留
    await page.locator('#btn-load-more').click();
    await until(async () => (await rowIds(page)).length === 35, 'second page again');
    await page.locator('.mail-item[data-msg-id="i2"] .mail-item-body').click();
    await page.locator('#mail-detail-head').waitFor();
    await page.locator('.mail-checkbox[value="i11"]').check();
    await page.locator('#auto-refresh-toggle').check();
    server.boxes['me@example.test'].unshift(mail('n1', 0));
    await page.clock.runFor(15000);
    await until(async () => (await rowIds(page))[0] === 'n1', 'auto refresh');
    const afterRefresh = await rowIds(page);
    assert.equal(afterRefresh.length, 36, 'load-more pages kept');
    assert.equal(new Set(afterRefresh).size, 36, 'duplicates after merge');
    assert.equal(await page.locator('.mail-item.active').getAttribute('data-msg-id'), 'i2');
    assert.equal(await page.locator('.mail-checkbox[value="i11"]').isChecked(), true);
    assert.match(await page.locator('#mail-detail-head').innerText(), /Subject 2/);
    const queriesBefore = server.calls.filter((c) => c.pathname === '/api/inbox/query').length;
    // 切到已发送：自动刷新关掉，定时器停
    await page.locator('#tab-sent').click();
    assert.equal(await page.locator('#auto-refresh-toggle').isChecked(), false);
    await page.locator('#auto-refresh-toggle').click();
    assert.equal(await page.locator('#auto-refresh-toggle').isChecked(), false, 'auto refresh must stay off outside the inbox');
    await page.clock.runFor(31000);
    assert.equal(server.calls.filter((c) => c.pathname === '/api/inbox/query').length, queriesBefore, 'inbox polled from Sent');

    // 已发送详情
    await page.locator('.mail-item[data-msg-id="s1"]').click();
    await page.frameLocator('#sent-body-frame').locator('p').waitFor();
    assert.match(await page.locator('#mail-detail-head').innerText(), /x@remote\.test/);

    // 搜索：结果不分页；清除后回到整页列表；没结果有提示
    await page.locator('#tab-inbox').click();
    await page.locator('#search-input').fill('Subject 1');
    await page.locator('#search-input').press('Enter');
    await until(async () => (await rowIds(page)).every((id) => /^i1\d?$/.test(id)) && (await rowIds(page)).length === 11, 'search results');
    assert.equal(await page.locator('#btn-load-more').count(), 0);
    await page.locator('#search-input').fill('nothing-like-this');
    await page.locator('#btn-search').click();
    await page.locator('.empty-state', { hasText: T('noMatch') }).waitFor();
    await page.locator('.empty-state .btn-refresh').click();
    await until(async () => (await rowIds(page)).length === 36, 'search cleared');
    assert.equal(await page.locator('#search-input').inputValue(), '');

    // 详情里删除 + 撤销
    await page.locator('.mail-item[data-msg-id="i8"] .mail-item-body').click();
    await page.locator(`#mail-detail-head button[aria-label="${T('delete')}"]`).click();
    await until(async () => !(await rowIds(page)).includes('i8'), 'single delete');
    assert.equal((await page.locator('#mail-detail-content').innerText()).trim(), T('selectMailHint'));
    await page.locator('.app-toast-action').last().click();
    await until(async () => (await rowIds(page)).includes('i8'), 'undo single delete');

    // 回收站：恢复（可逆，直接做）、彻底删除（要确认）
    await page.locator('.mail-item[data-msg-id="i8"] .mail-item-body').click();
    await page.locator(`#mail-detail-head button[aria-label="${T('delete')}"]`).click();
    await page.locator('.mail-item[data-msg-id="i10"] .mail-item-body').click();
    await page.locator(`#mail-detail-head button[aria-label="${T('delete')}"]`).click();
    await page.locator('#tab-trash').click();
    await until(async () => (await rowIds(page)).length === 2, 'trash list');
    await page.locator('.mail-item[data-msg-id="i8"]').click();
    await page.locator(`#mail-detail-head button[aria-label="${T('restore')}"]`).click();
    await until(async () => (await rowIds(page)).join() === 'i10', 'restored from trash');
    await page.locator('.mail-item[data-msg-id="i10"]').click();
    await page.locator(`#mail-detail-head button[aria-label="${T('permanentDelete')}"]`).click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#confirm-message').textContent(), T('confirmPermanentDelete'));
    await page.locator('#confirm-ok').click();
    await until(async () => (await rowIds(page)).length === 0, 'permanent delete');
    await page.locator('.empty-state', { hasText: T('noTrashMail') }).waitFor();
    await page.locator('#confirmModal').waitFor({ state: 'hidden' });
    // 恢复的邮件回到收件箱
    await page.locator('#tab-inbox').click();
    await until(async () => (await rowIds(page)).includes('i8'), 'restored mail back in inbox');

    // 设置：域名列表、校验、发信 Key
    await page.locator('#btn-settings').click();
    await page.locator('#settingsModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#domain-list .small').count(), 2);
    await page.locator('#new-domain-input').fill('x');
    await page.locator('#btn-add-domain').click();
    assert.equal(await page.locator('#domain-error').textContent(), T('domainInvalid'));
    await page.locator('#sender-key-list .sender-key-row').first().waitFor();
    assert.match(await page.locator('#sender-key-list').innerText(), /re_…abcd/);
    assert.match(await page.locator('#sender-key-list').innerText(), new RegExp(T('keyNone')));
    await page.locator('#sender-key-list .sender-key-row').nth(1).locator('button.btn-link').click();
    assert.equal(await page.locator('#sender-key-list .sender-key-editor:not(.d-none) input').evaluate((el) => el === document.activeElement), true);
    // 保存失败、接口没给 message：提示不能是空的
    const openEditor = page.locator('#sender-key-list .sender-key-editor:not(.d-none)');
    server.keyReply = { success: false };
    await openEditor.locator('input').fill('re_bad');
    await openEditor.locator('button.btn-primary').click();
    await until(async () => (await openEditor.locator(':scope > div.small').textContent()) === T('loadFailed'), 'key error text');
    // 保存成功：列表重载，编辑框收起；再次打开设置也是收起的
    server.keyReply = { success: true, message: 'saved' };
    await openEditor.locator('button.btn-primary').click();
    await until(async () => (await page.locator('#sender-key-list .sender-key-row').count()) === 2 && (await openEditor.count()) === 0, 'key editor closed after save');
    await page.locator('#sender-key-list .sender-key-row').nth(1).locator('button.btn-link').click();
    assert.equal(await openEditor.count(), 1);
    await page.locator('#settingsModal .btn-close').click();
    await page.locator('#settingsModal').waitFor({ state: 'hidden' });
    await page.locator('#btn-settings').click();
    await page.locator('#sender-key-list .sender-key-row').nth(1).waitFor();
    assert.equal(await openEditor.count(), 0, 'key editor still open after reopening settings');
    await page.locator('#settingsModal .btn-close').click();
    await page.locator('#settingsModal').waitFor({ state: 'hidden' });

    if (!HAVE_QUILL) {
      console.log('SKIP compose: quill not installed (run via tools/test-ui.sh)');
    } else {
      // 写信：chip 校验、附件、发送内容
      await page.locator('.navbar .btn-primary.btn-sm').click();
      await page.locator('#composeModal').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#compose-from-prefix').inputValue(), 'me');
      assert.equal(await page.locator('#compose-from-domain').inputValue(), 'example.test');
      await page.locator('#compose-to-input').fill('a@remote.test, bad');
      await page.locator('#compose-to-input').press('Enter');
      assert.equal(await page.locator('#compose-to-chips .chip').count(), 2);
      assert.equal(await page.locator('#compose-to-chips .chip-invalid').count(), 1);
      await page.locator('#compose-subject').fill('Hello there');
      await page.locator('#composeModal .ql-editor').fill('Body line');
      await page.locator('#compose-files').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('attached!') });
      await page.locator('#compose-attachments .chip').waitFor();
      await page.locator('#btn-send-email').click();
      assert.equal(await page.locator('#compose-alert').textContent(), T('invalidRecipient'));
      await page.locator('#compose-to-chips .chip-invalid .chip-remove').click();
      await page.locator('#btn-send-email').click();
      await page.locator('#compose-alert.alert-success').waitFor();
      assert.equal(server.sent.from_email, 'me@example.test');
      assert.equal(server.sent.to, 'a@remote.test');
      assert.equal(server.sent.subject, 'Hello there');
      assert.match(server.sent.html, /Body line/);
      assert.deepEqual(server.sent.attachments, [{ filename: 'note.txt', content: Buffer.from('attached!').toString('base64'), contentType: 'text/plain' }]);
      await page.clock.runFor(2500);
      await page.locator('#composeModal').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => localStorage.getItem('manymail-draft')), null);

      // 回复：收件人、主题前缀；有内容时取消要确认
      await page.locator('.mail-item[data-msg-id="i2"] .mail-item-body').click();
      await page.locator(`#mail-detail-head button[aria-label="${T('reply')}"]`).click();
      await page.locator('#composeModal').waitFor({ state: 'visible' });
      assert.deepEqual(await page.locator('#compose-to-chips .chip-text').allTextContents(), ['s2@remote.test']);
      assert.equal(await page.locator('#compose-subject').inputValue(), 'Re: Subject 2');
      assert.equal(await page.locator('#compose-alert').count(), 0, 'old alert left over');
      await page.locator('#composeModal .modal-footer .btn-outline-secondary').click();
      await page.locator('#confirmModal').waitFor({ state: 'visible' });
      await page.locator('#confirm-ok').click();
      await page.locator('#composeModal').waitFor({ state: 'hidden' });
    }

    // 刷新页面：回到同一个邮箱、同一封邮件
    await page.locator('.mail-item[data-msg-id="i4"] .mail-item-body').click();
    await page.locator('#mail-detail-head').waitFor();
    await page.reload();
    await until(async () => (await page.locator('.mail-item.active').getAttribute('data-msg-id').catch(() => null)) === 'i4', 'view restored', 5000);
    assert.equal(await page.locator('#inbox-prefix').inputValue(), 'me');
    assert.match(await page.locator('#mail-detail-head').innerText(), /Subject 4/);

    // 空前缀查询：报错，同时关掉已打开的邮件（和旧版一样）
    await page.locator('#inbox-prefix').fill('');
    await page.locator('#btn-query-inbox').click();
    assert.equal(await page.locator('#inbox-error').textContent(), T('enterPrefixErr'));
    assert.equal((await page.locator('#mail-detail-content').innerText()).trim(), T('selectMailHint'));

    // 停在已发送时查另一个邮箱：已发送列表跟着换，不能一直转圈
    await page.locator('#tab-sent').click();
    await page.locator('.mail-item[data-msg-id="s1"]').waitFor();
    await queryMailbox(page, 'other');
    await until(async () => server.calls.some((c) => c.pathname === '/api/sent/query' && c.body.email === 'other@example.test'), 'sent reloaded for the new mailbox');
    await page.locator('.mail-item[data-msg-id="s1"]').waitFor();
    assert.equal(await page.locator('#mail-list .spinner-border').count(), 0);
    assert.equal(await page.locator('#tab-sent').getAttribute('aria-pressed'), 'true');

    // 在已发送查邮箱、还没回来就切回收件箱：等的是新邮箱，不能换成旧邮箱
    server.queryDelay['me@example.test'] = 600;
    await queryMailbox(page, 'me');
    await page.locator('#tab-inbox').click();
    await sleep(900);
    server.queryDelay = {};
    const meRows = await rowIds(page);
    assert.ok(meRows.includes('i2') && !meRows.includes('o1'), 'inbox shows the previous mailbox: ' + meRows.slice(0, 3));

    // 另一个邮箱查询失败：列表显示错误，批量栏和勾选都不能再作用在上一个邮箱的邮件上
    await page.locator('.mail-checkbox[value="i5"]').check();
    await queryMailbox(page, 'bad');
    await page.locator('#mail-list .error-state').waitFor();
    assert.equal(await page.locator('#batch-bar').isVisible(), false, 'batch bar over an error state');
    assert.equal(await page.locator('#selected-count').textContent(), '');
    await queryMailbox(page, 'me');
    await until(async () => (await rowIds(page)).length === 30, 'me again');

    // 自动刷新拿到的就是整个邮箱（条数 = limit = total）：别处删掉的邮件不能留在列表里
    await page.locator('#btn-load-more').click();
    const loaded = server.boxes['me@example.test'].length;
    await until(async () => (await rowIds(page)).length === loaded, 'all pages loaded');
    const box = server.boxes['me@example.test'];
    const gone = box[box.length - 1].id;
    server.boxes['me@example.test'] = [mail('n2', -1)].concat(box.slice(0, -1));
    await page.locator('#auto-refresh-toggle').check();
    await page.clock.runFor(15000);
    await until(async () => (await rowIds(page))[0] === 'n2', 'refresh with a full mailbox');
    const full = await rowIds(page);
    assert.equal(full.length, loaded, 'list length after refresh');
    assert.ok(!full.includes(gone), 'mail deleted elsewhere is still listed');

    // 刷新请求在删除前发出、删除后才回来：删掉的邮件不能被它放回来
    server.queryLagOnce = 700;
    const queriesSoFar = server.calls.filter((c) => c.pathname === '/api/inbox/query').length;
    await page.clock.runFor(15000);
    await until(async () => server.calls.filter((c) => c.pathname === '/api/inbox/query').length > queriesSoFar, 'refresh sent');
    await page.locator('.mail-checkbox[value="i3"]').check();
    await page.locator('#btn-batch-delete').click();
    await until(async () => !(await rowIds(page)).includes('i3'), 'deleted during refresh');
    await sleep(1000);
    assert.ok(!(await rowIds(page)).includes('i3'), 'late refresh reply brought back a deleted mail');
    await page.locator('#auto-refresh-toggle').uncheck();

    // 停在回收站切到 IMAP 后刷新页面：点「邮件」回到回收站
    await page.locator('#tab-trash').click();
    await page.locator('#tab-imap').click();
    await page.reload();
    await page.locator('#tab-imap[aria-pressed="true"]').waitFor();
    await page.locator('#tab-mail').click();
    assert.equal(await page.locator('#tab-trash').getAttribute('aria-pressed'), 'true', 'last folder lost after reload on the IMAP tab');

    assert.deepEqual(errors, []);
    await context.close();

    // 停用域名：域名里的 # ? 要编码，否则路径被截断，停用的是另一个域名
    const odd = await openApp(browser, {
      api,
      extra: (url, route) => (url.pathname === '/api/domains' && route.request().method() === 'GET'
        ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, domains: [{ domain: 'odd#x.test', is_active: true }] }) })
        : undefined),
    });
    await odd.page.locator('#btn-settings').click();
    await odd.page.locator(`#domain-list button[title="${T('disableDomain')}"]`).click();
    await odd.page.locator('#confirmModal').waitFor({ state: 'visible' });
    await odd.page.locator('#confirm-ok').click();
    await until(async () => server.calls.some((c) => c.pathname.startsWith('/api/domains/')), 'domain delete sent');
    assert.equal(server.calls.find((c) => c.pathname.startsWith('/api/domains/')).pathname, '/api/domains/odd%23x.test');
    assert.deepEqual(odd.errors, []);
    await odd.context.close();

    // 窄屏：列表 → 详情 → 返回；抽屉按钮在
    const phone = await openApp(browser, { api, viewport: { width: 390, height: 844 } });
    await phone.page.locator('#btn-left-drawer').click();
    await phone.page.locator('#mail-left-column.show').waitFor();
    await queryMailbox(phone.page, 'other');
    await phone.page.locator('#mail-left-column.show').waitFor({ state: 'detached' });
    await phone.page.locator('.mail-item[data-msg-id="o1"] .mail-item-body').click();
    await phone.page.locator('#mail-detail-head').waitFor();
    assert.equal(await phone.page.locator('#mail-list-column').isVisible(), false);
    assert.equal(await phone.page.locator('#mail-detail-column').isVisible(), true);
    await phone.page.locator('.mail-detail-back').click();
    assert.equal(await phone.page.locator('#mail-list-column').isVisible(), true);
    assert.equal(await phone.page.locator('#mail-detail-column').isVisible(), false);
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(phone.errors, []);
    await phone.context.close();

    console.log('main UI: query/paging, mailbox + detail races, read state, batch + undo, auto-refresh merge, search, trash, settings, '
      + (HAVE_QUILL ? 'compose + reply, ' : '') + 'view restore, empty query, folder + race on mailbox switch, batch on error, refresh edge + race, IMAP restore, domain encoding, phone layout passed');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
