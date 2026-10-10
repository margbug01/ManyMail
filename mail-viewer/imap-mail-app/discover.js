const dns = require('dns').promises;
const tls = require('tls');
const { PRESETS, DOMAIN_MAP } = require('./config');

// 按 MX 主机后缀认出托管商：自定义域名挂在这些平台上时，IMAP 服务器跟着平台走
const MX_PROVIDERS = [
  { match: /(^|\.)(google|googlemail)\.com$/, host: 'imap.gmail.com', provider: 'Google Workspace' },
  { match: /(^|\.)(outlook\.com|protection\.outlook\.com)$/, host: 'outlook.office365.com', provider: 'Microsoft 365' },
  { match: /(^|\.)qq\.com$/, host: 'imap.exmail.qq.com', provider: '腾讯企业邮' },
  { match: /(^|\.)qiye163mail\.com$/, host: 'imap.qiye.163.com', provider: '网易企业邮' },
  { match: /(^|\.)(zoho\.com|zohomail\.com)$/, host: 'imap.zoho.com', provider: 'Zoho' },
  { match: /(^|\.)yandex\.(net|ru)$/, host: 'imap.yandex.com', provider: 'Yandex' },
  { match: /(^|\.)icloud\.com$/, host: 'imap.mail.me.com', provider: 'iCloud' },
];

const SECOND_LEVEL = new Set(['com', 'net', 'org', 'co', 'edu', 'gov', 'ac']);

// mx01.gmx.net -> gmx.net；mx.example.com.cn -> example.com.cn
function baseDomain(host) {
  const parts = String(host).toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}

// 从 Thunderbird autoconfig XML 里挑 IMAP 服务器，SSL 优先于 STARTTLS
function parseAutoconfig(xml) {
  const servers = [];
  const re = /<incomingServer\s+type="imap"\s*>([\s\S]*?)<\/incomingServer>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = name => (m[1].match(new RegExp('<' + name + '>\\s*([^<]+?)\\s*</' + name + '>')) || [])[1];
    const host = tag('hostname');
    const port = parseInt(tag('port'), 10);
    const socket = (tag('socketType') || '').toUpperCase();
    if (host && port && !host.includes('%')) servers.push({ host, port, secure: socket === 'SSL' });
  }
  return servers.find(s => s.secure) || servers[0] || null;
}

function probeImap(host, port = 993, timeout = 4000) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
    const socket = tls.connect({ host, port, servername: host, timeout }, () => {
      socket.once('data', d => finish(/^\* (OK|PREAUTH)/i.test(String(d))));
    });
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

async function fetchIspdb(domain, fetchImpl) {
  try {
    const res = await fetchImpl('https://autoconfig.thunderbird.net/v1.1/' + encodeURIComponent(domain), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return parseAutoconfig(await res.text());
  } catch (e) {
    return null;
  }
}

function createDiscoverer({ fetchImpl = globalThis.fetch, resolveMx = d => dns.resolveMx(d), probe = probeImap } = {}) {
  const cache = new Map();

  async function discover(domain) {
    // 1. 内置的常见邮箱
    const preset = DOMAIN_MAP[domain];
    if (preset) return { ...PRESETS[preset], provider: preset, source: 'preset' };

    // 2. Thunderbird ISPDB（按邮箱域名）
    const isp = await fetchIspdb(domain, fetchImpl);
    if (isp) return { ...isp, provider: domain, source: 'ispdb' };

    // 3. MX 记录：认得的托管商直接给结果，否则拿 MX 的主域名再查一次 ISPDB
    let mxBase = null;
    try {
      const mx = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0];
      if (mx) {
        const mxHost = mx.exchange.toLowerCase().replace(/\.$/, '');
        const known = MX_PROVIDERS.find(p => p.match.test(mxHost));
        if (known) return { host: known.host, port: 993, secure: true, provider: known.provider, source: 'mx' };
        mxBase = baseDomain(mxHost);
        if (mxBase !== domain) {
          const viaMx = await fetchIspdb(mxBase, fetchImpl);
          if (viaMx) return { ...viaMx, provider: mxBase, source: 'ispdb-mx' };
        }
      }
    } catch (e) { /* 没有 MX 就直接猜 */ }

    // 4. 常见主机名逐个握手，只认真正回了 IMAP 问候的
    const candidates = [...new Set(['imap.' + domain, mxBase && 'imap.' + mxBase, 'mail.' + domain, mxBase && 'mail.' + mxBase].filter(Boolean))];
    // 并发握手，按优先级逐个等：排前面的成功就直接返回，不等后面超时的
    const probes = candidates.map(h => probe(h, 993));
    for (let i = 0; i < candidates.length; i++) {
      if (await probes[i]) return { host: candidates[i], port: 993, secure: true, provider: baseDomain(candidates[i]), source: 'probe' };
    }

    return null;
  }

  return async function discoverImap(email) {
    const domain = String(email || '').split('@')[1]?.trim().toLowerCase();
    if (!domain || !domain.includes('.')) throw new Error(`无效邮箱: ${email}`);
    if (cache.has(domain)) return cache.get(domain);
    const pending = discover(domain).catch(() => null);
    cache.set(domain, pending);
    const result = await pending;
    // 找不到的结果不缓存，下次还能重试
    if (!result) cache.delete(domain);
    return result;
  };
}

module.exports = { createDiscoverer, parseAutoconfig, baseDomain, probeImap };
