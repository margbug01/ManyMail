const test = require('node:test');
const assert = require('node:assert');
const { createDiscoverer, parseAutoconfig, baseDomain } = require('../discover');

const ISPDB_XML = `<clientConfig><emailProvider id="web.de">
  <incomingServer type="pop3"><hostname>pop3.web.de</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>imap.web.de</hostname><port>143</port><socketType>STARTTLS</socketType></incomingServer>
  <incomingServer type="imap"><hostname>imap.web.de</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
</emailProvider></clientConfig>`;

const fakeFetch = map => async url => {
  const domain = decodeURIComponent(url.split('/').pop());
  return map[domain] ? { ok: true, text: async () => map[domain] } : { ok: false, text: async () => '' };
};

test('parseAutoconfig prefers SSL IMAP and ignores pop3', () => {
  assert.deepStrictEqual(parseAutoconfig(ISPDB_XML), { host: 'imap.web.de', port: 993, secure: true });
  assert.strictEqual(parseAutoconfig('<clientConfig/>'), null);
});

test('baseDomain handles two-letter country second levels', () => {
  assert.strictEqual(baseDomain('mx01.gmx.net'), 'gmx.net');
  assert.strictEqual(baseDomain('mx.example.com.cn.'), 'example.com.cn');
  assert.strictEqual(baseDomain('gmail.com'), 'gmail.com');
});

test('known domains come from presets without network', async () => {
  const discover = createDiscoverer({ fetchImpl: () => { throw new Error('no network'); } });
  const r = await discover('a@gmail.com');
  assert.strictEqual(r.host, 'imap.gmail.com');
  assert.strictEqual(r.source, 'preset');
});

test('ISPDB result by email domain', async () => {
  const discover = createDiscoverer({ fetchImpl: fakeFetch({ 'web.de': ISPDB_XML }), resolveMx: async () => [] });
  const r = await discover('x@web.de');
  assert.strictEqual(r.host, 'imap.web.de');
  assert.strictEqual(r.source, 'ispdb');
});

test('custom domain on Google MX maps to Gmail', async () => {
  const discover = createDiscoverer({
    fetchImpl: fakeFetch({}),
    resolveMx: async () => [{ exchange: 'alt1.aspmx.l.google.com', priority: 5 }, { exchange: 'aspmx.l.google.com', priority: 1 }],
  });
  const r = await discover('me@company.io');
  assert.strictEqual(r.host, 'imap.gmail.com');
  assert.strictEqual(r.source, 'mx');
});

test('falls back to probing imap.<mx domain> (yaani.com -> imap.yaanimail.com)', async () => {
  const probed = [];
  const discover = createDiscoverer({
    fetchImpl: fakeFetch({}),
    resolveMx: async () => [{ exchange: 'mx.yaanimail.com', priority: 10 }],
    probe: async host => { probed.push(host); return host === 'imap.yaanimail.com'; },
  });
  const r = await discover('someone@yaani.com');
  assert.strictEqual(r.host, 'imap.yaanimail.com');
  assert.strictEqual(r.source, 'probe');
  assert.deepStrictEqual(probed, ['imap.yaani.com', 'imap.yaanimail.com', 'mail.yaani.com', 'mail.yaanimail.com']);
});

test('nothing found returns null and is not cached', async () => {
  let calls = 0;
  const discover = createDiscoverer({ fetchImpl: fakeFetch({}), resolveMx: async () => { calls++; return []; }, probe: async () => false });
  assert.strictEqual(await discover('a@nowhere.test'), null);
  await discover('b@nowhere.test');
  assert.strictEqual(calls, 2);
});

test('invalid email throws', async () => {
  const discover = createDiscoverer();
  await assert.rejects(() => discover('not-an-email'));
});
