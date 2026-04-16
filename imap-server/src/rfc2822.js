/**
 * Reconstructs RFC 2822 email messages from MongoDB stored fields.
 */

function encodeWord(text) {
  if (!text) return '';
  // Check if encoding is needed (non-ASCII or special chars)
  if (/^[\x20-\x7E]+$/.test(text)) return text;
  return '=?UTF-8?B?' + Buffer.from(text, 'utf-8').toString('base64') + '?=';
}

function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const name = addr.name || '';
  const email = addr.address || '';
  if (name) return `${encodeWord(name)} <${email}>`;
  return email;
}

function formatAddressList(list) {
  if (!list) return '';
  if (typeof list === 'string') return list;
  if (!Array.isArray(list)) return formatAddress(list);
  return list.map(formatAddress).filter(Boolean).join(', ');
}

function formatRfc2822Date(date) {
  if (!date) return new Date().toUTCString();
  const d = date instanceof Date ? date : new Date(date);
  return d.toUTCString();
}

function quotedPrintableEncode(text) {
  if (!text) return '';
  const lines = [];
  const raw = Buffer.from(text, 'utf-8');
  let line = '';

  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    let encoded;

    if (byte === 0x0D && raw[i + 1] === 0x0A) {
      // CRLF — hard line break
      lines.push(line);
      line = '';
      i++; // skip LF
      continue;
    }
    if (byte === 0x0A) {
      // Bare LF — treat as line break
      lines.push(line);
      line = '';
      continue;
    }
    if ((byte >= 33 && byte <= 126 && byte !== 61) || byte === 9 || byte === 32) {
      encoded = String.fromCharCode(byte);
    } else {
      encoded = '=' + byte.toString(16).toUpperCase().padStart(2, '0');
    }

    if (line.length + encoded.length > 75) {
      lines.push(line + '='); // soft line break
      line = encoded;
    } else {
      line += encoded;
    }
  }
  if (line) lines.push(line);
  return lines.join('\r\n');
}

function buildMessage(msg, isSent) {
  const boundary = `----=_Part_${(msg._id || 'unknown').toString().slice(-12)}`;
  const date = msg.created_at || msg.createdAt || new Date();
  const messageId = `<${(msg._id || 'unknown').toString()}@manymail.local>`;

  const from = isSent
    ? (msg.from_address || '')
    : formatAddress(msg.from);
  const to = isSent
    ? (Array.isArray(msg.to) ? msg.to.join(', ') : (msg.to || ''))
    : formatAddressList(msg.to);

  const headers = [
    `Date: ${formatRfc2822Date(date)}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeWord(msg.subject || '')}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
  ];

  const text = msg.text || '';
  const html = msg.html || '';
  const hasText = text.length > 0;
  const hasHtml = html.length > 0;

  if (hasText && hasHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      quotedPrintableEncode(text),
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      quotedPrintableEncode(html),
      `--${boundary}--`,
    ].join('\r\n');
    return headers.join('\r\n') + '\r\n\r\n' + body;
  } else if (hasHtml) {
    headers.push(`Content-Type: text/html; charset=utf-8`);
    headers.push(`Content-Transfer-Encoding: quoted-printable`);
    return headers.join('\r\n') + '\r\n\r\n' + quotedPrintableEncode(html);
  } else {
    headers.push(`Content-Type: text/plain; charset=utf-8`);
    headers.push(`Content-Transfer-Encoding: quoted-printable`);
    return headers.join('\r\n') + '\r\n\r\n' + quotedPrintableEncode(text);
  }
}

function getHeaders(message) {
  const idx = message.indexOf('\r\n\r\n');
  return idx >= 0 ? message.substring(0, idx + 2) : message;
}

function getBody(message) {
  const idx = message.indexOf('\r\n\r\n');
  return idx >= 0 ? message.substring(idx + 4) : '';
}

function getHeaderFields(message, fields) {
  const headerBlock = getHeaders(message);
  const lines = headerBlock.split('\r\n');
  const result = [];
  const wanted = new Set(fields.map(f => f.toLowerCase()));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const name = line.substring(0, colonIdx).toLowerCase();
    if (wanted.has(name)) {
      let full = line;
      // Collect continuation lines
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        i++;
        full += '\r\n' + lines[i];
      }
      result.push(full);
    }
  }
  return result.join('\r\n') + '\r\n';
}

module.exports = { buildMessage, getHeaders, getBody, getHeaderFields, formatRfc2822Date, encodeWord, formatAddress };
