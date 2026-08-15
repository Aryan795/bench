# Bench

Projects and writing, with an admin panel. Node + Express + MongoDB, one container.

```
src/site.html        the public site — single file, authored by hand
build.js             wraps it into public/index.html
public/admin.html    the admin panel
server/              db, auth, seed, API
```

## Why the site is one file

`src/site.html` is content-only — a `<title>`, a `<style>`, then markup. That is the
shape the published mockup needs, because its host supplies the document skeleton.
`build.js` supplies the equivalent skeleton for self-hosting. One source, two targets,
nothing to keep in sync.

The page tries `GET /api/site` on load and falls back to its embedded sample content if
nothing answers. So the same file works as a live site and as a standalone mockup, and
a backend outage degrades to sample content rather than a blank page.

## Run it locally

```bash
cp .env.example .env
openssl rand -hex 32          # paste into SESSION_SECRET
$EDITOR .env                  # also set MONGO_PASSWORD and ADMIN_PASSWORD

docker compose up -d --build
docker compose logs -f bench  # confirms the admin user was created
```

- Site — <http://127.0.0.1:4000>
- Admin — <http://127.0.0.1:4000/admin>

The first boot seeds the admin user and the sample content. Both are idempotent: they
only run against empty collections, so restarts never duplicate or overwrite real posts.

### Nothing is exposed

- **Mongo** has no `ports:` at all. It exists only on the compose network; nothing
  outside Docker can reach it.
- **Bench** publishes `127.0.0.1:4000:4000` — loopback only. Not your LAN, not the
  internet, just this machine. That single mapping has to exist or your own browser
  can't connect either.

To check what is actually listening:

```bash
docker compose ps
lsof -nP -iTCP -sTCP:LISTEN | grep 4000   # expect 127.0.0.1:4000, never *:4000
```

`SECURE_COOKIES=false` is the default because local access is plain HTTP. A `Secure`
cookie is dropped by the browser over `http://`, so leaving it true makes login fail
silently with nothing in the UI to explain why.

## Proxmox LXC

`deploy/bench-lxc.sh` builds an unprivileged Debian 12 container with Docker inside and
brings the stack up. Run it **on the Proxmox host, as root**:

```bash
# on the Proxmox host, as root:
apt-get install -y git
git clone https://github.com/<you>/bench.git /root/bench
cd /root/bench
./deploy/bench-lxc.sh
```

`.env` is gitignored and never enters the repo, so a clone carries no secrets. The script
generates a fresh `SESSION_SECRET`, Mongo password and admin password inside the container
on first run, and prints the admin password at the end.

It auto-picks the next free CTID and prints the admin password at the end. Override any
default via environment:

```bash
CTID=921 HOSTNAME=bench STORAGE=local-lvm BRIDGE=vmbr0 \
DISK_GB=8 RAM_MB=1024 CORES=2 ./deploy/bench-lxc.sh
```

Static IP instead of DHCP:

```bash
BRIDGE_IP=192.168.1.60/24 GATEWAY=192.168.1.1 ./deploy/bench-lxc.sh
```

The container is created with `features: nesting=1,keyctl=1` — **Docker will not run in an
unprivileged LXC without both.** The script sets them; if you build the container by hand,
you must add them yourself.

Inside the container Bench still binds `127.0.0.1:4000`, so it is not on your LAN until you
put something in front of it. Manage it with:

```bash
pct exec <CTID> -- bash -lc 'cd /opt/bench && docker compose ps'
pct exec <CTID> -- bash -lc 'cd /opt/bench && docker compose logs -f bench'
```

### Updating from GitHub

The installer pushes a tarball into `/opt/bench`, not a clone, so wire up the remote once:

```bash
pct exec <CTID> -- bash -lc '
  cd /opt/bench && git init -q -b main \
  && git remote add origin https://github.com/<you>/bench.git \
  && git fetch -q origin && git reset -q --hard origin/main'
```

`git reset --hard` will not touch `.env` — it is gitignored, so it stays put. After that,
every update is:

```bash
pct exec <CTID> -- bash -lc 'cd /opt/bench && git pull && docker compose up -d --build'
```

Volumes are named by the pinned compose project (`bench_*`), not by the directory, so
posts and uploads survive a rebuild.

### MongoDB and AVX

MongoDB 5.0+ requires the AVX CPU instruction, and an LXC inherits the host CPU. The
installer greps `/proc/cpuinfo`: with AVX it uses `mongo:7`; without, it falls back to
`mongo:4.4` (the last release that runs without AVX) so the deploy never silently
crash-loops. If your Proxmox node *has* AVX but the container doesn't see it, set the
node/VM CPU type to `host` and re-run. Override explicitly with `MONGO_IMAGE=...`.

### If you publish it later

Set `SECURE_COOKIES=true` and `TRUST_PROXY=1`, and put Caddy in front — leave the port
binding on loopback rather than changing it to `0.0.0.0`.

```caddy
bench.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

## Local development

Needs Node 20+ and a Mongo you can reach.

```bash
npm install
docker compose up -d mongo
export MONGO_URL='mongodb://bench:<password>@127.0.0.1:27017/?authSource=admin'
export SESSION_SECRET=$(openssl rand -hex 32)
export ADMIN_USER=admin ADMIN_PASSWORD='at-least-twelve-chars'
export SECURE_COOKIES=false

npm run build     # regenerate public/index.html after editing src/site.html
npm run dev
```

`mongo` has no published port in compose, so expose one temporarily if you want to
connect from the host.

## Writing

The admin panel has three tabs.

**Posts** — title, standfirst, Markdown body, cover image, linked project, draft or
published. Slug is derived from the title unless you set one. Read time is recomputed
from the body on every save, so it can't drift.

**Projects** — name, card headline, standfirst, Markdown body, domain, year, headline
metric, and spec rows. The *card headline* is the editorial sentence used in the grid; a
bare project name looks unfinished beside a two-line title, which is the raggedness this
layout punishes.

**Account** — change your password.

Drafts are invisible to the public API. Only `status: published` is ever served.

### The editor

The body is Markdown, with a toolbar over it. Storage stays plain Markdown, so posts
remain portable, diffable and readable without this app.

| Control | Does |
|---|---|
| H2 · H3 | Toggles a heading prefix on every line the selection touches |
| **B** · *I* | Wraps the selection, or inserts a placeholder and selects it |
| Link | `⌘K`. Wraps the selection and prompts for the URL |
| Lists · Quote | Toggle line prefixes across a multi-line selection |
| `` ` `` · ``` ``` ``` | Inline code, and a fenced block around the selection |
| — | Horizontal divider |
| Image | Upload from disk and insert at the cursor (multi-select works) |
| Library | Pick from everything already uploaded |
| Preview | Side-by-side live render, debounced, using the real server renderer |

`⌘B` / `⌘I` / `⌘K` work in the textarea. Live word count and read-time estimate sit on
the right of the toolbar.

**Three ways to add an image mid-post:** the Image button, drag a file onto the editor,
or paste one straight from the clipboard. All three upload and insert at the cursor.

The preview uses the same `marked` renderer the site does — it isn't a second
implementation that can drift.

### Images in the body

Every Markdown image becomes a `<figure>`, so a captioned image is the default rather
than a special case:

```markdown
![alt text](/uploads/x.jpg "The caption")
```

Width comes from a URL fragment, which stays invisible to any other Markdown renderer:

| Syntax | Width |
|---|---|
| `/uploads/x.jpg` | the reading measure (38rem) |
| `/uploads/x.jpg#wide` | 46rem, breaking out of the measure |
| `/uploads/x.jpg#full` | near full-bleed, up to 88rem |

Both wide forms collapse back to the column below 700px.

After inserting, the cursor is parked inside the caption quotes — a caption is one
keystroke away rather than something you forget.

### Uploads

Files go to the `bench-uploads` volume and are served from `/uploads`. Type is checked
against the mimetype and the stored filename is randomised — the client filename is never
used to build a path. Deleting takes a plain filename only; anything with a slash or `..`
is rejected, and the resolved path is re-checked against the upload directory.

Uploaded SVGs are served under a restrictive `Content-Security-Policy`, because an SVG is
a document and a crafted one would otherwise run script on this origin.

Deleting an image does **not** rewrite posts that reference it — they will show a broken
image. The confirm dialog says so.

### Plates

Projects with no cover image fall back to a hand-drawn SVG plate chosen by the **Plate**
field. The eight plates live in `src/site.html`; a project whose plate is unset and which
has no cover gets a deterministic generated lattice, so an image slot is never empty.

## API

Public, published content only:

```
GET  /api/site              { posts, projects } — what the site boots from
GET  /api/posts
GET  /api/posts/:slug
GET  /api/projects
GET  /api/projects/:slug
```

Auth and admin (session cookie required):

```
POST   /api/auth/login      { username, password }
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/admin/posts     includes drafts and raw Markdown
POST   /api/admin/posts
PUT    /api/admin/posts/:id
DELETE /api/admin/posts/:id
       …identical shape for /api/admin/projects

POST   /api/admin/upload    multipart, field name "image"
POST   /api/admin/preview   { bodyMd } -> { html }
POST   /api/admin/password  { current, next }
```

## Security notes

This code has had one adversarial audit (six lenses, findings verified before fixing).
Eight candidate issues were refuted by controls already present; four were fixed. Current
posture:

- Sessions are HMAC-signed cookies — `httpOnly`, `SameSite=Strict`, `Secure` in
  production — carrying a `sessionEpoch`. Changing the password or hitting **Sign out
  everywhere** bumps the epoch, which invalidates every outstanding cookie on its next
  request. No server-side session store, so an ordinary restart still keeps you signed in.
- CSRF has two layers: `SameSite=Strict`, plus a `Sec-Fetch-Site`/`Origin` gate on every
  state-changing admin route — so a *sibling* subdomain (same-site but different origin)
  can't drive the admin API. Set `PUBLIC_ORIGIN` to your real URL behind a proxy.
- Login reserves its rate-limit slot *before* the bcrypt compare, and concurrent bcrypt
  work is capped (`KDF_CONCURRENCY`, default 4) so a burst of guesses can't stall the
  single-threaded event loop. 8 attempts per IP per 15 min; in-memory, swept periodically.
  Move it to Redis before running more than one replica.
- `TRUST_PROXY` **fails closed to 0** — trusting `X-Forwarded-For` with no proxy in front
  would let a client spoof the throttle key. Set it to your real hop count behind a proxy.
- Signature comparison is constant-time; login runs a bcrypt compare even for a missing
  user, so timing doesn't reveal which usernames exist.
- Uploads: mimetype-checked, server-randomised filenames, a total-size budget
  (`UPLOAD_BUDGET_BYTES`) so no session can fill the volume that also holds the database,
  and a locked-down CSP + `nosniff` on `/uploads` so a crafted SVG can't run script. The
  delete route takes a plain filename only and re-checks the resolved path.
- `cover` fields are constrained server-side to `/uploads/<name>` — an external or
  `javascript:` URL is dropped, not stored.
- Markdown is rendered without HTML sanitising. Only the authenticated admin can author
  it, so the only person who can inject script is you. **Add a sanitiser before adding a
  second author.**
- Break-glass for a leaked cookie you can't reach with the button: rotate `SESSION_SECRET`
  and restart — that invalidates every session immediately.

## Backup

State lives in two volumes: `mongo-data` and `bench-uploads`.

```bash
docker compose exec -T mongo mongodump --archive --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" --authenticationDatabase admin > bench-$(date +%F).archive

docker run --rm -v bench_bench-uploads:/data -v "$PWD":/out alpine \
  tar czf /out/uploads-$(date +%F).tar.gz -C /data .
```

Restore with `mongorestore --archive < file`.
