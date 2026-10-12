const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

const FOLDER_CACHE_TTL = 10 * 60 * 1000;

class MailClient {
  constructor(account) {
    this.account = account;
    this.client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: account.auth,
      logger: false,
    });
    this.client.on('error', (err) => {
      console.error(`[${account.name}] 连接错误: ${err.message}`);
    });
    // 文件夹结构很少变，缓存起来；远端服务器一个往返就要几百毫秒
    this.folderCache = null;
    this.folderPromise = null;
    // 各文件夹最近一次查到的未读数，邮件列表接口直接复用，不再单独发 STATUS
    this.unseen = new Map();
    // 未读数统计走单独一条连接：imapflow 同一连接上命令串行，挤在主连接上会拖慢邮件列表
    this.statusClient = null;
    this.statusPromise = null;
    // 统计连接同时选中 INBOX（只读）挂着 IDLE，服务器一推新邮件/删邮件就把版本号 +1；
    // 前端轮询 /api/changes 比对版本号，变了才去拉列表（轮询本身不碰 IMAP）
    this.inboxVersion = 0;
    this.inboxExists = null;
    this.closed = false;
    this.rewatchTimer = null;
  }

  /** 连接到邮箱服务器 */
  async connect() {
    await this.client.connect();
    console.log(`[${this.account.name}] 已连接 ${this.account.auth.user}`);
  }

  /** 确保连接可用，断线则自动重连 */
  async ensureConnected() {
    if (!this.client.usable) {
      console.log(`[${this.account.name}] 连接已断开，正在重连...`);
      this.client = new ImapFlow({
        host: this.account.host,
        port: this.account.port,
        secure: this.account.secure,
        auth: this.account.auth,
        logger: false,
      });
      this.client.on('error', (err) => {
        console.error(`[${this.account.name}] 连接错误: ${err.message}`);
      });
      await this.client.connect();
      console.log(`[${this.account.name}] 重连成功`);
    }
  }

  /** 文件夹列表（带缓存，并发调用共用同一个请求） */
  async folders({ fresh = false } = {}) {
    if (!fresh && this.folderCache) {
      // 过期了也先返回旧的，后台再刷新，不让 LIST 堵住后面的邮件列表请求
      if (Date.now() - this.folderCache.at >= FOLDER_CACHE_TTL && !this.folderPromise) {
        this.folders({ fresh: true }).catch(() => {});
      }
      return this.folderCache.list;
    }
    if (!this.folderPromise) {
      this.folderPromise = (async () => {
        // 已有旧缓存说明是后台刷新，走统计连接；第一次加载没得等，直接用主连接
        let conn = null;
        if (this.folderCache) {
          try { conn = await this.statusConnection(); } catch {}
        }
        if (!conn) {
          await this.ensureConnected();
          conn = this.client;
        }
        const list = await conn.list();
        this.folderCache = { at: Date.now(), list };
        return list;
      })().finally(() => { this.folderPromise = null; });
    }
    return this.folderPromise;
  }

  /** 统计专用连接，断了就重建；顺带选中 INBOX 挂 IDLE 盯新邮件 */
  async statusConnection() {
    if (this.statusClient && this.statusClient.usable) return this.statusClient;
    if (!this.statusPromise) {
      this.statusPromise = (async () => {
        const conn = new ImapFlow({
          host: this.account.host,
          port: this.account.port,
          secure: this.account.secure,
          auth: this.account.auth,
          logger: false,
          // 有的服务器 IDLE 挂久了会悄悄断，定期重发一次
          maxIdleTime: 5 * 60 * 1000,
        });
        conn.on('error', (err) => {
          console.error(`[${this.account.name}] 统计连接错误: ${err.message}`);
        });
        await conn.connect();
        try {
          await conn.mailboxOpen('INBOX', { readOnly: true });
          this.noteInboxExists(conn.mailbox.exists);
          conn.on('exists', (e) => { if (e.path === 'INBOX') this.noteInboxExists(e.count); });
          conn.on('expunge', () => {
            this.inboxVersion++;
            // imapflow 自己已把 exists 减一；这里不跟上的话，下一封新邮件报的 EXISTS 会和旧计数相等而被漏掉
            this.inboxExists = conn.mailbox.exists;
          });
        } catch (err) {
          // 盯不了不影响统计，照常用
          console.error(`[${this.account.name}] 无法监听收件箱: ${err.message}`);
        }
        conn.on('close', () => {
          if (this.statusClient === conn) this.statusClient = null;
          this.scheduleRewatch();
        });
        this.statusClient = conn;
        return conn;
      })().finally(() => { this.statusPromise = null; });
    }
    return this.statusPromise;
  }

  /** 收件箱邮件数变了（含断线期间的变化）就把版本号 +1 */
  noteInboxExists(count) {
    if (this.inboxExists !== null && count !== this.inboxExists) this.inboxVersion++;
    this.inboxExists = count;
  }

  /** 开始盯收件箱：服务启动恢复账号、新添加账号时调用 */
  watchInbox() {
    return this.statusConnection().catch((err) => {
      console.error(`[${this.account.name}] 统计连接建立失败: ${err.message}`);
      this.scheduleRewatch();
    });
  }

  /** 统计连接断了：过一会儿重连接着盯，连不上就逐次拉长间隔；账号删掉后不再管 */
  scheduleRewatch(delay = 30 * 1000) {
    if (this.closed || this.rewatchTimer) return;
    this.rewatchTimer = setTimeout(() => {
      this.rewatchTimer = null;
      if (this.closed) return;
      this.statusConnection().catch((err) => {
        console.error(`[${this.account.name}] 统计连接重连失败: ${err.message}`);
        this.scheduleRewatch(Math.min(delay * 2, 10 * 60 * 1000));
      });
    }, delay);
  }

  /** 断开连接 */
  async disconnect() {
    this.closed = true;
    clearTimeout(this.rewatchTimer);
    if (this.statusClient) {
      try { await this.statusClient.logout(); } catch {}
      this.statusClient = null;
    }
    await this.client.logout();
    console.log(`[${this.account.name}] 已断开连接`);
  }

  /** 列出所有邮箱文件夹 */
  async listFolders() {
    const folders = await this.client.list();
    console.log(`\n[${this.account.name}] 邮箱文件夹:`);
    for (const folder of folders) {
      console.log(`  ${folder.path} ${folder.flags?.has('\\Noselect') ? '(不可选)' : ''}`);
    }
    return folders;
  }

  /** 获取邮件列表 */
  async fetchMails(folder = 'INBOX', count = 10) {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const status = await this.client.status(folder, { messages: true, unseen: true });
      console.log(`\n[${this.account.name}] ${folder}: 共 ${status.messages} 封，未读 ${status.unseen} 封`);
      console.log('-'.repeat(80));

      const mails = [];
      // 获取最新的 count 封邮件
      const total = status.messages;
      if (total === 0) {
        console.log('  (空邮箱)');
        return mails;
      }

      const startSeq = Math.max(1, total - count + 1);
      const range = `${startSeq}:${total}`;

      for await (const msg of this.client.fetch(range, {
        envelope: true,
        flags: true,
        bodyStructure: true,
        uid: true,
      })) {
        const mail = {
          seq: msg.seq,
          uid: msg.uid,
          date: msg.envelope.date,
          from: msg.envelope.from?.[0]
            ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address}>`
            : '(未知)',
          subject: msg.envelope.subject || '(无主题)',
          flags: [...(msg.flags || [])],
          seen: msg.flags?.has('\\Seen'),
        };
        mails.push(mail);
      }

      // 按时间倒序
      mails.sort((a, b) => new Date(b.date) - new Date(a.date));

      mails.forEach((m, i) => {
        const seen = m.seen ? '  ' : '●';
        const date = new Date(m.date).toLocaleString('zh-CN');
        console.log(`  ${seen} ${i + 1}. [${date}] ${m.from}`);
        console.log(`       ${m.subject}`);
      });

      return mails;
    } finally {
      lock.release();
    }
  }

  /** 读取单封邮件内容 */
  async readMail(folder = 'INBOX', uid) {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const source = await this.client.download(uid.toString(), undefined, { uid: true });
      const parsed = await simpleParser(source.content);

      console.log('\n' + '='.repeat(80));
      console.log(`主题: ${parsed.subject || '(无主题)'}`);
      console.log(`发件人: ${parsed.from?.text || '(未知)'}`);
      console.log(`收件人: ${parsed.to?.text || '(未知)'}`);
      console.log(`日期: ${parsed.date?.toLocaleString('zh-CN') || '(未知)'}`);
      console.log('='.repeat(80));

      if (parsed.text) {
        console.log('\n--- 正文 (纯文本) ---');
        console.log(parsed.text.substring(0, 2000));
        if (parsed.text.length > 2000) console.log('\n... (内容过长已截断)');
      }

      if (parsed.attachments?.length > 0) {
        console.log(`\n--- 附件 (${parsed.attachments.length} 个) ---`);
        parsed.attachments.forEach((att, i) => {
          console.log(`  ${i + 1}. ${att.filename || '未命名'} (${(att.size / 1024).toFixed(1)} KB)`);
        });
      }

      // 标记为已读
      await this.client.messageFlagsAdd(uid.toString(), ['\\Seen'], { uid: true });

      return parsed;
    } finally {
      lock.release();
    }
  }

  /** 下载附件 */
  async downloadAttachments(folder = 'INBOX', uid, outputDir = './attachments') {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const source = await this.client.download(uid.toString(), undefined, { uid: true });
      const parsed = await simpleParser(source.content);

      if (!parsed.attachments?.length) {
        console.log('该邮件没有附件');
        return [];
      }

      fs.mkdirSync(outputDir, { recursive: true });
      const saved = [];

      for (const att of parsed.attachments) {
        const filename = att.filename || `attachment_${Date.now()}`;
        const filepath = path.join(outputDir, filename);
        fs.writeFileSync(filepath, att.content);
        console.log(`已保存: ${filepath} (${(att.size / 1024).toFixed(1)} KB)`);
        saved.push(filepath);
      }

      return saved;
    } finally {
      lock.release();
    }
  }

  /** 搜索邮件 */
  async searchMails(folder = 'INBOX', query) {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const uids = await this.client.search(query, { uid: true });
      console.log(`\n[${this.account.name}] 搜索到 ${uids.length} 封邮件`);
      return uids;
    } finally {
      lock.release();
    }
  }

  /** 监听新邮件（实时推送） */
  async watchNewMails(folder = 'INBOX', callback) {
    const lock = await this.client.getMailboxLock(folder);
    console.log(`[${this.account.name}] 正在监听新邮件...（Ctrl+C 退出）`);

    this.client.on('exists', async (data) => {
      console.log(`\n[${this.account.name}] 收到新邮件!`);
      try {
        for await (const msg of this.client.fetch(`${data.count}:${data.count}`, {
          envelope: true,
          uid: true,
        })) {
          const info = {
            uid: msg.uid,
            from: msg.envelope.from?.[0]?.address,
            subject: msg.envelope.subject,
            date: msg.envelope.date,
          };
          console.log(`  发件人: ${info.from}`);
          console.log(`  主题: ${info.subject}`);
          if (callback) callback(info);
        }
      } catch (err) {
        console.error('处理新邮件出错:', err.message);
      }
    });

    // 保持连接（IDLE 模式）
    return { lock, stop: () => lock.release() };
  }
}

module.exports = MailClient;
