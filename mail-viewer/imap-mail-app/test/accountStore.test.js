const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAccountStore, encryptAccount, decryptAccount } = require('../accountStore');
const { sanitizeEmailHtml, prepareHtmlForRender } = require('../sanitize');

test('account encryption round-trips without exposing plaintext', () => {
  const account = {
    name: 'gmail',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: 'user@example.com', pass: 'super-secret-password' },
  };
  const payload = encryptAccount(account, 'test-master-key');
  const serialized = JSON.stringify(payload);

  assert.doesNotMatch(serialized, /super-secret-password/);
  assert.deepStrictEqual(decryptAccount(payload, 'test-master-key'), account);
});

test('store skips persistence when encryption key is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manymail-store-'));
  const filePath = path.join(dir, 'accounts.json');
  const warnings = [];
  const store = createAccountStore({ filePath, logger: { warn: (msg) => warnings.push(msg) } });
  const clients = new Map([
    [1, { account: { auth: { user: 'u@example.com', pass: 'plain-password' } } }],
  ]);

  assert.strictEqual(store.save(clients), false);
  assert.strictEqual(fs.existsSync(filePath), false);
  assert.ok(warnings.some((msg) => msg.includes('IMAP_ACCOUNT_ENCRYPTION_KEY')));
});

test('store writes encrypted account file and refuses legacy plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manymail-store-'));
  const filePath = path.join(dir, 'accounts.json');
  const store = createAccountStore({
    filePath,
    encryptionKey: 'test-master-key',
    logger: { warn: () => {} },
  });
  const clients = new Map([
    [7, { account: { auth: { user: 'u@example.com', pass: 'plain-password' }, host: 'imap.example.com' } }],
  ]);

  assert.strictEqual(store.save(clients), true);
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(raw, /plain-password/);
  assert.doesNotMatch(raw, /u@example\.com/);
  const loaded = store.load();
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].account.auth.pass, 'plain-password');

  fs.writeFileSync(filePath, JSON.stringify([{ account: { auth: { pass: 'legacy' } } }]), 'utf8');
  assert.deepStrictEqual(store.load(), []);
});

test('sanitize strips script, events, dangerous css, and rewrites images', () => {
  const html = sanitizeEmailHtml('<p onclick="alert(1)" style="color:red;background-image:url(javascript:bad)">ok<script>x</script></p>');
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /script/i);
  assert.doesNotMatch(html, /javascript/i);
  assert.match(html, /color:red/);

  const prepared = prepareHtmlForRender('<img src="https://example.com/a.png"><img src="cid:abc">');
  assert.match(prepared, /data-remote-src="https:\/\/example.com\/a.png"/);
  assert.doesNotMatch(prepared, /<img src="https:/);
  assert.doesNotMatch(prepared, /cid:abc/);
});
