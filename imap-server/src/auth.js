const bcrypt = require('bcryptjs');
const { getDb } = require('./mongo');

async function authenticate(username, password) {
  const db = getDb();
  const address = (username || '').trim().toLowerCase();
  if (!address) return null;

  const account = await db.collection('accounts').findOne({
    address,
    is_active: true,
  });
  if (!account) return null;

  const valid = await bcrypt.compare(password, account.password_hash);
  return valid ? { id: account._id.toHexString(), address: account.address } : null;
}

module.exports = { authenticate };
