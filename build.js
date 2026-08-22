"use strict";

/**
 * Wraps the single-file site source into a standalone document at
 * public/index.html.
 *
 * The source is authored as content-only (a <title>, a <style>, then markup)
 * because that is the form the published artifact expects — the artifact host
 * supplies its own document skeleton. This script supplies the equivalent
 * skeleton for self-hosting, so one source file serves both targets and there
 * is no second copy to keep in sync.
 */

const fs = require("fs");
const path = require("path");

const SRC = process.env.SITE_SRC || path.join(__dirname, "src", "site.html");
const OUT = path.join(__dirname, "public", "index.html");

if (!fs.existsSync(SRC)) {
  console.error(`\n  Source not found: ${SRC}`);
  console.error("  Set SITE_SRC to the site source file, or place it at src/site.html\n");
  process.exit(1);
}

const src = fs.readFileSync(SRC, "utf8");

const titleMatch = src.match(/<title>([\s\S]*?)<\/title>/i);
if (!titleMatch) {
  console.error("\n  Source has no <title> — cannot build.\n");
  process.exit(1);
}
const title = titleMatch[1].trim();

const withoutTitle = src.replace(titleMatch[0], "");
const styleMatch = withoutTitle.match(/<style>[\s\S]*?<\/style>/i);
if (!styleMatch) {
  console.error("\n  Source has no <style> block — cannot build.\n");
  process.exit(1);
}
const style = styleMatch[0];
const body = withoutTitle.replace(style, "").trim();

/* Site-level metadata.
 *
 * A note on scope: this build emits ONE document that serves every route, and
 * the site routes on the hash fragment, which is never sent to the server. So
 * these tags describe the site, not the entry you happen to be looking at.
 * Per-entry description / og:title / JSON-LD would need the server to render
 * /project/:slug rather than handing back this static shell. Until it does,
 * treat what follows as the fallback a crawler or a link preview gets. */
const ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const SITE_NAME = process.env.SITE_NAME || "Bench";
const SITE_DESC = process.env.SITE_DESCRIPTION ||
  "Bench — projects and writing across software, hardware and machine learning.";
const AUTHOR = process.env.SITE_AUTHOR || "";
// Absolute URL required: link-preview crawlers do not resolve relative paths,
// and most reject data: URIs and SVG. Emitted only when actually configured.
const OG_IMAGE = process.env.SITE_OG_IMAGE && ORIGIN
  ? (/^https?:/i.test(process.env.SITE_OG_IMAGE)
      ? process.env.SITE_OG_IMAGE
      : ORIGIN + "/" + String(process.env.SITE_OG_IMAGE).replace(/^\/+/, ""))
  : "";

// Two different escapes, because the inputs are in two different states.
// SITE_* come from the environment as raw text and need full escaping.
// `title` was lifted out of the source's <title>, so it is ALREADY escaped
// HTML — running it through esc() again turns &amp; into &amp;amp;. It only
// needs its quotes neutralised to be safe inside an attribute.
const esc = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const attr = s => String(s).replace(/"/g, "&quot;");
// A description containing "</script>" would otherwise close the JSON-LD block
// early and drop the rest of it into the document as markup.
const jsonSafe = o => JSON.stringify(o).replace(/</g, "\\u003c");

const jsonld = {
  "@context": "https://schema.org",
  "@graph": [
    Object.assign({
      "@type": "WebSite",
      name: SITE_NAME,
      description: SITE_DESC
    }, ORIGIN ? { url: ORIGIN } : {},
       AUTHOR ? { author: { "@type": "Person", name: AUTHOR } } : {}),
    ...(AUTHOR ? [Object.assign({ "@type": "Person", name: AUTHOR },
        ORIGIN ? { url: ORIGIN } : {})] : [])
  ]
};

const socialTags = [
  `<meta property="og:type" content="website">`,
  `<meta property="og:site_name" content="${esc(SITE_NAME)}">`,
  `<meta property="og:title" content="${attr(title)}">`,
  `<meta property="og:description" content="${esc(SITE_DESC)}">`,
  ORIGIN ? `<meta property="og:url" content="${esc(ORIGIN)}">` : "",
  OG_IMAGE ? `<meta property="og:image" content="${esc(OG_IMAGE)}">` : "",
  `<meta name="twitter:card" content="${OG_IMAGE ? "summary_large_image" : "summary"}">`,
  `<meta name="twitter:title" content="${attr(title)}">`,
  `<meta name="twitter:description" content="${esc(SITE_DESC)}">`,
  OG_IMAGE ? `<meta name="twitter:image" content="${esc(OG_IMAGE)}">` : ""
].filter(Boolean).join("\n");

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${esc(SITE_DESC)}">
${ORIGIN ? `<link rel="canonical" href="${esc(ORIGIN)}/">` : ""}
${socialTags}
<script type="application/ld+json">${jsonSafe(jsonld)}</script>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>&#128208;</text></svg>">
<style>
/* minimal reset — mirrors what the artifact host injects, so the self-hosted
   page and the published mockup render identically */
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
img, svg { max-width: 100%; }
</style>
${style}
</head>
<body>
${body}
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, doc);

const kb = (Buffer.byteLength(doc) / 1024).toFixed(1);
console.log(`  built  public/index.html  (${kb} kB)  "${title}"`);
if (!ORIGIN) {
  console.log("  note   PUBLIC_ORIGIN unset — no canonical, og:url or og:image emitted");
}
if (!OG_IMAGE) {
  console.log("  note   SITE_OG_IMAGE unset — link previews fall back to a text-only card");
}
