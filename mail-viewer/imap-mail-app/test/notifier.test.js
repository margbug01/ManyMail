const assert = require('node:assert/strict');
const test = require('node:test');

const notifier = require('../notifier');
const MailClient = require('../client');

const account = { name: 'gmail', host: '127.0.0.1', port: 1, secure: false, auth: { user: 'me@gmail.test', pass: 'x' } };

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
}

const ROUTER = { ROUTER_URL: 'http://router.test:8090/', ROUTER_API_KEY: 'k' };

test('reportImapMail does nothing without ROUTER_URL / ROUTER_API_KEY', () => withEnv({ ROUTER_URL: undefined, ROUTER_API_KEY: undefined }, async () => {
  let called = false;
  assert.equal(notifier.enabled(), false);
  assert.equal(await notifier.reportImapMail('a@b.test', '1', [{ uid: 1 }], async () => { called = true; }), false);
  assert.equal(called, false);
}));

test('reportImapMail posts the newest messages to the router', () => withEnv(ROUTER, async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 202 }; };
  const messages = Array.from({ length: 25 }, (_, i) => ({ uid: i + 1 }));
  assert.equal(await notifier.reportImapMail('me@gmail.test', '7', messages, fake), true);
  assert.equal(calls[0].url, 'http://router.test:8090/events/imap');
  assert.equal(calls[0].init.headers['X-API-Key'], 'k');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.account, 'me@gmail.test');
  assert.equal(body.uidvalidity, '7');
  assert.deepEqual(body.messages.map(m => m.uid), messages.slice(-notifier.MAX_PER_REPORT).map(m => m.uid));

  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await notifier.reportImapMail('a@b.test', '1', [{ uid: 1 }], async () => ({ ok: false, status: 401 })), false);
    assert.equal(await notifier.reportImapMail('a@b.test', '1', [{ uid: 1 }], async () => { throw new Error('down'); }), false);
  } finally {
    console.error = quiet;
  }
}));

test('toEvent keeps only envelope fields', () => {
  const event = notifier.toEvent({
    uid: 9,
    envelope: { from: [{ address: 'alerts@bank.test', name: 'Bank' }], subject: 'Code 551234', date: new Date('2026-10-13T06:00:00Z') },
    source: Buffer.from('ignored'),
  });
  assert.deepEqual(event, { uid: 9, from: { address: 'alerts@bank.test', name: 'Bank' }, subject: 'Code 551234', date: '2026-10-13T06:00:00.000Z' });
  assert.deepEqual(notifier.toEvent({ uid: 1 }).from, { address: '', name: '' });
});

function fakeConnection(uids) {
  const ranges = [];
  return {
    usable: true,
    ranges,
    async *fetch(range) {
      ranges.push(range);
      for (const uid of uids) yield { uid, envelope: { from: [{ address: `s${uid}@x.test` }], subject: `m${uid}` } };
    },
  };
}

test('trackNewMail sets a baseline, then reports only mail above it', async () => {
  const client = new MailClient(account);
  client.trackNewMail({ uidNext: 7, uidValidity: 3n });
  assert.equal(client.lastUid, 6);
  assert.equal(client.uidValidity, '3');

  const reported = [];
  const original = notifier.reportImapMail;
  notifier.reportImapMail = async (user, validity, events) => { reported.push({ user, validity, events }); return true; };
  try {
    // n:* returns the last message even when nothing is newer, so uid 6 comes back too
    const conn = fakeConnection([6, 8, 7]);
    assert.equal(await client.reportNewMail(conn), 2);
    assert.equal(conn.ranges[0], '7:*');
    assert.equal(client.lastUid, 8);
    assert.deepEqual(reported[0].events.map(e => e.uid), [7, 8]);
    assert.equal(reported[0].user, 'me@gmail.test');

    assert.equal(await client.reportNewMail(fakeConnection([8])), 0);
    assert.equal(reported.length, 1);
  } finally {
    notifier.reportImapMail = original;
  }

  // A new UIDVALIDITY means the old UIDs mean nothing: start over from the new UIDNEXT.
  client.trackNewMail({ uidNext: 3, uidValidity: 4 });
  assert.equal(client.lastUid, 2);
});

test('without UIDNEXT the first look only sets the baseline', async () => {
  const client = new MailClient(account);
  client.trackNewMail({ uidValidity: 1 });
  assert.equal(client.lastUid, -1);
  const original = notifier.reportImapMail;
  let reports = 0;
  notifier.reportImapMail = async () => { reports++; return true; };
  try {
    assert.equal(await client.reportNewMail(fakeConnection([40])), 0);
    assert.equal(client.lastUid, 40);
    assert.equal(await client.reportNewMail(fakeConnection([40, 41])), 1);
    assert.equal(reports, 1);
  } finally {
    notifier.reportImapMail = original;
  }
});

test('growing INBOX queues a report only when the router is configured', () => withEnv({ ROUTER_URL: undefined, ROUTER_API_KEY: undefined }, async () => {
  const client = new MailClient(account);
  client.noteInboxExists(5);
  client.noteInboxExists(6);
  assert.equal(client.newMailTimer, null);
  await withEnv(ROUTER, () => {
    client.noteInboxExists(7);
    assert.notEqual(client.newMailTimer, null);
    clearTimeout(client.newMailTimer);
    client.newMailTimer = null;
  });
}));
