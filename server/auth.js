"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { state, toId, ObjectId } = require("./db");

const COOKIE = "bench_session";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

const SECRET = process.env.SESSION_SECRET || "";
if (!SECRET || SECRET.length < 32) {
  // Refuse to start on a weak or default signing key: a guessable secret
  // means anyone can forge an admin session cookie.
  console.error(
    "\n  FATAL: SESSION_SECRET must be set to at least 32 characters.\n" +
    "  Generate one with:  openssl rand -hex 32\n"
  );
  process.exit(1);
}

/* ---------------------------------------------------------------
   Signed cookie sessions — no server-side session store required
   --------------------------------------------------------------- */

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function issue(res, userId, epoch, secure) {
  // `epoch` is the user's sessionEpoch at issue time. Bumping it on the user
  // doc (logout-all / password change) invalidates every cookie minted before.
  const payload = JSON.stringify({
    uid: String(userId), epoch: Number(epoch) || 0, exp: Date.now() + MAX_AGE_MS
  });
  const body = Buffer.from(payload).toString("base64url");
  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true,
    sameSite: "strict", // blocks cross-site POSTs — this is the CSRF defence
    secure: !!secure,
    maxAge: MAX_AGE_MS,
    path: "/"
  });
}

function clear(res) {
  res.clearCookie(COOKIE, { path: "/" });
}

function read(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  if (i < 1) return null;

  const body = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(body);

  // Constant-time compare — a plain === leaks signature bytes via timing.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || !data.uid || !data.exp || Date.now() > data.exp) return null;
  return data;
}

async function currentUser(req) {
  const s = read(req);
  if (!s) return null;
  const _id = toId(s.uid);
  if (!_id) return null;
  const user = await state.users.findOne({ _id }, { projection: { passwordHash: 0 } });
  if (!user) return null;
  // Reject a cookie minted before the user's epoch was bumped. Missing field
  // reads as 0, so sessions from before this feature keep working.
  if (Number(s.epoch || 0) !== Number(user.sessionEpoch || 0)) return null;
  return { id: String(user._id), username: user.username };
}

async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/* ---------------------------------------------------------------
   Login throttling — in-memory, per IP.
   Single-node service, so a Map is enough; move to Redis if this
   ever runs more than one replica.
   --------------------------------------------------------------- */

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

// Prune expired keys periodically. Without this, throttle keys (which can be
// attacker-influenced when a proxy is misconfigured) accumulate for the life
// of the process. unref() so it never holds the event loop open.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (now - rec.first > WINDOW_MS) attempts.delete(ip);
  }
}, WINDOW_MS);
if (sweeper.unref) sweeper.unref();

/* ---------------------------------------------------------------
   bcrypt concurrency cap
   bcryptjs is pure JS on the main thread: N simultaneous compares
   interleave and burn the SUM of their runtimes on the one thread,
   which is a cheap unauthenticated event-loop DoS. Bound the number
   of concurrent KDF operations and queue the rest — a burst becomes
   added latency instead of a stalled server.
   --------------------------------------------------------------- */

const KDF_MAX = Number(process.env.KDF_CONCURRENCY || 4);
let kdfActive = 0;
const kdfQueue = [];

function kdfAcquire() {
  if (kdfActive < KDF_MAX) { kdfActive++; return Promise.resolve(); }
  return new Promise((resolve) => kdfQueue.push(resolve));
}
function kdfRelease() {
  const next = kdfQueue.shift();
  if (next) next(); // hand the slot straight over; active count unchanged
  else kdfActive--;
}
async function kdf(fn) {
  await kdfAcquire();
  try { return await fn(); }
  finally { kdfRelease(); }
}

// A real bcrypt hash of a value nobody can supply, used so the no-such-user
// path still costs a full comparison.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Q0V6Zx7uL0Q3Yb1qk3sPqYtQ0m3S9K";

async function verify(username, password) {
  const user = await state.users.findOne({ username: String(username || "") });
  const hashToCheck = user ? user.passwordHash : DUMMY_HASH;

  // Always compare, even when the user is missing, so response timing
  // doesn't reveal whether the username exists.
  const ok = await kdf(() => bcrypt.compare(String(password || ""), hashToCheck));
  return ok && user
    ? { id: String(user._id), username: user.username, epoch: Number(user.sessionEpoch || 0) }
    : null;
}

async function hash(password) {
  return kdf(() => bcrypt.hash(String(password), 12));
}

module.exports = {
  issue, clear, currentUser, requireAuth, verify, hash,
  tooManyAttempts, noteFailure, clearAttempts, ObjectId
};
