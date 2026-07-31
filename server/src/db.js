const { MongoClient } = require("mongodb");
require("dotenv").config();

const DB_NAME = process.env.MONGODB_DB || "networth";

let client = null;
let db = null;

async function connect() {
  if (db) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. The server cannot start without a database.");

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(DB_NAME);

  // Idempotent: createIndex is a no-op when the index already exists.
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("accounts").createIndex({ userId: 1 }),
    db.collection("transactions").createIndex({ accountId: 1 }),
    db.collection("balanceLogs").createIndex({ accountId: 1 }),
    db.collection("attachments").createIndex({ accountId: 1 }),
  ]);
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

function collections() {
  if (!db) throw new Error("Database is not connected yet.");
  return {
    users: db.collection("users"),
    accounts: db.collection("accounts"),
    transactions: db.collection("transactions"),
    balanceLogs: db.collection("balanceLogs"),
    attachments: db.collection("attachments"),
    otpCodes: db.collection("otpCodes"),
  };
}

module.exports = { connect, close, collections };
