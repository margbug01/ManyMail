const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 两个连不上的账号（本机 1 号端口，立刻拒绝连接）：恢复时不能丢，顺序和 id 也不能乱
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-restore-'));
const KEY = 'test-master-key';
process.env.ACCOUNTS_FILE = path.join(dir, 'accounts.json');
process.env.IMAP_ACCOUNT_ENCRYPTION_KEY = KEY;
process.env.IMAP_ACCOUNT_PERSISTENCE = 'encrypted';

const { createAccountStore } = require('../accountStore');
const quiet = { log() {}, warn() {}, error() {} };
const store = () => createAccountStore({ filePath: process.env.ACCOUNTS_FILE, encryptionKey: KEY, mode: 'encrypted', logger: quiet });
const account = user => ({ name: 'local', host: '127.0.0.1', port: 1, secure: false, auth: { user, pass: 'x' } });
const users = ['a@example.test', 'b@example.test'];
store().save(new Map(users.map((user, i) => [i + 1, { account: account(user) }])));

const { app, clients, restoreAccounts } = require('../server');

test('restore keeps accounts that fail to connect, in saved order', async () => {
  await restoreAccounts();
  try {
    assert.deepEqual([...clients.keys()], [1, 2]);
    assert.deepEqual([...clients.values()].map(c => c.account.auth.user), users);
    assert.deepEqual(store().load().map(item => item.account.auth.user), users, 'persisted accounts must survive a failed restore');

    const server = app.listen(0);
    try {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/changes');
      const body = await res.json();
      assert.deepEqual(Object.keys(body.accounts), ['1', '2']);
      assert.equal(body.accounts[1].inbox, 0);
      assert.equal(body.accounts[1].watching, false);
    } finally {
      server.close();
    }
  } finally {
    // 失败的账号会排队 30 秒后重连，测试里取消掉，不然进程退不出去
    clients.forEach(c => { c.closed = true; clearTimeout(c.rewatchTimer); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
