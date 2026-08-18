# Bench

A self-hosted site for projects and writing, with an admin panel. Node + Express +
MongoDB, two containers, one `docker compose up`.

Built for people who make things in more than one discipline — software, hardware,
research — and want them to sit in a single coherent index rather than three
disconnected pages.

- **Editorial layout.** A black-and-white magazine grid, not a card template.
- **Markdown editor** with a toolbar, live split preview, drag-and-drop and
  paste-to-upload images, and an image library.
- **No photography required.** Projects without a cover fall back to hand-drawn SVG
  plates, so an image slot is never empty.
- **Loopback by default.** Nothing is published to your LAN or the internet until you
  deliberately put a proxy in front.
- **One-command Proxmox LXC installer**, including the unprivileged-container flags
  Docker needs.

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Writing](#writing)
- [Deploy to a Proxmox LXC](#deploy-to-a-proxmox-lxc)
- [Putting it on the internet](#putting-it-on-the-internet)
- [Updating](#updating)
- [Backup and restore](#backup-and-restore)
- [Development](#development)
- [How it is put together](#how-it-is-put-together)
- [API](#api)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Requirements

- Docker Engine 20.10+ with the Compose plugin (`docker compose`, not `docker-compose`)
- `openssl` for generating secrets — present on macOS and every mainstream Linux
- About 1 GB RAM and 3 GB disk

Nothing else. Node and MongoDB run inside the containers; you do not install them.

---

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/bench.git
cd bench
cp .env.example .env
```

Fill in the three blank values in `.env`:

```bash
# a 64-character signing key — the server refuses to start with anything shorter
openssl rand -hex 32

# a database password
openssl rand -base64 24 | tr -d '/+=' | head -c 24; echo

# and pick an admin password of at least 12 characters
```

Then bring it up:

```bash
docker compose up -d --build
docker compose logs -f bench
```

Wait for `content seeded 8 projects, 6 posts` in the logs, then open:

| | |
|---|---|
| Site | <http://127.0.0.1:4000> |
| Admin | <http://127.0.0.1:4000/admin> |

Log in with the `ADMIN_USER` / `ADMIN_PASSWORD` you set. The first boot seeds the admin
user and sample content; both steps are idempotent and only run against empty
collections, so restarts never duplicate or overwrite your work.

> **Set `MONGO_USER` and `MONGO_PASSWORD` before the first `up`.** Mongo only reads them
> when it initialises an empty data volume. Changing them later has no effect unless you
> delete the volume with `docker compose down -v`.

### What is exposed

Nothing, by design:

- **Mongo** has no `ports:` entry at all. It exists only on the Compose network.
- **Bench** publishes `127.0.0.1:4000:4000` — loopback only. Not your LAN, not the
  internet. That mapping must exist or your own browser cannot connect either.

Verify it yourself:

```bash
docker compose ps
lsof -nP -iTCP -sTCP:LISTEN | grep 4000    # expect 127.0.0.1:4000, never *:4000
```

---

## Configuration

Everything is set in `.env`. Only the first three have no default.

| Variable | Default | What it does |
|---|---|---|
| `SESSION_SECRET` | — | HMAC key for session cookies. Must be 32+ chars or the server exits. Rotating it invalidates every session immediately. |
| `MONGO_PASSWORD` | — | Database password. Read only on first init. |
| `ADMIN_PASSWORD` | — | Seeded on first boot, 12 char minimum. Change it in the admin panel afterwards. |
| `MONGO_USER` | `bench` | Database user. |
| `MONGO_DB` | `bench` | Database name. |
| `MONGO_IMAGE` | `mongo:7` | Set to `mongo:4.4` on a CPU without AVX. See [Troubleshooting](#troubleshooting). |
| `ADMIN_USER` | `admin` | Admin username. |
| `SECURE_COOKIES` | `false` | Set `true` the moment TLS is in front. Leaving it true over plain HTTP makes login fail silently — the browser drops the cookie. |
| `TRUST_PROXY` | `0` | Number of proxy hops. Set to your real hop count behind a reverse proxy so the rate-limiter sees real client IPs. |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:4000` | Your real URL behind a proxy. Admin requests from another origin are rejected as CSRF. |
| `UPLOAD_BUDGET_BYTES` | `536870912` | Ceiling on total uploaded bytes (512 MB). Uploads past it return 507. |
| `BIND_HOST` | `127.0.0.1` | Interface the Node process binds. Compose overrides this to `0.0.0.0` inside the container; the loopback *port mapping* is what restricts host access. |

---

## Writing

The admin panel has three tabs.

**Posts** — title, standfirst, Markdown body, cover image, linked project, draft or
published. The slug is derived from the title unless you set one. Read time is recomputed
from the body on every save, so it cannot drift.

**Projects** — name, card headline, standfirst, Markdown body, domain, year, headline
metric, and spec rows. The *card headline* is the editorial sentence used in the grid; a
bare project name looks unfinished beside a two-line title.

**Account** — change your password, or sign out of every device at once.

Drafts are invisible to the public API. Only `status: published` is ever served.

### Importing a Markdown file

Both editors have an **Import .md** link in the header, next to *Back to*. It takes a
file you already wrote and fills the editor in front of you — the post editor or the
project editor. Drop a file on the modal, or pick one.

Nothing is written until you press Save, so you can read it over first, or walk away and
it never existed. Importing into a draft that already has a title or body asks first.

Fields come from YAML front matter when it is there:

```markdown
---
title: The Only Honest Benchmark
dek: What a year of measuring the wrong thing taught me
slug: the-only-honest-benchmark
status: draft
category: Field notes
project: kettle
cover: /uploads/1a2b3c-plate.jpg
---

The body starts here.
```

Every key is optional, and **a key the file does not mention is left exactly as it is** —
an import into a half-written draft cannot blank the fields it says nothing about.

`title`, `dek`, `slug` and `status` work in both editors. The rest depend on which one is
open:

| Editor | Also reads |
|---|---|
| Post | `category`, `project`, `cover` |
| Project | `headline`, `domain`, `year`, `state`, `metric`, `metricKey`, `plate` |

Front matter keys are matched case-insensitively, so `metricKey` and `metrickey` are the
same key. A value that no dropdown accepts — `domain: software`, say — leaves that field
untouched rather than blanking it.

Without front matter the file is read the way most drafts are already written: the first
`# Heading` becomes the title, and a `##` or `###` line directly under it becomes the
standfirst. Both are removed from the body, because the site renders the title itself and
you would otherwise see it twice. If there is no heading at all, the filename becomes the
title.

The parser reads single-line `key: value` entries only. Lists and block scalars are
reported as unread rather than half-parsed, so a `tags:` block tells you it was skipped
instead of importing as empty.

After an import the modal lists what it filled in, and anything worth a second look:

- image paths that will not resolve, because a file written elsewhere usually points at
  something like `images/hero.jpg` — upload the images, then re-point the paths at
  `/uploads/`
- raw HTML that can execute (`<script>`, `<iframe>`, an `on…` handler). Markdown is
  rendered as-is, so this matters most for a file you did not write yourself
- a missing standfirst, or a title that had to fall back to the filename
- a front matter `date`, which is ignored — publishing stamps the date when the status
  becomes `published`

Files must be `.md`, `.markdown`, `.mdown`, `.mkd` or `.txt`, and at most 2 MB. They are
parsed in memory and never written to the image library.

### The editor

The body is Markdown and stays Markdown on disk, so your posts remain portable,
diffable, and readable without this app.

| Control | Does |
|---|---|
| H2 · H3 | Toggles a heading prefix on every line the selection touches |
| **B** · *I* | Wraps the selection, or inserts a placeholder and selects it |
| Link | `⌘K` / `Ctrl+K`. Wraps the selection and prompts for the URL |
| Lists · Quote | Toggle line prefixes across a multi-line selection |
| `` ` `` · ``` ``` ``` | Inline code, and a fenced block around the selection |
| — | Horizontal divider |
| Image | Upload from disk and insert at the cursor (multi-select works) |
| Library | Pick from everything already uploaded |
| Preview | Side-by-side live render, debounced, using the real server renderer |

`⌘B` / `⌘I` / `⌘K` work inside the textarea. A live word count and read-time estimate sit
at the right of the toolbar.

**Three ways to add an image mid-post:** the Image button, drag a file onto the editor, or
paste one from the clipboard. All three upload and insert at the cursor.

The preview calls the same `marked` renderer the site uses, so it is not a second
implementation that can drift from the real output.

### Images in the body

Every Markdown image becomes a `<figure>`, making a captioned image the default rather
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

Both wide forms collapse back into the column below 700px. After inserting, the cursor is
parked inside the caption quotes.

### Uploads

Files go to the `bench-uploads` volume and are served from `/uploads`. The type is checked
against the mimetype and the stored filename is randomised — the client filename is never
used to build a path. Deleting takes a plain filename only; anything containing a slash or
`..` is rejected, and the resolved path is re-checked against the upload directory.

Deleting an image does **not** rewrite posts that reference it — they will show a broken
image. The confirm dialog says so.

### Plates

Projects with no cover image fall back to a hand-drawn SVG plate chosen by the **Plate**
field. The eight plates live in `src/site.html`. A project with no plate and no cover gets
a deterministic generated lattice, so an image slot is never empty.

---

## Deploy to a Proxmox LXC

### One-line install

On the Proxmox host, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Aryan795/bench/main/deploy/install.sh)"
```

That asks which install type you want, offers Default or Advanced settings, downloads the
repo, and runs the matching installer below. It picks the next free CTID, finds your
storage, and prints the container IP and a generated admin password when it finishes.

Use that exact form rather than `curl ... | bash`. Piping puts the script itself on stdin,
so the menus have nothing to read your keystrokes from.

Every prompt has an environment variable behind it, and with no TTY the menus are skipped
entirely — so the same command works unattended from cron or Ansible:

```bash
INSTALL_TYPE=native CTID=922 DISK_GB=6 RAM_MB=1024 CT_HOSTNAME=bench \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/Aryan795/bench/main/deploy/install.sh)"
```

`install.sh` is only a front end. It does no work of its own beyond asking and fetching —
the two scripts below do the real installing and are perfectly usable on their own if you
would rather read exactly what runs before running it, which is the better habit with any
`curl`-to-root-shell one-liner.

### The two installers

Both create an unprivileged Debian 12 container and must run **on the Proxmox host, as
root** — they use `pct`, so they will not work anywhere else.

| | `bench-lxc.sh` (Docker) | `bench-lxc-native.sh` (no Docker) |
|---|---|---|
| Runs as | two containers under a Docker daemon | two systemd services |
| LXC features required | `nesting=1,keyctl=1` | **none** |
| Disk | ~3.8 GB | ~2.5 GB |
| RAM | ~275 MB | ~155 MB |
| Start / stop | `docker compose up -d` | `systemctl start bench` |
| Logs | `docker compose logs -f bench` | `journalctl -u bench -f` |
| Update | `git pull && docker compose up -d --build` | `git pull && npm ci && systemctl restart bench` |
| App isolation | separate container, UID 1001 | systemd sandboxing |
| Works without AVX | yes (`mongo:4.4` image) | **no** |
| Works on arm64 | yes | no (MongoDB ships Debian server packages for amd64 only) |

**Which to pick.** Native is lighter and keeps the container unprivileged with default
features — not needing `nesting=1` is the strongest argument for it, since that flag
widens the kernel surface exposed to the container. Docker gives you pinned image
versions, a one-command update, and a second isolation boundary around the app.

Runtime performance is the same either way — both are namespaces on the same kernel.

Use Docker if your CPU lacks AVX; the native path has no fallback there, because MongoDB
publishes `mongodb-org-server` 4.4 only for Debian 10 (buster), which is end-of-life. The
native installer detects this and refuses rather than building a container that
crash-loops.

### Docker path

`deploy/bench-lxc.sh` creates the container, installs Docker inside it, and brings the
stack up.

```bash
apt-get install -y git
git clone https://github.com/YOUR-USERNAME/bench.git /root/bench
cd /root/bench
./deploy/bench-lxc.sh
```

It auto-picks the next free CTID, generates every secret inside the container, and prints
the admin password at the end. `.env` is gitignored and never enters the repo, so a clone
carries no secrets.

Check your storage name first — the script defaults to `local-lvm`:

```bash
pvesm status
```

Override any default through the environment:

```bash
CTID=921 CT_HOSTNAME=bench STORAGE=local-zfs BRIDGE=vmbr0 \
DISK_GB=8 RAM_MB=1024 CORES=2 ./deploy/bench-lxc.sh
```

Static IP instead of DHCP:

```bash
BRIDGE_IP=192.168.1.60/24 GATEWAY=192.168.1.1 ./deploy/bench-lxc.sh
```

The container is created with `features: nesting=1,keyctl=1`. **Docker will not run in an
unprivileged LXC without both.** The script sets them; if you build a container by hand,
you must add them yourself.

Manage it afterwards:

```bash
pct exec <CTID> -- bash -lc 'cd /opt/bench && docker compose ps'
pct exec <CTID> -- bash -lc 'cd /opt/bench && docker compose logs -f bench'
```

### Native path

`deploy/bench-lxc-native.sh` installs Node and MongoDB into the container's own OS and
supervises them with systemd. No Docker anywhere.

```bash
apt-get install -y git
git clone https://github.com/YOUR-USERNAME/bench.git /root/bench
cd /root/bench
./deploy/bench-lxc-native.sh
```

Same environment overrides as the Docker script (`CTID`, `STORAGE`, `BRIDGE_IP`, …), with
`DISK_GB` defaulting to 6 instead of 8.

It creates the container **without** `--features`, installs Node from NodeSource and
MongoDB 7.0 from MongoDB's own apt repo, creates the database user and *then* enables
`authorization` (the reverse order locks you out), writes `/etc/bench.env` root-owned at
mode 600, and installs a sandboxed unit.

The sandboxing is the point — it replaces the boundary Docker was providing:

```ini
NoNewPrivileges=yes      ProtectSystem=strict     ProtectHome=yes
PrivateTmp=yes           PrivateDevices=yes       ProtectProc=invisible
ProtectKernelTunables=yes ProtectKernelModules=yes ProtectControlGroups=yes
RestrictNamespaces=yes   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=   SystemCallFilter=@system-service
```

`/opt/bench` is read-only to the service; `/var/lib/bench` (uploads) is the only writable
path. `MemoryDenyWriteExecute` is deliberately **not** set — V8 needs W+X to JIT, and
setting it stops Node starting at all.

Manage it with:

```bash
pct exec <CTID> -- systemctl status bench
pct exec <CTID> -- journalctl -u bench -f
pct exec <CTID> -- systemctl restart bench
```

Journald is capped at 200 MB, matching the Docker path's log limit.

### Disk sizing

`DISK_GB` defaults to 8, which is right for this stack. Measured steady state:

| Component | Size |
|---|---|
| Debian 12 rootfs | ~1.1 GB |
| docker-ce + containerd | ~500 MB |
| Images (`mongo:7` 828 MB + app 159 MB) | ~1.0 GB |
| Build cache after `--build` | 300–550 MB |
| Mongo data (floor) | ~300 MB |
| Uploads, capped by `UPLOAD_BUDGET_BYTES` | 0–512 MB |
| **Total** | **~3.8 GB** |

6 GB is the practical floor; below that a rebuild plus build cache will squeeze you.

Two things that catch people out:

- **MongoDB costs ~300 MB when empty.** That is WiredTiger preallocating journal files,
  not your content — the figure is the same for 6 posts or 600. Text is negligible
  beside it.
- **Container logs are unbounded by default.** Docker's `json-file` driver has no size
  limit, which on a box that runs for months is the likeliest thing to fill the disk.
  Both services are capped at 3 × 10 MB here via the `x-logging` anchor in
  `docker-compose.yml`.

On LVM-thin or ZFS the rootfs is thin-provisioned, so an oversized `DISK_GB` costs little
real space. Reclaim build cache any time with `docker builder prune` (~480 MB after a
rebuild). To shrink the worst case further, lower `UPLOAD_BUDGET_BYTES`.

### The admin login

Both installers create the admin user `admin` with a **randomly generated** password —
there is no fixed default, deliberately. It is printed once in the closing summary of the
install run. If you missed it, read it back from the container's env file (the path
differs between the two installers, so this checks both):

```bash
pct exec <CTID> -- sh -c \
  'grep -H -E "ADMIN_USER|ADMIN_PASSWORD" /opt/bench/.env /etc/bench.env 2>/dev/null'
```

Log in at `/admin` in a **browser** with those, then change the password from the
**Account** tab — once you do, the printed and stored value is worthless.

That `admin` account is a Bench login, **not** a Linux user. Typing it at the container's
`login:` console prompt will always fail — see below.

### A shell inside the container

The container is created with **no root password**, so the Proxmox web-UI *Console* button
(and `pct console`) lands on a `login:` prompt that nothing gets past — `admin` is the web
app, not the OS, and `root` has no password yet. Get in one of two ways, from the Proxmox
host:

```bash
pct enter <CTID>          # a root shell, no password needed — the quick way
```

To use the web-UI console or `pct console` instead, give `root` a password first, then log
in as `root` (never `admin`):

```bash
pct exec <CTID> -- passwd
```

### Reaching it from a browser

By default, inside the container Bench binds `127.0.0.1:4000`, so it is **not** on your
LAN. Browsing to the container's IP will fail — that is the intended behaviour, not a bug.

The installer's Advanced settings offer a "Who can reach it" choice, and both installers
take `BIND=loopback` (default) or `BIND=lan`. `BIND=lan` binds `0.0.0.0`, puts the admin
login on your network, and sets `PUBLIC_ORIGIN` to the container's address for you. It
stays opt-in because an installer should not quietly publish a login page to your LAN.

If you leave it on loopback, three ways to get to it:

**SSH tunnel** — opens nothing:

```bash
pct exec <CTID> -- bash -lc 'apt-get install -y openssh-server'
# then from your workstation:
ssh -N -L 4000:127.0.0.1:4000 root@<container-ip>
```

Browse `http://127.0.0.1:4000` locally. If SSH refuses the login, Debian's default
`PermitRootLogin prohibit-password` is why — install your public key instead.

**Publish to the LAN** — set `BIND_ADDR=0.0.0.0` in `/opt/bench/.env` (Docker) or
`BIND_HOST=0.0.0.0` in `/etc/bench.env` (native), set `PUBLIC_ORIGIN` to the container's
address, and restart. Now anyone on your LAN can reach it, over plain HTTP.

**Tailscale** — needs `/dev/net/tun` passed into the unprivileged container:

```bash
pct set <CTID> -o lxc.cgroup2.devices.allow="c 10:200 rwm" \
                -o lxc.mount.entry="/dev/net/tun dev/net/tun none bind,create=file"
```

Then `tailscale up` inside, and reach it over your tailnet with nothing exposed on the LAN.

---

## Putting it on the internet

Leave the port binding on loopback and put a reverse proxy (Caddy here) in front of it to
terminate TLS:

```caddy
bench.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Then set three values **in the same env file the installer wrote** — `/etc/bench.env` on a
native install, `/opt/bench/.env` on a Docker install:

```ini
SECURE_COOKIES=true
TRUST_PROXY=1
PUBLIC_ORIGIN=https://bench.example.com
```

and restart so they take effect:

```bash
systemctl restart bench                 # native install
cd /opt/bench && docker compose up -d   # Docker install
```

All three settings matter together: without `SECURE_COOKIES` the session cookie travels
in the clear, without `TRUST_PROXY` the rate-limiter counts every visitor as the proxy,
and without a correct `PUBLIC_ORIGIN` the CSRF gate will reject your own admin requests.
`TRUST_PROXY=1` means "trust one proxy hop" — raise it only if you chain more proxies.

---

## Updating

```bash
git pull
docker compose up -d --build
```

Volumes are named from the pinned Compose project (`bench_*`) rather than the directory
name, so posts and uploads survive a rebuild — and renaming or moving the folder does not
orphan your data.

On an LXC created by the installer, `/opt/bench` is a tarball rather than a clone. Wire up
the remote once:

```bash
pct exec <CTID> -- bash -lc '
  cd /opt/bench && git init -q -b main \
  && git remote add origin https://github.com/YOUR-USERNAME/bench.git \
  && git fetch -q origin && git reset -q --hard origin/main'
```

`git reset --hard` will not touch `.env`, since it is gitignored. After that:

```bash
pct exec <CTID> -- bash -lc 'cd /opt/bench && git pull && docker compose up -d --build'
```

---

## Backup and restore

State lives in two volumes: `bench_mongo-data` and `bench_bench-uploads`.

```bash
# database
docker compose exec -T mongo mongodump --archive --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" --authenticationDatabase admin > bench-$(date +%F).archive

# uploaded images
docker run --rm -v bench_bench-uploads:/data -v "$PWD":/out alpine \
  tar czf /out/uploads-$(date +%F).tar.gz -C /data .
```

Restore the database with:

```bash
docker compose exec -T mongo mongorestore --archive --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" --authenticationDatabase admin < bench-2026-01-01.archive
```

---

## Development

Needs Node 20+ and a MongoDB you can reach.

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

`mongo` has no published port in Compose, so add one temporarily if you want to connect
from the host.

**Always run `npm run build` after editing `src/site.html`.** `public/index.html` is
generated and gitignored; the Docker build runs the same step for you.

---

## How it is put together

```
src/site.html        the public site — a single hand-authored file
build.js             wraps it into public/index.html
public/admin.html    the admin panel
server/
  db.js              Mongo connection, indexes, slug helpers
  auth.js            sessions, bcrypt, login throttling
  seed.js            first-boot admin user and sample content
  server.js          the API
deploy/bench-lxc.sh  Proxmox LXC installer
```

### Why the site is one file

`src/site.html` is content-only — a `<title>`, a `<style>`, then markup. `build.js`
supplies the document skeleton for self-hosting. One source, two targets, nothing to keep
in sync by hand.

The page requests `GET /api/site` on load and falls back to embedded sample content if
nothing answers within 2.5 seconds. So the same file works as a live site *and* as a
standalone mockup you can open from disk — and a backend outage degrades to sample
content instead of a blank page.

---

## API

Public routes serve published content only:

```
GET  /api/site              { posts, projects } — what the site boots from
GET  /api/posts
GET  /api/posts/:slug
GET  /api/projects
GET  /api/projects/:slug
```

Auth and admin routes require a session cookie:

```
POST   /api/auth/login      { username, password }
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/admin/posts       includes drafts and raw Markdown
GET    /api/admin/posts/:id
POST   /api/admin/posts
PUT    /api/admin/posts/:id
DELETE /api/admin/posts/:id
       …identical shape for /api/admin/projects

GET    /api/admin/uploads     list the image library
POST   /api/admin/upload      multipart, field name "image"
DELETE /api/admin/uploads/:name

POST   /api/admin/import      multipart, field name "file" — parse .md into editor fields
POST   /api/admin/preview     { bodyMd } -> { html }
POST   /api/admin/password    { current, next }
POST   /api/admin/logout-all  bump the session epoch
```

Every state-changing admin route is behind the CSRF origin gate described under
[Security](#security).

---

## Security

This code has had one adversarial audit — six review lenses, with every finding
independently verified before it was fixed. Eight candidate issues were refuted by
controls already present; four were real and were fixed. Current posture:

- **Sessions** are HMAC-signed cookies (`httpOnly`, `SameSite=Strict`, `Secure` in
  production) carrying a `sessionEpoch`. Changing your password or hitting *Sign out
  everywhere* bumps the epoch, invalidating every outstanding cookie on its next request.
  There is no server-side session store, so an ordinary restart keeps you signed in.
- **CSRF** has two layers: `SameSite=Strict`, plus a `Sec-Fetch-Site`/`Origin` gate on
  every state-changing admin route. `SameSite` is scoped to the registrable domain, so a
  sibling subdomain counts as same-site — the Origin check is what stops it driving the
  admin API.
- **Login throttling** reserves its rate-limit slot *before* the bcrypt compare, so
  concurrent guesses cannot slip through the gap. Concurrent bcrypt work is capped
  (`KDF_CONCURRENCY`, default 4) because bcryptjs is pure JS on the event loop. 8 attempts
  per IP per 15 minutes, in memory, swept periodically. Move it to Redis before running
  more than one replica.
- **`TRUST_PROXY` fails closed to 0.** Trusting `X-Forwarded-For` with no proxy in front
  would let any client spoof the throttle key.
- **Baseline headers** on every response: `frame-ancestors 'none'` plus `X-Frame-Options:
  DENY` so the admin panel cannot be framed and clickjacked, `nosniff`, `no-referrer`,
  `base-uri 'none'`, `object-src 'none'`, and HSTS once `SECURE_COOKIES` is on. Script and
  style need `'unsafe-inline'` because the site and admin panel are deliberately single
  files.
- Signature comparison is constant-time, and login runs a bcrypt compare even for a
  missing user, so response timing does not reveal which usernames exist.
- **Uploads** are mimetype-checked with server-randomised filenames, bounded by a total
  size budget so no session can fill the volume that also holds the database, and served
  under a restrictive CSP with `nosniff` — an SVG is a document, and a crafted one would
  otherwise run script on this origin.
- `cover` fields are constrained server-side to `/uploads/<name>`; an external or
  `javascript:` URL is dropped rather than stored.
- **Break-glass:** rotate `SESSION_SECRET` and restart to invalidate every session
  everywhere, immediately.

---

## Troubleshooting

**Login does nothing, no error shown.** `SECURE_COOKIES=true` over plain HTTP. The browser
silently drops a `Secure` cookie on `http://`. Set it to `false` locally.

**Mongo crash-loops on an older CPU.** MongoDB 5.0+ requires the AVX instruction set. Set
`MONGO_IMAGE=mongo:4.4` in `.env` — the last release that runs without it. On Proxmox the
LXC inherits the host CPU, so the installer detects this and picks the image for you; if
your node *has* AVX but the container cannot see it, set the CPU type to `host`.

**`docker: command not found` inside a fresh LXC.** The container is missing
`nesting=1,keyctl=1`. Check with `pct config <CTID> | grep features`.

**Native install: `bench.service` fails with `status=226/NAMESPACE`.** systemd could not
set up the unit's filesystem sandbox (`ProtectSystem`, `PrivateTmp`, `PrivateDevices`, …) —
an unprivileged LXC is not allowed to create those mount namespaces, so `ExecStart` aborts
before Node runs. The installer now ships an LXC-safe unit; if an older install hits this,
disable those directives with `systemctl edit bench` (add `ProtectSystem=no`,
`PrivateTmp=no`, `PrivateDevices=no`, `ProtectHome=no`, `ProtectProc=default`,
`ReadWritePaths=`), then `systemctl daemon-reload && systemctl restart bench`.

**Changed `MONGO_PASSWORD` and now it will not connect.** Mongo only reads that variable
when initialising an empty volume. Either revert it, or `docker compose down -v` and start
over — which erases your posts.

**Site shows sample content that is not in the admin panel.** The page could not reach
`/api/site` and fell back to its embedded content. Check `docker compose logs bench`.

**`public/index.html` is missing.** Run `npm run build`.

---

## License

MIT — see [LICENSE](LICENSE).
