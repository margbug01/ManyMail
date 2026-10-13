// 外部邮箱来新信时告诉 mail-router（POST /events/imap），由它按规则推送到 ntfy / Telegram / webhook。
// 没配 ROUTER_URL 或 ROUTER_API_KEY 就什么都不做。

const MAX_PER_REPORT = 20;

function config() {
  return {
    url: (process.env.ROUTER_URL || '').replace(/\/+$/, ''),
    key: process.env.ROUTER_API_KEY || '',
  };
}

function enabled() {
  const { url, key } = config();
  return Boolean(url && key);
}

/** imapflow 的 fetch 结果 → router 需要的字段（只有信封，不下载正文） */
function toEvent(message) {
  const envelope = message.envelope || {};
  const sender = (envelope.from && envelope.from[0]) || {};
  return {
    uid: message.uid,
    from: { address: sender.address || '', name: sender.name || '' },
    subject: envelope.subject || '',
    date: envelope.date ? new Date(envelope.date).toISOString() : null,
  };
}

async function reportImapMail(account, uidValidity, messages, fetchImpl = globalThis.fetch) {
  const { url, key } = config();
  if (!url || !key || !messages.length) return false;
  try {
    const resp = await fetchImpl(`${url}/events/imap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ account, uidvalidity: uidValidity, messages: messages.slice(-MAX_PER_REPORT) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.error(`[router] 新邮件通知被拒绝: HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[router] 新邮件通知失败: ${err.message}`);
    return false;
  }
}

module.exports = { enabled, toEvent, reportImapMail, MAX_PER_REPORT };
