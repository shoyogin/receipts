# Dataset browser

Review UI for YOLO dataset versions on a mounted disk. Three pages:

| Page | What it is for |
|---|---|
| **Files** | Browse the dataset folder tree and download it — any folder as a zip, any file on its own, or a whole version with the rejected images left out |
| **Review** | Look at every image with its boxes and class names, filter by class, and mark each one OK or not OK |
| **Stats** | Image / class / box counts and pie charts of how the classes are distributed |

React + Vite + Tailwind front end in [`web/`](web/), served by a stdlib-only
Python server ([`dataset_browser.py`](dataset_browser.py)) that also exposes the API.

## Running it locally

The server needs a dataset root laid out as
`<root>/<version>/images/<split>/*.jpg` with matching `labels/<split>/*.txt`
(a flat `images/*.jpg` works too — that becomes the split `.`).

```bash
cd web && npm install && npm run build && cd ..     # once
python3 dataset_browser.py /path/to/datasets \
  --review /path/to/review --host 127.0.0.1 --port 8800
```

Open http://localhost:8800/.

**Working on the UI**: run Vite instead of rebuilding each time. It proxies
`/api`, `/img`, `/download` and `/file` to the Python server, so keep both up.

```bash
python3 dataset_browser.py /path/to/datasets --review /path/to/review --port 8800
cd web && npm run dev            # http://localhost:5173
```

## Reviewing

A verdict is **OK** or **not OK**; a rejection takes a comment saying why.
Keyboard: `1` OK, `2` not OK, `←` `→` move, `esc` close. An OK jumps to the
next image; a rejection stays put so you can type the comment.

Verdicts go to an append-only JSONL log per version/split under `--review`,
never into the dataset. The last record for an image wins, and the whole
history of who changed what is kept.

**Downloading a cleaned version**: *Download reviewed dataset* (on Review, or on
the version's folder in Files) streams the version as a zip with every image
marked not OK — and its label file — left out, plus an `EXCLUDED.csv` listing
what was dropped, by whom, and why. Nothing is written to the dataset: the new
version exists only in the zip you downloaded.

## Deployment (NUC, behind Caddy)

Unchanged from before: `compose.yaml` runs the app with no published ports and
Caddy as the sole entrypoint on the VPN address, doing `basic_auth` and setting
`X-Remote-User`. With `--user-header X-Remote-User` the reviewer name comes from
the proxy and any client-sent name is ignored.

```bash
docker compose build --build-arg DVC_GID=$(getent group dvc | cut -d: -f3)
docker compose up -d
```

The Dockerfile builds the React app in a `node:22-alpine` stage and copies only
`dist/` into the Python image, so node never ships to production.

Mounts: `/srv/data/datasets` → `/data/datasets` **ro**, `/srv/data/review` →
`/data/review` **rw**.

## Light and dark

The theme button in the header flips between them; **double-click it to hand
control back to the operating system**, which is where it starts (a dot on the
button means it is following the OS). The choice is stored per browser, and a
small script in `index.html` applies it before the first paint so a stored dark
choice never flashes white.

Both themes are one set of tokens in [`web/src/index.css`](web/src/index.css):
light is the base, and the dark block only redefines the same names. No
component carries a `dark:` variant — `bg-card`, `text-ink2`, `border-line` and
the rest simply resolve differently.

| Token | Light | Dark |
|---|---|---|
| page / surface / card | `#f9f9f7` `#fcfcfb` `#ffffff` | `#131312` `#1a1a19` `#1f1f1e` |
| ink / secondary / muted | `#0b0b0b` `#52514e` `#898781` | `#ffffff` `#c3c2b7` `#898781` |
| brand (links, focus) | `#2a78d6` | `#3987e5` |
| not OK | `#d03b3b` on white | `#e66767` on near-black |

Status fills carry their own ink token, because white on red works on paper but
the dark theme's lighter red needs dark ink (6.1:1) to stay legible.

The **class hues are tokens too** — see
[`web/src/lib/colors.js`](web/src/lib/colors.js), which returns
`var(--color-cls-N)` rather than a literal, so the palette follows the theme
with no React state involved. Both columns are validated for colour-blind
separation against their own surface (worst adjacent ΔE 9.1 light, 8.4 dark).
Colour follows the class index, never its rank.

> One Tailwind v4 trap worth knowing: `@theme` only emits variables that some
> utility class references. These are used from inline `style` via `var()`, so
> the block is declared `@theme static` — without it seven of the eight hues are
> dropped and the donuts render nearly transparent.

## API

Everything the UI does is a plain HTTP call, so scripts can use it too.

| Route | Returns |
|---|---|
| `GET /api/versions` | `{root, versions[], pillow}` |
| `GET /api/version?v=` | counts, class names, per-split class counts |
| `GET /api/items?v=&split=&mode=&cls=&clsmode=&offset=&limit=` | images with boxes and their review flag |
| `GET /api/tree?path=` | one directory listing, with breadcrumbs |
| `GET /api/review/meta` | statuses, whether the log is writable, proxy user |
| `GET /api/review/summary?v=` | `{ok, no}` |
| `GET /api/review/rejects?v=` | every image marked not OK, with comments |
| `GET /api/review/export?v=` | review log as CSV |
| `GET /api/refresh` | drop the scan and flag caches |
| `POST /api/flag` | `{v, split, image, status, note, reviewer}` |
| `GET /img?v=&split=&n=&t=1` | full image, or a cached thumbnail |
| `GET /file?path=` | one file |
| `GET /download?path=&exclude=1` | streamed zip; `exclude=1` drops rejected images |

`mode` is `all｜unreviewed｜ok｜no｜unlabeled｜empty`. `cls` takes one class index
or a comma list (`0,2,5`); `clsmode=any` (default) keeps images holding at least
one of them, `clsmode=all` only those holding every one.

Zips are streamed with chunked transfer encoding as the files are read, so a
multi-gigabyte version starts downloading immediately and is never staged in
memory or on disk.

### Older review logs

Logs written by the previous UI used `ok｜fix｜drop`. Both `fix` and `drop` read
back as `no`, so existing review work on the NUC carries over untouched — the
original lines stay exactly as they were written.
