require('dotenv').config();

// 预设的邮箱服务器配置
const PRESETS = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  gmx: { host: 'imap.gmx.com', port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true },
  qq: { host: 'imap.qq.com', port: 993, secure: true },
  '163': { host: 'imap.163.com', port: 993, secure: true },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  caramail: { host: 'imap.gmx.com', port: 993, secure: true }, // caramail 使用 GMX 服务器
};

/**
 * 从 .env 解析账户配置
 * 格式: 名称|IMAP服务器|端口|邮箱地址|密码
 */
function parseAccounts() {
  const raw = process.env.ACCOUNTS;
  if (!raw) return [];

  return raw.split(',').map(entry => {
    const [name, host, port, user, pass] = entry.trim().split('|');
    return {
      name: name.trim(),
      host: host.trim(),
      port: parseInt(port.trim(), 10),
      secure: true,
      auth: {
        user: user.trim(),
        pass: pass.trim(),
      },
    };
  });
}

/**
 * 用预设快速创建账户配置
 */
function fromPreset(preset, email, password) {
  const conf = PRESETS[preset.toLowerCase()];
  if (!conf) {
    throw new Error(`未知预设: ${preset}，可用: ${Object.keys(PRESETS).join(', ')}`);
  }
  return {
    name: preset,
    ...conf,
    auth: { user: email, pass: password },
  };
}

/**
 * 根据邮箱域名自动匹配 IMAP 配置
 */
const DOMAIN_MAP = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'gmx.com': 'gmx',
  'gmx.net': 'gmx',
  'gmx.de': 'gmx',
  'caramail.com': 'caramail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'qq.com': 'qq',
  'foxmail.com': 'qq',
  '163.com': '163',
  '126.com': '163',
  'yahoo.com': 'yahoo',
  'yahoo.co.jp': 'yahoo',
};

function autoDetect(email, password) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) throw new Error(`无效邮箱: ${email}`);

  const presetKey = DOMAIN_MAP[domain];
  if (presetKey) {
    return fromPreset(presetKey, email, password);
  }

  // 未知域名，尝试通用 imap.域名
  return {
    name: domain,
    host: `imap.${domain}`,
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
  };
}

module.exports = { PRESETS, DOMAIN_MAP, parseAccounts, fromPreset, autoDetect };
