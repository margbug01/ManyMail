const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

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

  /** 断开连接 */
  async disconnect() {
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
