/**
 * Builds IMAP BODYSTRUCTURE response.
 * Describes the MIME structure of the reconstructed message.
 */

function buildBodyStructure(msg) {
  const hasText = !!(msg.text);
  const hasHtml = !!(msg.html);
  const textSize = msg.text ? Buffer.byteLength(msg.text, 'utf-8') : 0;
  const htmlSize = msg.html ? Buffer.byteLength(msg.html, 'utf-8') : 0;
  const textLines = msg.text ? msg.text.split('\n').length : 0;
  const htmlLines = msg.html ? msg.html.split('\n').length : 0;

  if (hasText && hasHtml) {
    // multipart/alternative
    const textPart = `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" ${textSize} ${textLines})`;
    const htmlPart = `("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" ${htmlSize} ${htmlLines})`;
    return `(${textPart} ${htmlPart} "ALTERNATIVE")`;
  } else if (hasHtml) {
    return `("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" ${htmlSize} ${htmlLines})`;
  } else {
    return `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" ${textSize} ${textLines})`;
  }
}

module.exports = { buildBodyStructure };
