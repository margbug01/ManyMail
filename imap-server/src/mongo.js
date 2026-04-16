const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongodb:27017';
const DB_NAME = process.env.DB_NAME || 'mailserver';

let client;
let db;

async function connect() {
  client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(DB_NAME);

  // Ensure IMAP-specific indexes
  await db.collection('uid_map').createIndex(
    { address: 1, folder: 1, message_id: 1 }, { unique: true }
  );
  await db.collection('uid_map').createIndex(
    { address: 1, folder: 1, uid: 1 }, { unique: true }
  );

  console.log(`MongoDB connected: ${MONGO_URL}/${DB_NAME}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('MongoDB not connected');
  return db;
}

async function close() {
  if (client) await client.close();
}

module.exports = { connect, getDb, close };
