const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_VERSION = 2;
const CIPHER = 'aes-256-gcm';

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptAccount(account, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, deriveKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(account), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptAccount(payload, secret) {
  const decipher = crypto.createDecipheriv(CIPHER, deriveKey(secret), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function createAccountStore(options = {}) {
  const filePath = options.filePath || path.join(__dirname, 'accounts.json');
  const encryptionKey = options.encryptionKey || '';
  const mode = (options.mode || 'encrypted').toLowerCase();
  const logger = options.logger || console;

  function persistenceEnabled() {
    return mode !== 'disabled' && mode !== 'off' && mode !== '0';
  }

  function save(clients) {
    if (!persistenceEnabled()) {
      return false;
    }
    if (!encryptionKey) {
      logger.warn('IMAP account persistence skipped: IMAP_ACCOUNT_ENCRYPTION_KEY is not configured');
      return false;
    }

    const accounts = [];
    clients.forEach((client, id) => {
      accounts.push({ id, payload: encryptAccount(client.account, encryptionKey) });
    });

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: STORE_VERSION, encryption: CIPHER, accounts }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    return true;
  }

  function load() {
    if (!persistenceEnabled() || !fs.existsSync(filePath)) {
      return [];
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      logger.warn(`IMAP account persistence ignored: failed to parse ${filePath}: ${err.message}`);
      return [];
    }

    if (Array.isArray(data)) {
      logger.warn('Legacy plaintext IMAP account file detected; refusing to restore without encrypted storage');
      return [];
    }
    if (data.version !== STORE_VERSION || data.encryption !== CIPHER || !Array.isArray(data.accounts)) {
      logger.warn('IMAP account persistence ignored: unsupported accounts file format');
      return [];
    }
    if (!encryptionKey) {
      logger.warn('Encrypted IMAP accounts exist but IMAP_ACCOUNT_ENCRYPTION_KEY is not configured');
      return [];
    }

    const restored = [];
    for (const item of data.accounts) {
      try {
        restored.push({ id: item.id, account: decryptAccount(item.payload, encryptionKey) });
      } catch (err) {
        logger.warn(`Skipping encrypted IMAP account: ${err.message}`);
      }
    }
    return restored;
  }

  return { save, load, persistenceEnabled };
}

module.exports = { createAccountStore, encryptAccount, decryptAccount };
