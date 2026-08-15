"use strict";

const path = require("path");
const fs = require("fs");
const { MongoClient, ObjectId } = require("mongodb");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });

const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB || "bench";

const client = new MongoClient(MONGO_URL, {
  serverSelectionTimeoutMS: 8000,
  retryWrites: true
});

const state = { db: null, users: null, posts: null, projects: null };

async function connect() {
  await client.connect();
  const db = client.db(MONGO_DB);

  state.db = db;
  state.users = db.collection("users");
  state.posts = db.collection("posts");
  state.projects = db.collection("projects");

  // Unique indexes are the real guard against duplicate slugs. The
  // check-then-insert in uniqueSlug() races under concurrent writes; the
  // index is what actually enforces it, so inserts also handle E11000.
  await state.users.createIndex({ username: 1 }, { unique: true });
  await state.posts.createIndex({ slug: 1 }, { unique: true });
  await state.posts.createIndex({ status: 1, publishedAt: -1 });
  await state.projects.createIndex({ slug: 1 }, { unique: true });
  await state.projects.createIndex({ status: 1, year: -1 });

  return db;
}

async function close() {
  await client.close();
}

/* ---------------------------------------------------------------
   Slugs
   --------------------------------------------------------------- */

function slugify(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

/**
 * A slug unique within `col`, appending -2, -3, … on collision.
 * `ignoreId` lets a document keep its own slug while being edited.
 */
async function uniqueSlug(col, desired, ignoreId) {
  const base = slugify(desired);
  let slug = base;
  let n = 2;
  for (;;) {
    const q = { slug };
    if (ignoreId) q._id = { $ne: toId(ignoreId) };
    const hit = await col.findOne(q, { projection: { _id: 1 } });
    if (!hit) return slug;
    slug = `${base}-${n++}`;
  }
}

/** ~200 wpm, floor of 1. Recomputed on every save so it can't drift from the body. */
function readMinutes(md) {
  const words = String(md).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Accepts a 24-char hex id and returns an ObjectId, or null if malformed. */
function toId(id) {
  if (id instanceof ObjectId) return id;
  return ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
}

/** Mongo _id -> id, so the API never leaks driver types to the client. */
function out(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}

module.exports = {
  connect, close, state, DATA_DIR,
  slugify, uniqueSlug, readMinutes, toId, out, ObjectId
};
