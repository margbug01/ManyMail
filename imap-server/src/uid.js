const { ObjectId } = require('mongodb');
const { getDb } = require('./mongo');

/**
 * Assigns stable sequential IMAP UIDs to MongoDB documents.
 * Uses uid_map + uid_counters collections for atomic assignment.
 */

async function getOrAssignUids(address, folder, messageIds) {
  if (messageIds.length === 0) return [];

  const db = getDb();
  const uidMap = db.collection('uid_map');
  const counters = db.collection('uid_counters');
  const counterKey = `${address}:${folder}`;

  // Find existing assignments
  const existing = await uidMap.find({
    address, folder, message_id: { $in: messageIds },
  }).toArray();

  const mapped = new Map(existing.map(e => [e.message_id.toHexString(), e.uid]));
  const missing = messageIds.filter(id => !mapped.has(id.toHexString()));

  // Assign UIDs for new messages (atomic counter increment)
  if (missing.length > 0) {
    const result = await counters.findOneAndUpdate(
      { _id: counterKey },
      { $inc: { next_uid: missing.length }, $setOnInsert: { uid_validity: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    const nextUid = result.next_uid;
    const startUid = nextUid - missing.length + 1;

    const docs = missing.map((id, i) => ({
      address, folder, message_id: id, uid: startUid + i,
    }));

    try {
      await uidMap.insertMany(docs, { ordered: false });
    } catch (e) {
      // Ignore duplicate key errors (concurrent assignment)
      if (e.code !== 11000) throw e;
    }

    docs.forEach(d => mapped.set(d.message_id.toHexString(), d.uid));
  }

  return messageIds.map(id => ({
    message_id: id,
    uid: mapped.get(id.toHexString()) || 0,
  }));
}

async function getUidValidity(address, folder) {
  const db = getDb();
  const doc = await db.collection('uid_counters').findOne({ _id: `${address}:${folder}` });
  return doc?.uid_validity || 1;
}

async function getUidNext(address, folder) {
  const db = getDb();
  const doc = await db.collection('uid_counters').findOne({ _id: `${address}:${folder}` });
  return (doc?.next_uid || 0) + 1;
}

async function resolveUidToMessageId(address, folder, uid) {
  const db = getDb();
  const doc = await db.collection('uid_map').findOne({ address, folder, uid });
  return doc?.message_id || null;
}

async function resolveUidsToMessageIds(address, folder, uids) {
  const db = getDb();
  const docs = await db.collection('uid_map').find({
    address, folder, uid: { $in: uids },
  }).toArray();
  return new Map(docs.map(d => [d.uid, d.message_id]));
}

module.exports = { getOrAssignUids, getUidValidity, getUidNext, resolveUidToMessageId, resolveUidsToMessageIds };
