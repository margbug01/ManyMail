/**
 * IMAP connection handler — per-client state machine.
 * States: NOT_AUTHENTICATED -> AUTHENTICATED -> SELECTED
 */

const { parseLine, tokenize, parseFetchItems, parseSequenceSet, isInSequenceSet } = require('./parser');
const { authenticate } = require('./auth');
const { getFolder, FOLDER_NAMES } = require('./folders');
const { getOrAssignUids, getUidValidity, getUidNext } = require('./uid');
const { buildMessage, getHeaders, getBody, getHeaderFields } = require('./rfc2822');
const { buildEnvelope, quoteString } = require('./envelope');
const { buildBodyStructure } = require('./bodystructure');
const { getDb } = require('./mongo');

const CAPABILITIES = 'IMAP4rev1 IDLE CHILDREN';

class ImapConnection {
  constructor(socket) {
    this.socket = socket;
    this.state = 'NOT_AUTHENTICATED';
    this.user = null;
    this.selectedFolder = null;
    this.selectedReadOnly = false;
    this.messages = [];  // [{message_id, uid, seq, doc}] for selected folder
    this.idling = false;
    this.idleTag = null;
    this.buffer = '';
    this.remoteAddr = socket.remoteAddress;
  }

  start() {
    this.send('* OK ManyMail IMAP4rev1 server ready');
    this.socket.on('data', (data) => this.onData(data));
    this.socket.on('error', () => this.cleanup());
    this.socket.on('close', () => this.cleanup());
  }

  cleanup() {
    if (this._idleTimer) clearInterval(this._idleTimer);
    this.state = 'LOGOUT';
  }

  send(line) {
    try {
      this.socket.write(line + '\r\n');
    } catch {}
  }

  sendBytes(data) {
    try {
      this.socket.write(data);
    } catch {}
  }

  onData(data) {
    this.buffer += data.toString('utf-8');
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.substring(0, idx);
      this.buffer = this.buffer.substring(idx + 2);

      if (this.idling) {
        if (line.toUpperCase() === 'DONE') {
          this.idling = false;
          if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
          this.send(`${this.idleTag} OK IDLE terminated`);
          this.idleTag = null;
        }
        continue;
      }

      this.handleLine(line).catch(err => {
        console.error(`[IMAP] Error handling line: ${err.message}`);
      });
    }
  }

  async handleLine(line) {
    const parsed = parseLine(line);
    if (!parsed || !parsed.command) return;

    const { tag, command, args } = parsed;

    try {
      switch (command) {
        case 'CAPABILITY': return this.cmdCapability(tag);
        case 'NOOP': return this.cmdNoop(tag);
        case 'LOGOUT': return this.cmdLogout(tag);
        case 'LOGIN': return await this.cmdLogin(tag, args);
        case 'LIST': return this.cmdList(tag, args);
        case 'LSUB': return this.cmdList(tag, args);
        case 'SELECT': return await this.cmdSelect(tag, args, false);
        case 'EXAMINE': return await this.cmdSelect(tag, args, true);
        case 'FETCH': return await this.cmdFetch(tag, args, false);
        case 'STORE': return await this.cmdStore(tag, args, false);
        case 'SEARCH': return await this.cmdSearch(tag, args, false);
        case 'EXPUNGE': return await this.cmdExpunge(tag);
        case 'CLOSE': return await this.cmdClose(tag);
        case 'IDLE': return this.cmdIdle(tag);
        case 'UID':
          return await this.cmdUid(tag, args);
        default:
          return this.send(`${tag} BAD Unknown command`);
      }
    } catch (err) {
      console.error(`[IMAP] ${command} error:`, err.message);
      this.send(`${tag} BAD Internal error`);
    }
  }

  // ---- Basic Commands ----

  cmdCapability(tag) {
    this.send(`* CAPABILITY ${CAPABILITIES}`);
    this.send(`${tag} OK CAPABILITY completed`);
  }

  cmdNoop(tag) {
    this.send(`${tag} OK NOOP completed`);
  }

  cmdLogout(tag) {
    this.send('* BYE ManyMail IMAP server logging out');
    this.send(`${tag} OK LOGOUT completed`);
    this.state = 'LOGOUT';
    try { this.socket.end(); } catch {}
  }

  // ---- Authentication ----

  async cmdLogin(tag, args) {
    if (this.state !== 'NOT_AUTHENTICATED') {
      return this.send(`${tag} BAD Already authenticated`);
    }

    const tokens = tokenize(args);
    if (tokens.length < 2) {
      return this.send(`${tag} BAD Missing username or password`);
    }

    const user = await authenticate(tokens[0], tokens[1]);
    if (!user) {
      return this.send(`${tag} NO Invalid credentials`);
    }

    this.user = user;
    this.state = 'AUTHENTICATED';
    console.log(`[IMAP] ${this.remoteAddr} LOGIN ${user.address}`);
    this.send(`${tag} OK LOGIN completed`);
  }

  // ---- Folder Commands ----

  cmdList(tag, args) {
    if (this.state === 'NOT_AUTHENTICATED') {
      return this.send(`${tag} NO Not authenticated`);
    }

    const tokens = tokenize(args);
    const reference = tokens[0] || '';
    const pattern = tokens[1] || '*';

    if (pattern === '' || pattern === '%') {
      // List delimiter
      this.send(`* LIST (\\Noselect) "/" ""`);
      return this.send(`${tag} OK LIST completed`);
    }

    for (const name of FOLDER_NAMES) {
      const folder = getFolder(name);
      const flags = folder.flags.join(' ');
      this.send(`* LIST (${flags}) "/" "${name}"`);
    }
    this.send(`${tag} OK LIST completed`);
  }

  async cmdSelect(tag, args, readOnly) {
    if (this.state === 'NOT_AUTHENTICATED') {
      return this.send(`${tag} NO Not authenticated`);
    }

    const tokens = tokenize(args);
    const folderName = tokens[0] || '';
    const folder = getFolder(folderName);

    if (!folder) {
      return this.send(`${tag} NO Mailbox does not exist`);
    }

    // Load messages for this folder
    const db = getDb();
    const query = folder.filter(this.user.address);
    const docs = await db.collection(folder.collection)
      .find(query)
      .sort({ created_at: 1 })
      .project({ _id: 1, seen: 1, flagged: 1, answered: 1, is_deleted: 1 })
      .toArray();

    const messageIds = docs.map(d => d._id);
    const uidAssignments = await getOrAssignUids(this.user.address, folder.name, messageIds);

    this.messages = uidAssignments.map((ua, i) => ({
      message_id: ua.message_id,
      uid: ua.uid,
      seq: i + 1,
      flags: this._docToFlags(docs[i], folder.name),
    })).sort((a, b) => a.uid - b.uid);

    // Re-assign seq after sort
    this.messages.forEach((m, i) => m.seq = i + 1);

    this.selectedFolder = folder;
    this.selectedReadOnly = readOnly;
    this.state = 'SELECTED';

    const uidValidity = await getUidValidity(this.user.address, folder.name);
    const uidNext = await getUidNext(this.user.address, folder.name);
    const total = this.messages.length;
    const unseen = this.messages.filter(m => !m.flags.includes('\\Seen')).length;

    this.send(`* ${total} EXISTS`);
    this.send(`* 0 RECENT`);
    this.send(`* FLAGS (\\Seen \\Flagged \\Answered \\Deleted)`);
    this.send(`* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Answered \\Deleted)]`);
    if (unseen > 0) {
      const firstUnseen = this.messages.findIndex(m => !m.flags.includes('\\Seen')) + 1;
      if (firstUnseen > 0) this.send(`* OK [UNSEEN ${firstUnseen}]`);
    }
    this.send(`* OK [UIDVALIDITY ${uidValidity}]`);
    this.send(`* OK [UIDNEXT ${uidNext}]`);
    const cmd = readOnly ? 'EXAMINE' : 'SELECT';
    this.send(`${tag} OK [READ-${readOnly ? 'ONLY' : 'WRITE'}] ${cmd} completed`);
  }

  _docToFlags(doc, folderName) {
    const flags = [];
    if (doc.seen) flags.push('\\Seen');
    if (doc.flagged) flags.push('\\Flagged');
    if (doc.answered) flags.push('\\Answered');
    if (doc.is_deleted && folderName !== 'Trash') flags.push('\\Deleted');
    // Sent items are always \Seen
    if (folderName === 'Sent') { if (!flags.includes('\\Seen')) flags.push('\\Seen'); }
    return flags;
  }

  // ---- FETCH ----

  async cmdFetch(tag, args, isUid) {
    if (this.state !== 'SELECTED') {
      return this.send(`${tag} NO No mailbox selected`);
    }

    const firstSpace = args.indexOf(' ');
    if (firstSpace === -1) return this.send(`${tag} BAD Missing arguments`);

    const seqSet = args.substring(0, firstSpace);
    let itemsStr = args.substring(firstSpace + 1).trim();

    // Strip outer parens
    if (itemsStr.startsWith('(') && itemsStr.endsWith(')')) {
      itemsStr = itemsStr.substring(1, itemsStr.length - 1);
    }

    const ranges = parseSequenceSet(seqSet);
    const items = parseFetchItems(itemsStr);

    // Determine which messages match the sequence/UID set
    const maxVal = isUid
      ? Math.max(...this.messages.map(m => m.uid), 0)
      : this.messages.length;

    const matched = this.messages.filter(m => {
      const val = isUid ? m.uid : m.seq;
      return isInSequenceSet(val, ranges.map(r => ({
        start: r.start === Infinity ? maxVal : r.start,
        end: r.end === Infinity ? maxVal : r.end,
      })));
    });

    const needsFullDoc = items.some(it =>
      it.type === 'ENVELOPE' || it.type === 'BODYSTRUCTURE' ||
      it.type === 'BODY_SECTION' || it.type === 'RFC822' ||
      it.type === 'RFC822.HEADER' || it.type === 'RFC822.TEXT' ||
      it.type === 'RFC822.SIZE'
    );

    // Batch-load full docs if needed
    let docMap = new Map();
    if (needsFullDoc && matched.length > 0) {
      const db = getDb();
      const ids = matched.map(m => m.message_id);
      const docs = await db.collection(this.selectedFolder.collection)
        .find({ _id: { $in: ids } })
        .toArray();
      for (const doc of docs) docMap.set(doc._id.toHexString(), doc);
    }

    const isSent = this.selectedFolder.name === 'Sent';

    for (const msg of matched) {
      const doc = docMap.get(msg.message_id.toHexString());
      const responseParts = [];

      // Always include UID in UID FETCH
      if (isUid && !items.some(it => it.type === 'UID')) {
        responseParts.push(`UID ${msg.uid}`);
      }

      for (const item of items) {
        switch (item.type) {
          case 'FLAGS':
            responseParts.push(`FLAGS (${msg.flags.join(' ')})`);
            break;
          case 'UID':
            responseParts.push(`UID ${msg.uid}`);
            break;
          case 'INTERNALDATE': {
            const date = doc?.created_at || doc?.createdAt || new Date();
            responseParts.push(`INTERNALDATE "${this._formatInternalDate(date)}"`);
            break;
          }
          case 'RFC822.SIZE': {
            if (doc) {
              const fullMsg = buildMessage(doc, isSent);
              responseParts.push(`RFC822.SIZE ${Buffer.byteLength(fullMsg, 'utf-8')}`);
            } else {
              responseParts.push(`RFC822.SIZE 0`);
            }
            break;
          }
          case 'ENVELOPE': {
            if (doc) {
              responseParts.push(`ENVELOPE ${buildEnvelope(doc, isSent)}`);
            }
            break;
          }
          case 'BODYSTRUCTURE': {
            if (doc) {
              responseParts.push(`BODYSTRUCTURE ${buildBodyStructure(doc)}`);
            }
            break;
          }
          case 'BODY_SECTION': {
            if (!doc) break;
            const fullMsg = buildMessage(doc, isSent);
            let content = '';
            const section = item.section;

            if (section === '' || section === 'BODY') {
              content = fullMsg;
            } else if (section === 'HEADER' || section === 'HEADER.FIELDS' || section === 'HEADER.FIELDS.NOT') {
              if (item.fields) {
                content = getHeaderFields(fullMsg, item.fields);
              } else {
                content = getHeaders(fullMsg);
              }
            } else if (section === 'TEXT') {
              content = getBody(fullMsg);
            } else if (section === 'MIME') {
              content = getHeaders(fullMsg);
            } else {
              content = fullMsg;
            }

            if (item.partial) {
              const buf = Buffer.from(content, 'utf-8');
              content = buf.subarray(item.partial.offset, item.partial.offset + item.partial.count).toString('utf-8');
            }

            const byteLen = Buffer.byteLength(content, 'utf-8');
            const sectionSpec = this._buildSectionSpec(item);
            const peek = item.peek ? '.PEEK' : '';
            responseParts.push(`BODY${peek}[${sectionSpec}] {${byteLen}}\r\n${content}`);

            // Set \Seen if not PEEK
            if (!item.peek && !this.selectedReadOnly && !msg.flags.includes('\\Seen')) {
              msg.flags.push('\\Seen');
              this._setFlag(msg.message_id, 'seen', true);
            }
            break;
          }
          case 'RFC822': {
            if (!doc) break;
            const fullMsg = buildMessage(doc, isSent);
            const byteLen = Buffer.byteLength(fullMsg, 'utf-8');
            responseParts.push(`RFC822 {${byteLen}}\r\n${fullMsg}`);
            if (!this.selectedReadOnly && !msg.flags.includes('\\Seen')) {
              msg.flags.push('\\Seen');
              this._setFlag(msg.message_id, 'seen', true);
            }
            break;
          }
          case 'RFC822.HEADER': {
            if (!doc) break;
            const fullMsg = buildMessage(doc, isSent);
            const hdr = getHeaders(fullMsg);
            const byteLen = Buffer.byteLength(hdr, 'utf-8');
            responseParts.push(`RFC822.HEADER {${byteLen}}\r\n${hdr}`);
            break;
          }
          case 'RFC822.TEXT': {
            if (!doc) break;
            const fullMsg = buildMessage(doc, isSent);
            const body = getBody(fullMsg);
            const byteLen = Buffer.byteLength(body, 'utf-8');
            responseParts.push(`RFC822.TEXT {${byteLen}}\r\n${body}`);
            break;
          }
        }
      }

      if (responseParts.length > 0) {
        this.send(`* ${msg.seq} FETCH (${responseParts.join(' ')})`);
      }
    }

    this.send(`${tag} OK ${isUid ? 'UID ' : ''}FETCH completed`);
  }

  _buildSectionSpec(item) {
    if (item.section === 'HEADER.FIELDS' && item.fields) {
      return `HEADER.FIELDS (${item.fields.join(' ')})`;
    }
    return item.section;
  }

  _formatInternalDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day = String(d.getUTCDate()).padStart(2, '0');
    const mon = months[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
    return `${day}-${mon}-${year} ${time} +0000`;
  }

  async _setFlag(messageId, field, value) {
    try {
      const db = getDb();
      await db.collection(this.selectedFolder.collection).updateOne(
        { _id: messageId },
        { $set: { [field]: value } },
      );
    } catch {}
  }

  // ---- STORE ----

  async cmdStore(tag, args, isUid) {
    if (this.state !== 'SELECTED') return this.send(`${tag} NO No mailbox selected`);
    if (this.selectedReadOnly) return this.send(`${tag} NO Mailbox is read-only`);

    const firstSpace = args.indexOf(' ');
    if (firstSpace === -1) return this.send(`${tag} BAD Missing arguments`);

    const seqSet = args.substring(0, firstSpace);
    const rest = args.substring(firstSpace + 1).trim();

    // Parse +FLAGS, -FLAGS, FLAGS
    const flagMatch = rest.match(/^([+-]?)FLAGS(?:\.SILENT)?\s*\(([^)]*)\)/i);
    if (!flagMatch) return this.send(`${tag} BAD Invalid STORE arguments`);

    const action = flagMatch[1]; // '+', '-', or ''
    const silent = /\.SILENT/i.test(rest);
    const flags = flagMatch[2].trim().split(/\s+/).filter(Boolean);

    const ranges = parseSequenceSet(seqSet);
    const maxVal = isUid ? Math.max(...this.messages.map(m => m.uid), 0) : this.messages.length;

    const matched = this.messages.filter(m => {
      const val = isUid ? m.uid : m.seq;
      return isInSequenceSet(val, ranges.map(r => ({
        start: r.start === Infinity ? maxVal : r.start,
        end: r.end === Infinity ? maxVal : r.end,
      })));
    });

    const flagFieldMap = {
      '\\Seen': 'seen',
      '\\Flagged': 'flagged',
      '\\Answered': 'answered',
      '\\Deleted': 'is_deleted',
    };

    const db = getDb();

    for (const msg of matched) {
      for (const flag of flags) {
        const field = flagFieldMap[flag];
        if (!field) continue;

        if (action === '+') {
          if (!msg.flags.includes(flag)) msg.flags.push(flag);
          await db.collection(this.selectedFolder.collection).updateOne(
            { _id: msg.message_id }, { $set: { [field]: true } },
          );
        } else if (action === '-') {
          msg.flags = msg.flags.filter(f => f !== flag);
          await db.collection(this.selectedFolder.collection).updateOne(
            { _id: msg.message_id }, { $set: { [field]: false } },
          );
        } else {
          // Replace flags
          msg.flags = [...flags.filter(f => flagFieldMap[f])];
          const update = {};
          for (const [imapFlag, dbField] of Object.entries(flagFieldMap)) {
            update[dbField] = flags.includes(imapFlag);
          }
          await db.collection(this.selectedFolder.collection).updateOne(
            { _id: msg.message_id }, { $set: update },
          );
        }
      }

      if (!silent) {
        this.send(`* ${msg.seq} FETCH (FLAGS (${msg.flags.join(' ')})${isUid ? ` UID ${msg.uid}` : ''})`);
      }
    }

    this.send(`${tag} OK ${isUid ? 'UID ' : ''}STORE completed`);
  }

  // ---- SEARCH ----

  async cmdSearch(tag, args, isUid) {
    if (this.state !== 'SELECTED') return this.send(`${tag} NO No mailbox selected`);

    const tokens = tokenize(args);
    // Simple search: map common criteria to filter on cached flags or load docs
    const results = [];

    // For simplicity, do in-memory filtering on the message cache + doc lookup
    const db = getDb();
    const needDocSearch = tokens.some(t =>
      ['SUBJECT', 'FROM', 'TO', 'BODY', 'TEXT', 'SINCE', 'BEFORE', 'ON', 'HEADER'].includes(t.toUpperCase())
    );

    let docMap = new Map();
    if (needDocSearch) {
      const ids = this.messages.map(m => m.message_id);
      const docs = await db.collection(this.selectedFolder.collection)
        .find({ _id: { $in: ids } }).toArray();
      for (const d of docs) docMap.set(d._id.toHexString(), d);
    }

    for (const msg of this.messages) {
      if (this._matchesSearch(msg, tokens, docMap)) {
        results.push(isUid ? msg.uid : msg.seq);
      }
    }

    this.send(`* SEARCH ${results.join(' ')}`);
    this.send(`${tag} OK ${isUid ? 'UID ' : ''}SEARCH completed`);
  }

  _matchesSearch(msg, tokens, docMap) {
    let i = 0;
    const match = () => {
      if (i >= tokens.length) return true;
      const key = tokens[i].toUpperCase();
      i++;

      switch (key) {
        case 'ALL': return true;
        case 'SEEN': return msg.flags.includes('\\Seen');
        case 'UNSEEN': return !msg.flags.includes('\\Seen');
        case 'FLAGGED': return msg.flags.includes('\\Flagged');
        case 'UNFLAGGED': return !msg.flags.includes('\\Flagged');
        case 'DELETED': return msg.flags.includes('\\Deleted');
        case 'UNDELETED': return !msg.flags.includes('\\Deleted');
        case 'ANSWERED': return msg.flags.includes('\\Answered');
        case 'UNANSWERED': return !msg.flags.includes('\\Answered');
        case 'SUBJECT': {
          const val = tokens[i++] || '';
          const doc = docMap.get(msg.message_id.toHexString());
          return doc && (doc.subject || '').toLowerCase().includes(val.toLowerCase());
        }
        case 'FROM': {
          const val = tokens[i++] || '';
          const doc = docMap.get(msg.message_id.toHexString());
          if (!doc) return false;
          const addr = doc.from?.address || doc.from_address || '';
          const name = doc.from?.name || '';
          return (addr + ' ' + name).toLowerCase().includes(val.toLowerCase());
        }
        case 'TO': {
          const val = tokens[i++] || '';
          const doc = docMap.get(msg.message_id.toHexString());
          if (!doc) return false;
          const addrs = Array.isArray(doc.to)
            ? doc.to.map(t => typeof t === 'string' ? t : (t.address || '')).join(' ')
            : '';
          return addrs.toLowerCase().includes(val.toLowerCase());
        }
        case 'BODY':
        case 'TEXT': {
          const val = tokens[i++] || '';
          const doc = docMap.get(msg.message_id.toHexString());
          if (!doc) return false;
          const content = (doc.text || '') + ' ' + (doc.html || '') + ' ' + (doc.subject || '');
          return content.toLowerCase().includes(val.toLowerCase());
        }
        case 'SINCE': {
          const dateStr = tokens[i++] || '';
          const doc = docMap.get(msg.message_id.toHexString());
          if (!doc) return false;
          return new Date(doc.created_at) >= new Date(dateStr);
        }
        case 'BEFORE': {
          const dateStr = tokens[i++] || '';
          const doc = docMap.get(msg.message_id.toHexString());
          if (!doc) return false;
          return new Date(doc.created_at) < new Date(dateStr);
        }
        case 'UID': {
          const setStr = tokens[i++] || '';
          const ranges = parseSequenceSet(setStr);
          return isInSequenceSet(msg.uid, ranges);
        }
        case 'OR': {
          const a = match();
          const b = match();
          return a || b;
        }
        case 'NOT': {
          return !match();
        }
        default:
          // Unknown criterion — skip, match all
          return true;
      }
    };

    i = 0;
    // All criteria must match (AND)
    while (i < tokens.length) {
      if (!match()) return false;
    }
    return true;
  }

  // ---- EXPUNGE ----

  async cmdExpunge(tag) {
    if (this.state !== 'SELECTED') return this.send(`${tag} NO No mailbox selected`);
    if (this.selectedReadOnly) return this.send(`${tag} NO Mailbox is read-only`);

    const deleted = this.messages.filter(m => m.flags.includes('\\Deleted'));
    if (deleted.length === 0) return this.send(`${tag} OK EXPUNGE completed`);

    const db = getDb();
    const ids = deleted.map(m => m.message_id);

    if (this.selectedFolder.name === 'Trash') {
      // Hard delete from Trash
      await db.collection('messages').deleteMany({ _id: { $in: ids } });
    } else {
      // Soft delete (mark is_deleted)
      await db.collection('messages').updateMany(
        { _id: { $in: ids } },
        { $set: { is_deleted: true } },
      );
    }

    // Report expunged messages (in reverse order for seq stability)
    const expungedSeqs = deleted.map(m => m.seq).sort((a, b) => b - a);
    for (const seq of expungedSeqs) {
      this.send(`* ${seq} EXPUNGE`);
    }

    // Remove from cache and re-number
    this.messages = this.messages.filter(m => !m.flags.includes('\\Deleted'));
    this.messages.forEach((m, i) => m.seq = i + 1);

    this.send(`${tag} OK EXPUNGE completed`);
  }

  async cmdClose(tag) {
    if (this.state !== 'SELECTED') return this.send(`${tag} NO No mailbox selected`);

    // Silently expunge \Deleted messages
    if (!this.selectedReadOnly) {
      const deleted = this.messages.filter(m => m.flags.includes('\\Deleted'));
      if (deleted.length > 0) {
        const db = getDb();
        const ids = deleted.map(m => m.message_id);
        await db.collection(this.selectedFolder.collection).updateMany(
          { _id: { $in: ids } },
          { $set: { is_deleted: true } },
        );
      }
    }

    this.state = 'AUTHENTICATED';
    this.selectedFolder = null;
    this.messages = [];
    this.send(`${tag} OK CLOSE completed`);
  }

  // ---- IDLE ----

  cmdIdle(tag) {
    if (this.state !== 'SELECTED') return this.send(`${tag} NO No mailbox selected`);

    this.idling = true;
    this.idleTag = tag;
    this.send('+ idling');

    const prevCount = this.messages.length;
    this._idleTimer = setInterval(async () => {
      try {
        const db = getDb();
        const query = this.selectedFolder.filter(this.user.address);
        const count = await db.collection(this.selectedFolder.collection).countDocuments(query);
        if (count > prevCount) {
          this.send(`* ${count} EXISTS`);
        }
      } catch {}
    }, 30000);
  }

  // ---- UID prefix command ----

  async cmdUid(tag, args) {
    const spaceIdx = args.indexOf(' ');
    if (spaceIdx === -1) return this.send(`${tag} BAD Missing UID subcommand`);

    const subCmd = args.substring(0, spaceIdx).toUpperCase();
    const subArgs = args.substring(spaceIdx + 1).trim();

    switch (subCmd) {
      case 'FETCH': return this.cmdFetch(tag, subArgs, true);
      case 'STORE': return this.cmdStore(tag, subArgs, true);
      case 'SEARCH': return this.cmdSearch(tag, subArgs, true);
      default: return this.send(`${tag} BAD Unknown UID subcommand`);
    }
  }
}

module.exports = ImapConnection;
