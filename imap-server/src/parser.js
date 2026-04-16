/**
 * IMAP command line parser.
 * Parses "tag COMMAND arg1 arg2 ..." into structured objects.
 * Handles quoted strings, parenthesized lists, and FETCH item syntax.
 */

function parseLine(line) {
  line = (line || '').trim();
  if (!line) return null;

  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return { tag: line, command: '', args: '' };

  const tag = line.substring(0, spaceIdx);
  const rest = line.substring(spaceIdx + 1).trim();

  const spaceIdx2 = rest.indexOf(' ');
  if (spaceIdx2 === -1) return { tag, command: rest.toUpperCase(), args: '' };

  const command = rest.substring(0, spaceIdx2).toUpperCase();
  const args = rest.substring(spaceIdx2 + 1).trim();

  return { tag, command, args };
}

/**
 * Tokenize IMAP arguments respecting quotes and parens.
 */
function tokenize(str) {
  const tokens = [];
  let i = 0;
  const s = str || '';

  while (i < s.length) {
    // Skip whitespace
    if (s[i] === ' ' || s[i] === '\t') { i++; continue; }

    // Quoted string
    if (s[i] === '"') {
      let j = i + 1;
      let val = '';
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) {
          val += s[j + 1];
          j += 2;
        } else if (s[j] === '"') {
          break;
        } else {
          val += s[j];
          j++;
        }
      }
      tokens.push(val);
      i = j + 1;
      continue;
    }

    // Parenthesized list
    if (s[i] === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
      }
      tokens.push(s.substring(i + 1, j - 1));
      i = j;
      continue;
    }

    // Atom (unquoted string until space, paren, or bracket)
    let j = i;
    while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '(' && s[j] !== ')') {
      j++;
    }
    tokens.push(s.substring(i, j));
    i = j;
  }

  return tokens;
}

/**
 * Parse FETCH data items from the arguments string.
 * Handles: FLAGS, UID, INTERNALDATE, RFC822.SIZE, ENVELOPE, BODYSTRUCTURE,
 *          BODY[], BODY.PEEK[], BODY[HEADER], BODY[TEXT], BODY[HEADER.FIELDS (list)]
 */
function parseFetchItems(str) {
  str = (str || '').trim();

  // Handle macros
  if (str === 'ALL') return [{ type: 'FLAGS' }, { type: 'INTERNALDATE' }, { type: 'RFC822.SIZE' }, { type: 'ENVELOPE' }];
  if (str === 'FAST') return [{ type: 'FLAGS' }, { type: 'INTERNALDATE' }, { type: 'RFC822.SIZE' }];
  if (str === 'FULL') return [{ type: 'FLAGS' }, { type: 'INTERNALDATE' }, { type: 'RFC822.SIZE' }, { type: 'ENVELOPE' }, { type: 'BODY' }];

  const items = [];
  let i = 0;

  while (i < str.length) {
    if (str[i] === ' ' || str[i] === '\t') { i++; continue; }

    // Match BODY.PEEK[...] or BODY[...]
    const bodyMatch = str.substring(i).match(/^(BODY(?:\.PEEK)?)\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/i);
    if (bodyMatch) {
      const item = {
        type: 'BODY_SECTION',
        peek: bodyMatch[1].toUpperCase().includes('PEEK'),
        section: bodyMatch[2].toUpperCase(),
        fields: null,
        partial: null,
      };

      // Parse HEADER.FIELDS (field list)
      const hfMatch = item.section.match(/^HEADER\.FIELDS(?:\.NOT)?\s*\(([^)]*)\)/i);
      if (hfMatch) {
        item.fields = hfMatch[1].trim().split(/\s+/);
        item.section = item.section.startsWith('HEADER.FIELDS.NOT') ? 'HEADER.FIELDS.NOT' : 'HEADER.FIELDS';
      }

      if (bodyMatch[3] !== undefined) {
        item.partial = { offset: parseInt(bodyMatch[3]), count: parseInt(bodyMatch[4]) };
      }

      items.push(item);
      i += bodyMatch[0].length;
      continue;
    }

    // Match simple atoms
    let j = i;
    while (j < str.length && str[j] !== ' ' && str[j] !== '\t' && str[j] !== '[' && str[j] !== '(') j++;
    const atom = str.substring(i, j).toUpperCase();

    if (atom === 'FLAGS' || atom === 'UID' || atom === 'INTERNALDATE' ||
        atom === 'RFC822.SIZE' || atom === 'ENVELOPE' || atom === 'BODYSTRUCTURE' ||
        atom === 'RFC822' || atom === 'RFC822.HEADER' || atom === 'RFC822.TEXT') {
      items.push({ type: atom });
    }

    i = j;
  }

  return items;
}

/**
 * Parse IMAP sequence set (e.g., "1:*", "1,3,5:10", "42")
 * Returns an array of {start, end} ranges. '*' = Infinity.
 */
function parseSequenceSet(str) {
  const ranges = [];
  for (const part of (str || '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes(':')) {
      const [a, b] = trimmed.split(':');
      ranges.push({
        start: a === '*' ? Infinity : parseInt(a),
        end: b === '*' ? Infinity : parseInt(b),
      });
    } else {
      const n = trimmed === '*' ? Infinity : parseInt(trimmed);
      ranges.push({ start: n, end: n });
    }
  }
  return ranges;
}

function isInSequenceSet(num, ranges) {
  for (const r of ranges) {
    const lo = Math.min(r.start, r.end);
    const hi = Math.max(r.start, r.end);
    if (num >= lo && num <= hi) return true;
  }
  return false;
}

module.exports = { parseLine, tokenize, parseFetchItems, parseSequenceSet, isInSequenceSet };
