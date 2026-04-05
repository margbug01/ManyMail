const express = require('express');
const path = require('path');
const fs = require('fs');
const { simpleParser } = require('mailparser');
const MailClient = require('./client');
const { fromPreset, PRESETS, autoDetect } = require('./config');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 存储已连接的客户端
const clients = new Map();
let clientId = 0;

// 持久化文件路径
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(__dirname, 'accounts.json');

// 保存账户配置到文件
function saveAccounts() {
  const data = [];
  clients.forEach((client, id) => {
    data.push({ id, account: client.account });
  });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 启动时恢复已保存的账户
async function restoreAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  } catch {
    return;
  }
  if (!Array.isArray(data) || data.length === 0) return;

  console.log(`正在恢复 ${data.length} 个已保存的账户...`);
  for (const item of data) {
    const client = new MailClient(item.account);
    try {
      await client.connect();
      const id = ++clientId;
      clients.set(id, client);
      console.log(`  ✓ ${item.account.auth.user} 已恢复`);
    } catch (err) {
      console.log(`  ✗ ${item.account.auth.user} 恢复失败: ${err.message}`);
    }
  }
  // 重连后更新持久化（去掉连接失败的）
  saveAccounts();
}

// 获取可用预设列表
app.get('/api/presets', (req, res) => {
  res.json(Object.keys(PRESETS));
});

// 添加账户
app.post('/api/accounts', async (req, res) => {
  const { preset, host, port, email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '请填写邮箱和密码' });
  }

  let account;
  if (preset && preset !== 'custom') {
    try {
      account = fromPreset(preset, email, password);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  } else {
    if (!host) return res.status(400).json({ error: '自定义配置需要填写服务器地址' });
    account = {
      name: email.split('@')[1] || 'custom',
      host,
      port: parseInt(port, 10) || 993,
      secure: true,
      auth: { user: email, pass: password },
    };
  }

  // 检查是否已连接同一邮箱
  for (const [existingId, existing] of clients) {
    if (existing.account.auth.user === email) {
      return res.json({ id: existingId, name: existing.account.name, email, exists: true });
    }
  }

  const client = new MailClient(account);
  try {
    await client.connect();
    const id = ++clientId;
    clients.set(id, client);
    saveAccounts();
    res.json({ id, name: account.name, email: account.auth.user });
  } catch (err) {
    res.status(500).json({ error: `连接失败: ${err.message}` });
  }
});

// 已连接账户列表
app.get('/api/accounts', (req, res) => {
  const list = [];
  clients.forEach((c, id) => {
    list.push({ id, name: c.account.name, email: c.account.auth.user });
  });
  res.json(list);
});

// 断开账户
app.delete('/api/accounts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = clients.get(id);
  if (!client) return res.status(404).json({ error: '账户不存在' });
  try { await client.disconnect(); } catch {}
  clients.delete(id);
  saveAccounts();
  res.json({ ok: true });
});

// 获取文件夹列表
app.get('/api/accounts/:id/folders', async (req, res) => {
  const client = clients.get(parseInt(req.params.id, 10));
  if (!client) return res.status(404).json({ error: '账户不存在' });
  try {
    await client.ensureConnected();
    const folders = await client.client.list();
    res.json(folders.map(f => ({
      path: f.path,
      name: f.name,
      noselect: f.flags?.has('\\Noselect') || false,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取邮件列表
app.get('/api/accounts/:id/mails', async (req, res) => {
  const client = clients.get(parseInt(req.params.id, 10));
  if (!client) return res.status(404).json({ error: '账户不存在' });

  const folder = req.query.folder || 'INBOX';
  const count = parseInt(req.query.count, 10) || 20;
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  try {
    await client.ensureConnected();
    const lock = await client.client.getMailboxLock(folder);
    try {
      const status = await client.client.status(folder, { messages: true, unseen: true });
      const total = status.messages;
      if (total === 0) {
        return res.json({ total: 0, unseen: status.unseen, mails: [], hasMore: false });
      }

      let startSeq, endSeq;
      if (before) {
        endSeq = before - 1;
        if (endSeq < 1) {
          return res.json({ total, unseen: status.unseen, mails: [], hasMore: false });
        }
        startSeq = Math.max(1, endSeq - count + 1);
      } else {
        endSeq = total;
        startSeq = Math.max(1, total - count + 1);
      }

      const mails = [];

      for await (const msg of client.client.fetch(`${startSeq}:${endSeq}`, {
        envelope: true,
        flags: true,
        uid: true,
      })) {
        mails.push({
          uid: msg.uid,
          seq: msg.seq,
          date: msg.envelope.date,
          from: msg.envelope.from?.[0]
            ? { name: msg.envelope.from[0].name || '', address: msg.envelope.from[0].address }
            : { name: '', address: '(unknown)' },
          to: msg.envelope.to?.map(t => ({ name: t.name || '', address: t.address })) || [],
          subject: msg.envelope.subject || '(no subject)',
          seen: msg.flags?.has('\\Seen') || false,
          flagged: msg.flags?.has('\\Flagged') || false,
        });
      }

      mails.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json({ total, unseen: status.unseen, mails, hasMore: startSeq > 1 });
    } finally {
      lock.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 读取单封邮件
app.get('/api/accounts/:id/mails/:uid', async (req, res) => {
  const client = clients.get(parseInt(req.params.id, 10));
  if (!client) return res.status(404).json({ error: '账户不存在' });

  const folder = req.query.folder || 'INBOX';
  const uid = req.params.uid;

  try {
    await client.ensureConnected();
    const lock = await client.client.getMailboxLock(folder);
    try {
      const source = await client.client.download(uid, undefined, { uid: true });
      const parsed = await simpleParser(source.content);

      await client.client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });

      res.json({
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        date: parsed.date,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map((a, i) => ({
          index: i,
          filename: a.filename || `attachment_${i}`,
          size: a.size,
          contentType: a.contentType,
        })),
      });
    } finally {
      lock.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 下载附件
app.get('/api/accounts/:id/mails/:uid/attachments/:index', async (req, res) => {
  const client = clients.get(parseInt(req.params.id, 10));
  if (!client) return res.status(404).json({ error: '账户不存在' });

  const folder = req.query.folder || 'INBOX';
  const index = parseInt(req.params.index, 10);
  const uid = req.params.uid;

  try {
    await client.ensureConnected();
    const lock = await client.client.getMailboxLock(folder);
    try {
      const source = await client.client.download(uid, undefined, { uid: true });
      const parsed = await simpleParser(source.content);

      const att = parsed.attachments?.[index];
      if (!att) return res.status(404).json({ error: '附件不存在' });

      const filename = att.filename || `attachment_${index}`;
      res.setHeader('Content-Type', att.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.send(att.content);
    } finally {
      lock.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 搜索邮件
app.get('/api/accounts/:id/search', async (req, res) => {
  const client = clients.get(parseInt(req.params.id, 10));
  if (!client) return res.status(404).json({ error: '账户不存在' });

  const folder = req.query.folder || 'INBOX';
  const keyword = req.query.q || '';
  if (!keyword) return res.status(400).json({ error: '请输入搜索关键词' });

  try {
    await client.ensureConnected();
    const lock = await client.client.getMailboxLock(folder);
    try {
      const uids = await client.client.search({ subject: keyword }, { uid: true });
      if (uids.length === 0) return res.json([]);

      const mails = [];
      for await (const msg of client.client.fetch(uids.slice(0, 30), {
        envelope: true,
        flags: true,
        uid: true,
      }, { uid: true })) {
        mails.push({
          uid: msg.uid,
          date: msg.envelope.date,
          from: msg.envelope.from?.[0]
            ? { name: msg.envelope.from[0].name || '', address: msg.envelope.from[0].address }
            : { name: '', address: '(unknown)' },
          subject: msg.envelope.subject || '(no subject)',
          seen: msg.flags?.has('\\Seen') || false,
        });
      }
      mails.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json(mails);
    } finally {
      lock.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 批量导入账户 (格式: email:password，每行一个)
app.post('/api/accounts/batch', async (req, res) => {
  const { lines } = req.body;
  if (!lines || !lines.length) {
    return res.status(400).json({ error: '请提供账户列表' });
  }

  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 支持 email:password 格式
    const sepIdx = trimmed.indexOf(':');
    if (sepIdx === -1) {
      results.push({ email: trimmed, ok: false, error: '格式错误，应为 email:password' });
      continue;
    }

    const email = trimmed.substring(0, sepIdx).trim();
    const password = trimmed.substring(sepIdx + 1).trim();
    if (!email || !password) {
      results.push({ email: email || '(空)', ok: false, error: '邮箱或密码为空' });
      continue;
    }

    // 检查是否已连接
    let alreadyExists = false;
    for (const [existingId, existing] of clients) {
      if (existing.account.auth.user === email) {
        results.push({ id: existingId, email, ok: true, exists: true });
        alreadyExists = true;
        break;
      }
    }
    if (alreadyExists) continue;

    try {
      const account = autoDetect(email, password);
      const client = new MailClient(account);
      await client.connect();
      const id = ++clientId;
      clients.set(id, client);
      results.push({ id, email, ok: true });
    } catch (err) {
      results.push({ email, ok: false, error: err.message });
    }
  }

  if (results.some(r => r.ok)) saveAccounts();
  res.json(results);
});

const PORT = process.env.PORT || 3939;

restoreAccounts().then(() => {
  app.listen(PORT, () => {
    console.log(`IMAP Mail Client 已启动: http://localhost:${PORT}`);
  });
});
