"use strict";

/**
 * Markdown file import.
 *
 * Turns the bytes of an uploaded .md file into the same field shape the post
 * editor and POST /api/admin/posts already speak, so an import runs through
 * exactly the validation, slugging and rendering path a hand-written post
 * does. Nothing here touches the database — this module is pure text work,
 * which keeps it testable and lets the route decide whether to persist.
 */

/* ---------------------------------------------------------------
   Front matter

   A deliberately small YAML subset: `key: value` scalars only. That
   covers every field a post actually has, and avoids adding a YAML
   parser to the dependency list for a handful of string assignments.
   Nested maps, block scalars and multi-line lists are not supported
   and are reported as ignored rather than half-parsed.
   --------------------------------------------------------------- */

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/**
 * Splits leading `---` front matter from the body.
 * Returns { data, body, unsupported } — `unsupported` lists keys whose
 * value spanned more than one line, so the caller can warn instead of
 * silently importing a field that reads as an empty string.
 */
function parseFrontMatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text, unsupported: [] };

  const data = {};
  const unsupported = [];
  let lastKey = null;

  for (const raw of m[1].split("\n")) {
    // A whole-line `#` comment. Inline `#` is NOT treated as a comment:
    // our own image syntax uses fragments like /uploads/x.jpg#wide, and
    // stripping those would quietly corrupt a cover path.
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    // An indented or `- ` line continues the previous key: a list or a
    // block scalar, neither of which this parser handles.
    if (/^\s+\S/.test(raw) || /^\s*-\s/.test(raw)) {
      if (lastKey && unsupported.indexOf(lastKey) === -1) unsupported.push(lastKey);
      continue;
    }

    const line = raw.trim();
    const i = line.indexOf(":");
    if (i < 1) continue;

    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    lastKey = key;

    if (!value) { unsupported.push(key); continue; }
    data[key] = unquote(value);
  }

  return { data, body: text.slice(m[0].length), unsupported };
}

/** Strips one matching pair of surrounding quotes. */
function unquote(v) {
  const s = String(v);
  if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

/* ---------------------------------------------------------------
   Helpers
   --------------------------------------------------------------- */

function str(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

/** Flattens inline Markdown so a heading can be reused as plain-text prose. */
function stripInline(s) {
  return String(s || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")   // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")    // links  -> label
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_](\S)/g, "$1$2")
    .replace(/(\S)[*_](\s|$)/g, "$1$2")
    .trim();
}

/** "my-first-post.md" -> "My first post", used only when nothing better exists. */
function titleFromFilename(name) {
  const base = String(name || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "Untitled";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const STATUSES = new Set(["draft", "published"]);
const IMG_MD_RE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)/g;
const IMG_TAG_RE = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
// Raw HTML that executes, or is a vector for it. marked passes HTML through
// untouched, so an imported file is the one place hostile markup could arrive
// from outside. We do not strip it — that would silently mangle legitimate
// markup — we surface it and let the author look before publishing.
const RISKY_HTML_RE = /<\s*\/?\s*(script|iframe|object|embed|form|link|meta|base)\b|\son[a-z]+\s*=/i;

/** Image targets that will not resolve once the post is live. */
function danglingImages(md) {
  const out = [];
  const seen = new Set();
  const collect = (re) => {
    let m;
    while ((m = re.exec(md))) {
      const url = String(m[1] || "").split("#")[0];
      if (!url || seen.has(url)) continue;
      if (/^(https?:)?\/\//i.test(url) || /^data:/i.test(url) || url.startsWith("/uploads/")) continue;
      seen.add(url);
      out.push(url);
    }
  };
  collect(IMG_MD_RE);
  collect(IMG_TAG_RE);
  return out;
}

/* ---------------------------------------------------------------
   Decoding
   --------------------------------------------------------------- */

/**
 * Buffer -> text, refusing anything that isn't plausibly a text file.
 * A NUL byte means a binary file arrived with a .md name; decoding it
 * would produce a post full of replacement characters.
 */
function decodeText(buf) {
  if (buf.includes(0)) throw new Error("That file is not text");
  return buf.toString("utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/* ---------------------------------------------------------------
   The import itself
   --------------------------------------------------------------- */

/**
 * Parses one Markdown document into post fields plus a list of things the
 * author should look at before publishing.
 *
 * Title resolution, in order: front matter `title`, a leading `# H1`, then
 * the filename. A leading H1 is removed from the body because the site
 * renders the title itself — leaving it would print the headline twice.
 * If a `##`/`###` line immediately follows that H1 it is taken as the
 * standfirst, which is the shape most drafts are already written in.
 */
function mdToPost(text, filename) {
  const warnings = [];
  const { data, body: afterFm, unsupported } = parseFrontMatter(text);

  const lines = afterFm.replace(/^\n+/, "").split("\n");

  // A leading H1 becomes the title.
  let h1 = null;
  {
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const m = i < lines.length ? /^#[ \t]+(.+?)\s*$/.exec(lines[i]) : null;
    if (m) { h1 = stripInline(m[1]); lines.splice(0, i + 1); }
  }

  // A heading directly under it becomes the standfirst.
  let subtitle = null;
  if (h1) {
    let j = 0;
    while (j < lines.length && !lines[j].trim()) j++;
    const m = j < lines.length ? /^#{2,3}[ \t]+(.+?)\s*$/.exec(lines[j]) : null;
    if (m) { subtitle = stripInline(m[1]); lines.splice(0, j + 1); }
  }

  const bodyMd = lines.join("\n").replace(/^\n+/, "").trimEnd();

  const title = str(data.title, 200) || h1 || titleFromFilename(filename);
  const dek = str(data.dek || data.description || data.summary || data.subtitle || subtitle || "", 400);
  const status = STATUSES.has(String(data.status)) ? String(data.status) : "draft";
  const cover = str(data.cover, 300);

  /* ---- warnings ---- */

  if (!bodyMd) warnings.push("The file has no body text.");
  if (!data.title && !h1) {
    warnings.push('No title found — using the filename. Add a "# Heading" or a front matter title.');
  }
  if (!dek) warnings.push("No standfirst. Add one before publishing — it shows on the card.");

  if (cover && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(cover)) {
    warnings.push('Cover "' + cover + '" is not an uploaded image, so it was dropped. Upload it, then set the cover in the editor.');
  }

  const dangling = danglingImages(bodyMd);
  if (dangling.length) {
    const shown = dangling.slice(0, 4).join(", ");
    warnings.push(
      dangling.length + " image path" + (dangling.length === 1 ? "" : "s") +
      " will not resolve (" + shown + (dangling.length > 4 ? ", …" : "") +
      "). Upload the files, then re-point the paths at /uploads/."
    );
  }

  if (RISKY_HTML_RE.test(bodyMd)) {
    warnings.push("Contains raw HTML that can execute (script, iframe or an on… handler). It is rendered as-is — read it before publishing.");
  }

  if (data.date || data.publishedat || data.published) {
    warnings.push("A date in the front matter is ignored: publishing stamps the date when you set the status to published.");
  }

  if (unsupported.length) {
    warnings.push("Front matter " + unsupported.slice(0, 4).map(k => '"' + k + '"').join(", ") +
      " could not be read — only single-line `key: value` entries are supported.");
  }

  const words = bodyMd.trim() ? bodyMd.trim().split(/\s+/).length : 0;

  return {
    filename: String(filename || "").replace(/^.*[\\/]/, "").slice(0, 200),
    title,
    dek,
    slug: str(data.slug, 100),
    category: str(data.category, 60) || "Essay",
    projectSlug: str(data.project || data.projectslug, 100),
    cover: /^\/uploads\/[A-Za-z0-9._-]+$/.test(cover) ? cover : null,
    status,
    bodyMd,
    words,
    warnings
  };
}

module.exports = { parseFrontMatter, mdToPost, decodeText, titleFromFilename, stripInline };
