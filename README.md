# Dataset browser

Review UI for YOLO dataset versions on a mounted disk. Three pages:

| Page | What it is for |
|---|---|
| **Files** | Browse the dataset folder tree and download it — any folder as a zip, any file on its own, or a whole version with the rejected images left out |
| **Review** | Look at every image with its boxes and class names, filter by class, mark each one OK or not OK, and talk it over in a comment thread |
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

## Class names

They come from a `classes.txt` in the version folder, or in its `labels/`
folder, or one shared at the dataset root — first one found wins, and
`data.yaml` is only read when there is no `classes.txt` anywhere. One class per
line, with or without the index:

```
car          0 car        0: car
person       1 person     1, person
```

Blank lines and `#` comments are skipped. The indices are only believed when
every line carries one, so a file of plain names that happen to start with a
digit is read as names. A class index a label file uses but the name file never
mentions still shows up, numbered. Stats says which file the names came from.

## Reviewing

A verdict is **OK** or **not OK**. Keyboard: `1` OK, `2` not OK, `←` `→` move,
`esc` close. An OK jumps to the next image; a rejection stays put with the
comment box focused.

**Comments** are a thread, not a field. Any image takes any number of them from
any number of reviewers, whether or not it has a verdict — so a question from
one person and the answer from the next both survive, and marking an image OK or
not OK later does not disturb what was written. `⌘↵` / `ctrl↵` sends; plain
`↵` is a newline. **edit** rewords one of your own in place and **×** removes
it — behind `--user-header` that is enforced against the proxy's identity, and
without it against the self-declared name, where it is a courtesy rather than a
control. Editing keeps the comment's original author and position in the thread
and marks it *edited*; the log keeps every version, so nothing is lost. Comments
filed under `unauthenticated` (see below) belong to nobody and anyone may clear
them. The card shows a bubble and a count, and *Show → Has comments* filters to
them.

Verdicts and comments go to one append-only JSONL log per version/split under
`--review`, never into the dataset. A verdict is the last one written; a comment
lives until its author tombstones it. Nothing is ever rewritten, so the whole
history of who said what is kept.

**Downloading a cleaned version**: *Download reviewed dataset* (on Review, or on
the version's folder in Files) streams the version as a zip with every image
marked not OK — and its label file — left out, plus an `EXCLUDED.csv` listing
what was dropped, by whom, and every comment left on it. Nothing is written to
the dataset: the new version exists only in the zip you downloaded.

## Deployment (NUC, behind Caddy)

Unchanged from before: `compose.yaml` runs the app with no published ports and
Caddy as the sole entrypoint on the VPN address, doing `basic_auth` and setting
`X-Remote-User`. With `--user-header X-Remote-User` the reviewer name comes from
the proxy and any client-sent name is ignored.

> **Do not add a `header_up -X-Remote-User` line** to the `reverse_proxy` block.
> It looks like hardening and is the opposite: Caddy applies header operations
> add, then set, then delete, so a deletion written *after* `header_up
> X-Remote-User {http.auth.user.id}` strips the value that line just wrote. The
> app then sees no identity and files everything under `unauthenticated`. The
> `header_up` is a *set*, so it already replaces anything the client sent —
> there is nothing left to guard against.

If names ever stop arriving, the UI says so in a red bar across the Review page
and the server prints the same warning once to its log — `docker compose logs
browser`. Work is never lost when this happens, only unattributed, and the
orphaned entries can be cleaned up by anyone once identity is flowing again.

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
| `POST /api/flag` | `{v, split, image, status, reviewer}` |
| `POST /api/comment` | `{v, split, image, text, reviewer}`; add `id` to reword that comment |
| `POST /api/comment/delete` | `{v, split, image, id, reviewer}` — author only |
| `GET /img?v=&split=&n=&t=1` | full image, or a cached thumbnail |
| `GET /file?path=` | one file |
| `GET /download?path=&exclude=1` | streamed zip; `exclude=1` drops rejected images |

Each `POST` answers with the image's whole flag — verdict plus the full thread
— so a client that missed someone else's comment catches up on its next write.

`mode` is `all｜unreviewed｜ok｜no｜commented｜unlabeled｜empty`. `cls` takes one
class index or a comma list (`0,2,5`); `clsmode=any` (default) keeps images
holding at least one of them, `clsmode=all` only those holding every one.

Zips are streamed with chunked transfer encoding as the files are read, so a
multi-gigabyte version starts downloading immediately and is never staged in
memory or on disk.

### Older review logs

Logs written by the previous UI used `ok｜fix｜drop`. Both `fix` and `drop` read
back as `no`, so existing review work on the NUC carries over untouched — the
original lines stay exactly as they were written.

Those logs also carried the rejection reason inline on the verdict, one `note`
per image with the last one winning. Each becomes the first comment in that
image's thread, in a single reserved slot — so an image re-saved three times
while somebody typed shows the one finished comment, not three drafts of it.
