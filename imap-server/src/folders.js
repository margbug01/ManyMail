/**
 * Virtual folder definitions — maps IMAP folder names to MongoDB queries.
 */

const FOLDERS = {
  INBOX: {
    collection: 'messages',
    filter: (address) => ({ to_addresses: address, is_deleted: { $ne: true } }),
    flags: ['\\HasNoChildren'],
    writable: true,
  },
  Sent: {
    collection: 'sent_messages',
    filter: (address) => ({ from_address: address }),
    flags: ['\\HasNoChildren', '\\Sent'],
    writable: false,
  },
  Trash: {
    collection: 'messages',
    filter: (address) => ({ to_addresses: address, is_deleted: true }),
    flags: ['\\HasNoChildren', '\\Trash'],
    writable: true,
  },
};

const FOLDER_NAMES = Object.keys(FOLDERS);

function getFolder(name) {
  // Case-insensitive lookup
  const key = FOLDER_NAMES.find(k => k.toLowerCase() === (name || '').toLowerCase());
  return key ? { name: key, ...FOLDERS[key] } : null;
}

module.exports = { FOLDERS, FOLDER_NAMES, getFolder };
