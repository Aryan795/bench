"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { marked } = require("marked");

const {
  connect, close, state, DATA_DIR,
  uniqueSlug, readMinutes, toId, out
} = require("./db");
const auth = require("./auth");
const { seedIfEmpty } = require("./seed");
const { mdToPost, decodeText } = require("./import");

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const SECURE_COOKIES = process.env.SECURE_COOKIES === "true";

const app = express();

// Behind Caddy / Cloudflare Tunnel, req.ip must come from X-Forwarded-For, so
// TRUST_PROXY = the number of proxy hops. Fail CLOSED to 0 when unset: trusting
// XFF with no real proxy in front lets a client spoof req.ip, which is the
// throttle key. Never default this to 1.
const TP_RAW = process.env.TRUST_PROXY;
const TP_HOPS = TP_RAW === undefined || TP_RAW === "" ? 0 : Number(TP_RAW);
app.set("trust proxy", Number.isInteger(TP_HOPS) && TP_HOPS >= 0 ? TP_HOPS : 0);
app.disable("x-powered-by");

// Where the app binds. Defaults to loopback so a bare `node server.js` is never
// silently LAN-exposed. In Docker, compose sets BIND_HOST=0.0.0.0 and the
// published port (127.0.0.1:4000:4000) is what restricts host access.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
// Absolute origin used to validate admin requests (CSRF). Behind a proxy this
// must be the public URL, e.g. https://bench.example.com.
const SELF_ORIGIN = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/* ---------------------------------------------------------------
   Baseline security headers

   The admin panel is a same-origin page that performs state-changing
   actions, so it must not be framable: without frame-ancestors an
   attacker's page can iframe /admin and clickjack a logged-in admin
   into deleting posts. base-uri and form-action close the two ways
   injected markup could redirect a form or rewrite relative URLs.

   'unsafe-inline' is required for script and style because the site
   and the admin panel are deliberately single files with inline
   <style> and <script>. It weakens XSS defence-in-depth, but the
   framing, form and object controls below still hold.
   --------------------------------------------------------------- */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY"); // for browsers predating frame-ancestors
  res.setHeader("Referrer-Policy", "no-referrer");
  // Only meaningful over TLS; harmless on plain HTTP, and stops the header
  // being forgotten at the moment a proxy is put in front.
  if (SECURE_COOKIES) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

/* ---------------------------------------------------------------
   Markdown rendering
   --------------------------------------------------------------- */

const renderer = new marked.Renderer();

/** Blocks javascript:/vbscript:/data: hrefs. Only the admin authors, but a
 *  pasted link is the cheapest possible foot-gun to close. */
function safeHref(href) {
  const h = String(href || "").trim();
  if (/^(javascript|vbscript|file):/i.test(h)) return "";
  if (/^data:/i.test(h) && !/^data:image\//i.test(h)) return "";
  return h;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Images become figures.
 *
 * `![alt](/uploads/x.jpg "A caption")` -> <figure> with <figcaption>
 * Width is taken from a URL fragment, which stays invisible in any other
 * Markdown renderer:  /uploads/x.jpg#wide  ·  #full
 *
 * marked changed renderer signatures from positional args to a token object
 * in v13, so accept both rather than pinning to one minor version.
 */
renderer.image = function (a, b, c) {
  let href, title, alt;
  if (a && typeof a === "object") { href = a.href; title = a.title; alt = a.text; }
  else { href = a; title = b; alt = c; }

  href = safeHref(href);
  if (!href) return "";

  let size = "";
  const hash = href.indexOf("#");
  if (hash > -1) {
    const frag = href.slice(hash + 1).toLowerCase();
    if (frag === "wide" || frag === "full") size = frag;
    href = href.slice(0, hash);
  }

  return '<figure class="fig' + (size ? " fig--" + size : "") + '">' +
    '<img src="' + esc(href) + '" alt="' + esc(alt || "") + '" loading="lazy" decoding="async">' +
    (title ? '<figcaption>' + esc(title) + '</figcaption>' : '') +
    '</figure>';
};

/* A <figure> inside a <p> is invalid HTML, and marked wraps a lone inline
   image in a paragraph. Unwrap when the paragraph holds nothing else. */
renderer.paragraph = function (a) {
  const text = a && typeof a === "object"
    ? marked.Renderer.prototype.paragraph.call(this, a)
    : "<p>" + a + "</p>";
  const inner = text.replace(/^<p>/, "").replace(/<\/p>\n?$/, "").trim();
  if (inner.startsWith("<figure") && inner.endsWith("</figure>")) return inner + "\n";
  return text;
};

/** External links open in a new tab, and carry rel to close the opener hole. */
renderer.link = function (a, b, c) {
  let href, title, text;
  if (a && typeof a === "object") { href = a.href; title = a.title; text = this.parser.parseInline(a.tokens); }
  else { href = a; title = b; text = c; }

  href = safeHref(href);
  if (!href) return text || "";

  const external = /^https?:\/\//i.test(href);
  return '<a href="' + esc(href) + '"' +
    (title ? ' title="' + esc(title) + '"' : "") +
    (external ? ' target="_blank" rel="noopener noreferrer"' : "") +
    ">" + text + "</a>";
};

marked.setOptions({ gfm: true, breaks: false, renderer });

/* ---------------------------------------------------------------
   Helpers
   --------------------------------------------------------------- */

const DOMAINS = new Set(["sw", "hw", "ml"]);
const STATUSES = new Set(["draft", "published"]);

function bad(res, msg) {
  return res.status(400).json({ error: msg });
}

function str(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

/** A cover must be one of our own uploads, or nothing. Rejects absolute URLs,
 *  javascript:, traversal — anything that isn't /uploads/<safe-name>. */
function coverPath(v) {
  const s = str(v, 300);
  return /^\/uploads\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

function render(md) {
  return marked.parse(String(md || ""));
}

/** Shape a post for public consumption. */
function publicPost(doc) {
  const p = out(doc);
  if (!p) return null;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    dek: p.dek,
    category: p.category,
    cover: p.cover || null,
    projectSlug: p.projectSlug || null,
    readMinutes: p.readMinutes,
    status: p.status,
    publishedAt: p.publishedAt || null,
    updatedAt: p.updatedAt,
    bodyHtml: render(p.bodyMd)
  };
}

function publicProject(doc) {
  const p = out(doc);
  if (!p) return null;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    headline: p.headline,
    dek: p.dek,
    domain: p.domain,
    year: p.year,
    state: p.state,
    metric: p.metric,
    metricKey: p.metricKey,
    spec: Array.isArray(p.spec) ? p.spec : [],
    plate: p.plate || null,
    cover: p.cover || null,
    status: p.status,
    bodyHtml: render(p.bodyMd)
  };
}

/* ---------------------------------------------------------------
   Uploads
   --------------------------------------------------------------- */

const ALLOWED_IMAGE = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"],
  ["image/webp", ".webp"], ["image/gif", ".gif"], ["image/svg+xml", ".svg"]
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      // Never trust the client filename for the path — derive the extension
      // from the vetted mimetype and randomise the stem.
      const ext = ALLOWED_IMAGE.get(file.mimetype) || "";
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WebP, GIF or SVG images are accepted"));
    }
    cb(null, true);
  }
});

/* ---------------------------------------------------------------
   Markdown import

   Held in memory, not written to UPLOAD_DIR: a .md file is parsed and
   discarded in the same request, so persisting it would leave litter in
   the image library and eat the upload budget for nothing.
   --------------------------------------------------------------- */

const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;

const mdUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Filtered on extension, not mimetype: browsers report .md as
    // text/markdown, text/plain or application/octet-stream depending on
    // the OS, so the mimetype is not a usable signal here. decodeText()
    // is what actually rejects a binary file wearing a .md name.
    if (!MD_EXT.test(file.originalname || "")) {
      return cb(new Error("Only .md, .markdown or .txt files are accepted"));
    }
    cb(null, true);
  }
});

/* ===============================================================
   PUBLIC API
   =============================================================== */

// One call the site can boot from, rather than three round trips.
app.get("/api/site", async (_req, res, next) => {
  try {
    const [posts, projects] = await Promise.all([
      state.posts.find({ status: "published" }).sort({ publishedAt: -1 }).toArray(),
      state.projects.find({ status: "published" }).sort({ year: -1, sort: 1 }).toArray()
    ]);
    res.json({
      posts: posts.map(publicPost),
      projects: projects.map(publicProject)
    });
  } catch (err) { next(err); }
});

app.get("/api/posts", async (_req, res, next) => {
  try {
    const rows = await state.posts.find({ status: "published" }).sort({ publishedAt: -1 }).toArray();
    res.json(rows.map(publicPost));
  } catch (err) { next(err); }
});

app.get("/api/posts/:slug", async (req, res, next) => {
  try {
    const row = await state.posts.findOne({ slug: str(req.params.slug, 100), status: "published" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(publicPost(row));
  } catch (err) { next(err); }
});

app.get("/api/projects", async (_req, res, next) => {
  try {
    const rows = await state.projects.find({ status: "published" }).sort({ year: -1, sort: 1 }).toArray();
    res.json(rows.map(publicProject));
  } catch (err) { next(err); }
});

app.get("/api/projects/:slug", async (req, res, next) => {
  try {
    const row = await state.projects.findOne({ slug: str(req.params.slug, 100), status: "published" });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(publicProject(row));
  } catch (err) { next(err); }
});

/* ===============================================================
   AUTH
   =============================================================== */

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const ip = req.ip || "unknown";
    if (auth.tooManyAttempts(ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    }
    // Reserve the slot BEFORE the bcrypt compare. Counting only on failure
    // afterwards let a concurrent burst all pass the check while the first
    // compare was still in flight, then pile bcrypt work onto the one thread.
    auth.noteFailure(ip);
    const user = await auth.verify(req.body && req.body.username, req.body && req.body.password);
    if (!user) {
      // Deliberately vague: never reveal which half was wrong.
      return res.status(401).json({ error: "Wrong username or password" });
    }
    auth.clearAttempts(ip); // a correct login forgives the reserved attempt
    auth.issue(res, user.id, user.epoch, SECURE_COOKIES);
    res.json({ user: { id: user.id, username: user.username } });
  } catch (err) { next(err); }
});

app.post("/api/auth/logout", (req, res) => {
  auth.clear(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res, next) => {
  try {
    const user = await auth.currentUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    res.json({ user });
  } catch (err) { next(err); }
});

/* ===============================================================
   ADMIN — everything below requires a session
   =============================================================== */

const admin = express.Router();

// CSRF gate. SameSite=Strict alone is scoped to the registrable domain, so a
// sibling service (jellyfin.example.com) is "same-site" and its pages can drive
// state-changing admin requests with the cookie attached. The JSON routes are
// already protected by the CORS preflight application/json forces, but the
// multipart upload route is a CORS-simple request and slips through. Reject any
// cross-origin state change explicitly. Requests with neither header (curl, our
// own scripts) pass — this is a browser control, not authorization.
admin.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  const origin = req.get("origin");
  if (origin && origin !== SELF_ORIGIN) {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  next();
});

admin.use(auth.requireAuth);

/* ---- posts ---- */

admin.get("/posts", async (_req, res, next) => {
  try {
    const rows = await state.posts.find({}).sort({ updatedAt: -1 }).toArray();
    res.json(rows.map(d => ({ ...publicPost(d), bodyMd: d.bodyMd })));
  } catch (err) { next(err); }
});

admin.get("/posts/:id", async (req, res, next) => {
  try {
    const _id = toId(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const row = await state.posts.findOne({ _id });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ ...publicPost(row), bodyMd: row.bodyMd });
  } catch (err) { next(err); }
});

async function postPayload(body, ignoreId) {
  const title = str(body.title, 200);
  if (!title) throw new Error("Title is required");

  const status = STATUSES.has(body.status) ? body.status : "draft";
  const bodyMd = String(body.bodyMd || "");
  const slug = await uniqueSlug(state.posts, str(body.slug, 100) || title, ignoreId);

  return {
    slug,
    title,
    dek: str(body.dek, 400),
    bodyMd,
    category: str(body.category, 60) || "Essay",
    cover: coverPath(body.cover),
    projectSlug: str(body.projectSlug, 100) || null,
    readMinutes: readMinutes(bodyMd),
    status,
    updatedAt: new Date().toISOString()
  };
}

admin.post("/posts", async (req, res, next) => {
  try {
    const doc = await postPayload(req.body || {});
    doc.createdAt = new Date().toISOString();
    // publishedAt is stamped the first time it goes live, and kept thereafter
    // so re-editing a published post doesn't reorder the feed.
    doc.publishedAt = doc.status === "published" ? new Date().toISOString() : null;

    const r = await state.posts.insertOne(doc);
    const row = await state.posts.findOne({ _id: r.insertedId });
    res.status(201).json({ ...publicPost(row), bodyMd: row.bodyMd });
  } catch (err) {
    if (err && err.code === 11000) return bad(res, "That slug is already taken");
    if (err instanceof Error && /required/.test(err.message)) return bad(res, err.message);
    next(err);
  }
});

admin.put("/posts/:id", async (req, res, next) => {
  try {
    const _id = toId(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const existing = await state.posts.findOne({ _id });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const doc = await postPayload(req.body || {}, req.params.id);
    if (doc.status === "published") {
      doc.publishedAt = existing.publishedAt || new Date().toISOString();
    } else {
      doc.publishedAt = null;
    }

    await state.posts.updateOne({ _id }, { $set: doc });
    const row = await state.posts.findOne({ _id });
    res.json({ ...publicPost(row), bodyMd: row.bodyMd });
  } catch (err) {
    if (err && err.code === 11000) return bad(res, "That slug is already taken");
    if (err instanceof Error && /required/.test(err.message)) return bad(res, err.message);
    next(err);
  }
});

admin.delete("/posts/:id", async (req, res, next) => {
  try {
    const _id = toId(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const r = await state.posts.deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---- projects ---- */

admin.get("/projects", async (_req, res, next) => {
  try {
    const rows = await state.projects.find({}).sort({ year: -1, sort: 1 }).toArray();
    res.json(rows.map(d => ({ ...publicProject(d), bodyMd: d.bodyMd })));
  } catch (err) { next(err); }
});

async function projectPayload(body, ignoreId) {
  const title = str(body.title, 200);
  if (!title) throw new Error("Title is required");

  const year = Number(body.year);
  const bodyMd = String(body.bodyMd || "");

  let spec = [];
  if (Array.isArray(body.spec)) {
    spec = body.spec
      .filter(r => r && str(r[0] ?? r.k, 60))
      .slice(0, 12)
      .map(r => [str(r[0] ?? r.k, 60), str(r[1] ?? r.v, 60)]);
  }

  return {
    slug: await uniqueSlug(state.projects, str(body.slug, 100) || title, ignoreId),
    title,
    headline: str(body.headline, 300),
    dek: str(body.dek, 400),
    bodyMd,
    domain: DOMAINS.has(body.domain) ? body.domain : "sw",
    year: Number.isFinite(year) ? Math.min(2100, Math.max(1970, Math.trunc(year))) : new Date().getFullYear(),
    state: str(body.state, 40) || "Active",
    metric: str(body.metric, 40),
    metricKey: str(body.metricKey, 80),
    spec,
    plate: str(body.plate, 60) || null,
    cover: coverPath(body.cover),
    status: STATUSES.has(body.status) ? body.status : "published",
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : 0,
    updatedAt: new Date().toISOString()
  };
}

admin.post("/projects", async (req, res, next) => {
  try {
    const doc = await projectPayload(req.body || {});
    doc.createdAt = new Date().toISOString();
    const r = await state.projects.insertOne(doc);
    const row = await state.projects.findOne({ _id: r.insertedId });
    res.status(201).json({ ...publicProject(row), bodyMd: row.bodyMd });
  } catch (err) {
    if (err && err.code === 11000) return bad(res, "That slug is already taken");
    if (err instanceof Error && /required/.test(err.message)) return bad(res, err.message);
    next(err);
  }
});

admin.put("/projects/:id", async (req, res, next) => {
  try {
    const _id = toId(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const doc = await projectPayload(req.body || {}, req.params.id);
    const r = await state.projects.updateOne({ _id }, { $set: doc });
    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });
    const row = await state.projects.findOne({ _id });
    res.json({ ...publicProject(row), bodyMd: row.bodyMd });
  } catch (err) {
    if (err && err.code === 11000) return bad(res, "That slug is already taken");
    if (err instanceof Error && /required/.test(err.message)) return bad(res, err.message);
    next(err);
  }
});

admin.delete("/projects/:id", async (req, res, next) => {
  try {
    const _id = toId(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const r = await state.projects.deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---- misc ---- */

admin.post("/preview", (req, res) => {
  res.json({ html: render((req.body && req.body.bodyMd) || "") });
});

/**
 * Parse a Markdown file into editor fields.
 *
 *   POST /api/admin/import   multipart, field name "file"
 *
 * Deliberately writes nothing. The admin panel loads the result into whichever
 * editor is open — post or project — so the author reviews it and saves through
 * the normal path, where the usual validation and slugging apply. An import
 * that fails halfway therefore leaves no partial document behind.
 */
admin.post("/import", (req, res, next) => {
  mdUpload.single("file")(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return bad(res, "That file is larger than 2 MB");
      return bad(res, err.message);
    }
    if (!req.file) return bad(res, "No file received");

    try {
      res.json(mdToPost(decodeText(req.file.buffer), req.file.originalname));
    } catch (e) {
      if (/not text/.test(e.message)) return bad(res, e.message);
      next(e);
    }
  });
});

const UPLOAD_BUDGET_BYTES = Number(process.env.UPLOAD_BUDGET_BYTES || 512 * 1024 * 1024);

/** Total bytes currently held under the upload dir. */
async function uploadDirBytes() {
  try {
    const names = await fs.promises.readdir(UPLOAD_DIR);
    const sizes = await Promise.all(names.map(async (n) => {
      try {
        const st = await fs.promises.stat(path.join(UPLOAD_DIR, n));
        return st.isFile() ? st.size : 0;
      } catch { return 0; }
    }));
    return sizes.reduce((a, b) => a + b, 0);
  } catch { return 0; }
}

admin.post("/upload", async (req, res, next) => {
  try {
    // Cap total upload storage so no session can fill the volume — which shares
    // a filesystem with mongo-data — by looping this endpoint.
    if (await uploadDirBytes() >= UPLOAD_BUDGET_BYTES) {
      return res.status(507).json({ error: "Upload storage is full. Delete old images first." });
    }
    upload.single("image")(req, res, (err) => {
      if (err) return bad(res, err.message);
      if (!req.file) return bad(res, "No file received");
      res.status(201).json({ url: `/uploads/${req.file.filename}`, name: req.file.filename });
    });
  } catch (err) { next(err); }
});

/** The image library — newest first, so the picker opens on what you just added. */
admin.get("/uploads", async (_req, res, next) => {
  try {
    const names = await fs.promises.readdir(UPLOAD_DIR);
    const files = await Promise.all(names.map(async (name) => {
      try {
        const st = await fs.promises.stat(path.join(UPLOAD_DIR, name));
        if (!st.isFile()) return null;
        return { name, url: `/uploads/${name}`, size: st.size, at: st.mtime.toISOString() };
      } catch { return null; }
    }));
    res.json(files.filter(Boolean).sort((a, b) => b.at.localeCompare(a.at)));
  } catch (err) { next(err); }
});

admin.delete("/uploads/:name", async (req, res, next) => {
  try {
    const name = String(req.params.name || "");
    // Reject anything that isn't a plain filename. basename() alone would let
    // "../../etc/x" collapse to "x", but an explicit whitelist is unambiguous.
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
      return bad(res, "Bad filename");
    }
    const target = path.join(UPLOAD_DIR, name);
    if (path.dirname(path.resolve(target)) !== path.resolve(UPLOAD_DIR)) {
      return bad(res, "Bad filename");
    }
    await fs.promises.unlink(target);
    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return res.status(404).json({ error: "Not found" });
    next(err);
  }
});

admin.post("/password", async (req, res, next) => {
  try {
    const current = String((req.body && req.body.current) || "");
    const next_ = String((req.body && req.body.next) || "");
    if (next_.length < 12) return bad(res, "New password must be at least 12 characters");

    const ok = await auth.verify(req.user.username, current);
    if (!ok) return res.status(401).json({ error: "Current password is wrong" });

    const passwordHash = await auth.hash(next_);
    // Bump the epoch so every OTHER outstanding cookie is invalidated on its
    // next request — this is what makes a password change a real remediation
    // for a leaked session. Then re-issue for the admin doing the change so
    // they aren't logged out of the tab they're using.
    await state.users.updateOne(
      { _id: toId(req.user.id) },
      { $set: { passwordHash }, $inc: { sessionEpoch: 1 } }
    );
    const fresh = await state.users.findOne(
      { _id: toId(req.user.id) }, { projection: { sessionEpoch: 1 } }
    );
    auth.issue(res, req.user.id, (fresh && fresh.sessionEpoch) || 0, SECURE_COOKIES);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Sign out every session, including this one. */
admin.post("/logout-all", async (req, res, next) => {
  try {
    await state.users.updateOne({ _id: toId(req.user.id) }, { $inc: { sessionEpoch: 1 } });
    auth.clear(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.use("/api/admin", admin);

/* ===============================================================
   STATIC
   =============================================================== */

app.use("/uploads", express.static(UPLOAD_DIR, {
  maxAge: "30d",
  // An uploaded SVG is a same-origin document that could otherwise run script.
  // A locked-down CSP neutralises it; nosniff stops content-type games; sandbox
  // and frame-ancestors keep it from being framed or navigating.
  setHeaders: (res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
      "sandbox; form-action 'none'; frame-ancestors 'none'"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
}));

// A missing image must 404. Without this it falls through to the SPA catch-all
// below and every broken <img> downloads the whole HTML shell with HTTP 200 —
// which hides the mistake and wastes ~60 kB per broken image.
app.use("/uploads", (_req, res) => res.status(404).json({ error: "Not found" }));

app.use(express.static(PUBLIC_DIR, { extensions: ["html"], maxAge: "1h" }));

app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

// The site is a hash-routed SPA, so anything unmatched that isn't /api
// falls through to the shell.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

/* ===============================================================
   BOOT
   =============================================================== */

(async () => {
  try {
    await connect();
    console.log(`  mongo    connected (${process.env.MONGO_DB || "bench"})`);

    const seeded = await seedIfEmpty();
    if (seeded.user) {
      console.log(`  admin    created user "${seeded.user}"`);
    }
    if (seeded.content) {
      console.log(`  content  seeded ${seeded.projects} projects, ${seeded.posts} posts`);
    }

    if (!fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
      console.warn("  warning  public/index.html is missing — run: npm run build");
    }

    app.listen(PORT, BIND_HOST, () => {
      console.log(`  bench    http://${BIND_HOST}:${PORT}`);
      console.log(`  admin    http://${BIND_HOST}:${PORT}/admin\n`);
    });
  } catch (err) {
    console.error("\n  Failed to start:", err.message, "\n");
    process.exit(1);
  }
})();

async function shutdown() {
  try { await close(); } catch { /* already closing */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
