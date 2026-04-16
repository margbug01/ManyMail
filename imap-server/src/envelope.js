/**
 * Builds IMAP ENVELOPE response from MongoDB document fields.
 * RFC 3501 Section 7.4.2
 */

const { formatRfc2822Date } = require('./rfc2822');

function quoteString(s) {
  if (s === null || s === undefined) return 'NIL';
  const str = String(s);
  if (!str) return '""';
  // Escape backslash and double-quote
  return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function formatEnvelopeAddress(addr) {
  if (!addr) return 'NIL';
  let name = null, email = '';

  if (typeof addr === 'string') {
    email = addr;
  } else {
    name = addr.name || null;
    email = addr.address || '';
  }

  const parts = email.split('@');
  const mailbox = parts[0] || '';
  const host = parts[1] || '';

  return `(${quoteString(name)} NIL ${quoteString(mailbox)} ${quoteString(host)})`;
}

function formatEnvelopeAddressList(list) {
  if (!list) return 'NIL';
  if (typeof list === 'string') {
    if (!list) return 'NIL';
    return `(${formatEnvelopeAddress({ address: list })})`;
  }
  if (!Array.isArray(list)) return `(${formatEnvelopeAddress(list)})`;
  if (list.length === 0) return 'NIL';
  return '(' + list.map(formatEnvelopeAddress).join('') + ')';
}

function buildEnvelope(msg, isSent) {
  const date = quoteString(formatRfc2822Date(msg.created_at || msg.createdAt));
  const subject = quoteString(msg.subject || '');
  const messageId = quoteString(`<${(msg._id || 'unknown').toString()}@manymail.local>`);

  const from = isSent
    ? formatEnvelopeAddressList([{ address: msg.from_address || '' }])
    : formatEnvelopeAddressList(msg.from ? [msg.from] : []);

  const to = isSent
    ? formatEnvelopeAddressList(
        Array.isArray(msg.to)
          ? msg.to.map(a => typeof a === 'string' ? { address: a } : a)
          : []
      )
    : formatEnvelopeAddressList(msg.to);

  // sender = from, reply-to = from (when not specified)
  const sender = from;
  const replyTo = from;

  return `(${date} ${subject} ${from} ${sender} ${replyTo} ${to} NIL NIL NIL ${messageId})`;
}

module.exports = { buildEnvelope, quoteString };
