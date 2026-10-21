const assert = require('node:assert/strict');
const { launch, openApp, queryMailbox, HAVE_REAL_CSS, HAVE_QUILL } = require('./ui-app.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const message = { id: 'a1', subject: 'HTML only', from: { address: 'sender@remote.test' }, createdAt: '2026-01-01T00:00:00Z' };
(async () => {
  assert.ok(HAVE_REAL_CSS && HAVE_QUILL, 'real Bootstrap and Quill required');
  const browser = await launch();
  try {
    const calls = [];
    let queryGate, deleteGate, detailGate, keyGate;
    const app = await openApp(browser, {
      storage: { 'manymail-recent': JSON.stringify(Array.from({ length: 8 }, (_, index) => `recent${index}@example.test`)) },
      api: async (path, body) => {
        calls.push({ path, body });
        if (path === '/api/inbox/query') {
          if (body.email === 'b@example.test' && queryGate) await queryGate.promise;
          return { success: true, messages: body.email === 'b@example.test' ? [] : [message], total: body.email === 'b@example.test' ? 0 : 1 };
        }
        if (path === '/api/inbox/detail') {
          if (detailGate) await detailGate.promise;
          return { success: true, detail: { ...message, text: '', html: '<p>Quoted &amp; safe</p><p>Second<br>line</p><script>window.quoteInjected=true</script><img src="https://untrusted.invalid/pixel" onerror="window.quoteInjected=true">' } };
        }
        if (path === '/api/trash/query' || path === '/api/inbox/search') return { success: true, messages: path.includes('search') && body.query === 'empty' ? [] : [message], total: 1 };
        if (path === '/api/inbox/batch') {
          if (body.action === 'delete' && deleteGate) await deleteGate.promise;
          return { success: true };
        }
        if (path === '/api/settings/sender-keys') return { success: true, domains: [{ domain: 'example.test' }] };
        if (path.startsWith('/api/settings/sender-keys/')) { if (keyGate) await keyGate.promise; return { success: false, message: 'retry' }; }
        if (path === '/api/send') throw new Error('sending forbidden in regression test');
      },
    });
    const { page } = app;
    const waitCalls = async (path, count) => { for (let attempt = 0; attempt < 100; attempt++) { if (calls.filter(call => call.path === path).length >= count) return; await pause(20); } throw new Error('missing request: ' + path); };
    await queryMailbox(page, 'a');
    await page.locator('.mail-item[data-msg-id="a1"]').waitFor();
    queryGate = deferred();
    await queryMailbox(page, 'b');
    await waitCalls('/api/inbox/query', 2);
    assert.equal(await page.locator('#btn-refresh-mail').isDisabled(), true);
    await page.locator('#btn-refresh-mail').evaluate(button => { button.disabled = false; button.click(); });
    await pause(80);
    assert.equal(calls.filter(call => call.path === '/api/inbox/query').length, 2, 'refresh cancelled the pending mailbox query');
    queryGate.resolve();
    await page.waitForFunction(() => !document.querySelector('#btn-query-inbox').disabled);
    assert.equal(await page.locator('.mail-item').count(), 0);

    await queryMailbox(page, 'a');
    await page.locator('.mail-checkbox[value="a1"]').check();
    deleteGate = deferred();
    await page.locator('#btn-batch-delete').click();
    await waitCalls('/api/inbox/batch', 1);
    await page.locator('#search-input').fill('empty');
    await page.locator('#search-input').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.mail-item'));
    deleteGate.resolve();
    await page.locator('.app-toast-action').last().click();
    await waitCalls('/api/inbox/batch', 2);
    assert.deepEqual(calls.filter(call => call.path === '/api/inbox/batch').at(-1).body.message_ids, ['a1']);
    await page.locator('#mail-list .empty-state .btn-refresh').click();
    await page.locator('.mail-item[data-msg-id="a1"]').waitFor();

    await page.locator('#tab-trash').click();
    await page.locator('.mail-item[data-msg-id="a1"]').waitFor();
    queryGate = deferred();
    await queryMailbox(page, 'b');
    await page.locator('.mail-item[data-msg-id="a1"]').click();
    await page.locator('#mail-detail-head').waitFor();
    queryGate.resolve();
    await page.waitForFunction(() => !document.querySelector('#btn-query-inbox').disabled);
    assert.equal(await page.locator('#mail-detail-head').count(), 0, 'old mailbox detail survived switching');
    await queryMailbox(page, 'a');
    await page.locator('.mail-item[data-msg-id="a1"]').waitFor();
    queryGate = deferred();
    await queryMailbox(page, 'b');
    detailGate = deferred();
    await page.locator('.mail-item[data-msg-id="a1"]').click();
    await waitCalls('/api/inbox/detail', 2);
    queryGate.resolve();
    await page.waitForFunction(() => !document.querySelector('#btn-query-inbox').disabled);
    detailGate.resolve();
    await pause(100);
    assert.equal(await page.locator('#mail-detail-head').count(), 0, 'late old mailbox detail survived switching');
    detailGate = null;
    await queryMailbox(page, 'a');
    await page.locator('#tab-inbox').click();
    await page.locator('.mail-item[data-msg-id="a1"] .mail-item-body').click();
    await page.locator('#mail-detail-head button:has(.bi-reply)').click();
    await page.locator('#composeModal').waitFor({ state: 'visible' });
    const quote = await page.locator('#compose-editor .ql-editor').innerText();
    assert.match(quote, /Quoted & safe\s+Second\s+line/);
    assert.ok(!quote.includes('quoteInjected'));
    assert.equal(await page.locator('#compose-editor img, #compose-editor script').count(), 0);

    await page.evaluate(() => {
      window.pendingReaders = [];
      window.FileReader = class {
        readAsDataURL(file) { window.pendingReaders.push({ name: file.name, done: () => { this.result = 'data:application/octet-stream;base64,YQ=='; this.onload(); } }); }
      };
    });
    const pick = async files => {
      await page.locator('#compose-files').evaluate((input, entries) => {
        const transfer = new DataTransfer();
        for (const [name, size] of entries) transfer.items.add(new File([new Uint8Array(size)], name));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, files);
    };
    const finish = async name => page.evaluate(name => { const index = window.pendingReaders.findIndex(reader => reader.name === name); if (index < 0) throw new Error('missing reader ' + name); window.pendingReaders.splice(index, 1)[0].done(); }, name);
    const mb = 1024 * 1024;
    await pick([['first', 4 * mb]]); await finish('first');
    await pick([['second', 4 * mb], ['third', 4 * mb]]);
    await page.locator('#compose-attachments .chip-remove').first().click();
    await finish('second');
    await finish('third');
    assert.equal(await page.locator('#compose-attachments .chip').count(), 2, 'removed attachment still counted in batch total');
    await page.locator('#compose-attachments .chip-remove').first().click();
    await pick([['concurrent1', 4 * mb]]);
    await pick([['concurrent2', 4 * mb]]);
    await finish('concurrent2'); await finish('concurrent1');
    assert.equal(await page.locator('#compose-attachments .chip').count(), 2, 'concurrent readers exceeded 10MB');
    await pick([['old-draft', mb]]);
    await page.locator('#composeModal .modal-footer .btn-outline-secondary').click();
    await page.locator('#confirm-ok').click();
    await page.locator('#composeModal').waitFor({ state: 'hidden' });
    await page.locator('.navbar button:has(.bi-pencil-square)').click();
    await page.locator('#composeModal').waitFor({ state: 'visible' });
    await finish('old-draft');
    assert.equal(await page.locator('#compose-attachments .chip').count(), 0, 'old reader leaked into a new draft');
    await page.locator('#composeModal .modal-footer .btn-outline-secondary').click();
    await page.locator('#composeModal').waitFor({ state: 'hidden' });

    await page.locator('#mail-detail-head button:has(.bi-arrow-right-short)').click();
    await page.locator('#composeModal').waitFor({ state: 'visible' });
    assert.match(await page.locator('#compose-editor .ql-editor').innerText(), /Quoted & safe\s+Second\s+line/);
    assert.equal(await page.locator('#compose-editor img, #compose-editor script').count(), 0);
    await page.locator('#composeModal .modal-footer .btn-outline-secondary').click();
    await page.locator('#confirm-ok').click();
    await page.locator('#composeModal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));

    await page.locator('#btn-settings').click();
    await page.locator('.sender-key-row .btn-link').click();
    await page.locator('.sender-key-editor input').fill('test-only-key');
    keyGate = deferred();
    await page.locator('.sender-key-editor input').evaluate(input => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitCalls('/api/settings/sender-keys/example.test', 1);
    await page.locator('.sender-key-editor input').press('Enter');
    await pause(80);
    assert.equal(calls.filter(call => call.path === '/api/settings/sender-keys/example.test').length, 1, 'keyboard reentered key save');
    keyGate.resolve();
    await page.waitForFunction(() => !document.querySelector('.sender-key-editor .btn-primary').disabled);
    await page.locator('#settingsModal .btn-close').click();
    await page.locator('#settingsModal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));

    for (const viewport of [{ width: 1024, height: 527 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 1366, height: 400 }, { width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 992) await page.locator('#btn-left-drawer').click();
      const pill = page.locator('.recent-pill-label').last();
      await pill.scrollIntoViewIfNeeded();
      const reachable = await pill.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return rect.top >= 0 && rect.bottom <= innerHeight && (el === hit || el.contains(hit));
      });
      if (!reachable) console.log(await pill.evaluate(el => { const out = []; for (let node = el; node; node = node.parentElement) { const r = node.getBoundingClientRect(); const s = getComputedStyle(node); out.push({ cls: node.className, y: r.y, height: r.height, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflow: s.overflow, flex: s.flex }); } return out; }));
      assert.ok(reachable, 'recent mailbox inaccessible at ' + JSON.stringify(viewport));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow at ' + JSON.stringify(viewport));
      if (viewport.width < 992) { await page.locator('#mail-left-column .btn-close').click(); await pause(400); }
      console.log('layout reachable:', viewport.width + 'x' + viewport.height);
    }
    assert.deepEqual(app.errors, []);
    await app.context.close();
    console.log('review regressions passed: request races, undo snapshot, keyboard lock, concurrent FileReader, draft generation, HTML quote, layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
