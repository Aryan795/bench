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

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Bench — projects and writing across software, hardware and machine learning.">
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
