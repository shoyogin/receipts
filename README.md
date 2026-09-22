# Dataset browser

Review UI for YOLO dataset versions on a mounted disk.

| Page | What it is for |
|---|---|
| **Files** | Browse the folder tree and download it — a folder as a zip, a single file, or a whole version with the rejected images left out |
| **Review** | Every image with its boxes and class names: filter, mark OK or not OK, comment |
| **Fix** | The rejected images, with their boxes editable — redraw, reclassify, send for approval |
| **Stats** | Image / class / box counts and how the classes are distributed |

React + Vite + Tailwind in [`web/`](web/), served by a stdlib-only Python server
([`dataset_browser.py`](dataset_browser.py)) that also exposes the API.

## Running it

```bash
cd web && npm install && npm run build && cd ..     # once
python3 dataset_browser.py /path/to/datasets \
  --review /path/to/review --host 127.0.0.1 --port 8800
```

Open http://localhost:8800/.

Working on the UI? Run Vite instead of rebuilding each time — it proxies to the
Python server, so keep both up:

```bash
python3 dataset_browser.py /path/to/datasets --review /path/to/review --port 8800
cd web && npm run dev            # http://localhost:5173
```

## Dataset layout

```
<root>/<version>/images/<split>/*.jpg
<root>/<version>/labels/<split>/*.txt
<root>/<version>/classes.txt            # optional
```

A flat `images/*.jpg` with no split folders works too — it becomes the split `.`.

**Class names** come from `classes.txt` in the version folder, or in its
`labels/` folder, or one shared at the dataset root — first found wins.
`data.yaml` is read only when there is no `classes.txt` anywhere. One class per
line, with or without the index:

```
car          0 car        0: car
person       1 person     1, person
```

Blank lines and `#` comments are skipped. Indices are only believed when every
line carries one, so plain names that start with a digit stay intact. Stats says
which file the names came from.

## Versioning

Version folders are named by hand, and the prefix says how finished the dataset
is:

- **`tX.Y.Z`** — in progress (*test*)
- **`vX.Y.Z`** — finished (*version*)

The numbers move the same way under both prefixes:

| Bump | When |
|---|---|
| `t0.0.0` → `t1.0.0` | a dataset completely different from the ones before |
| `t0.0.0` → `t0.1.0` | images or classes added |
| `t0.0.0` → `t0.0.1` | corrections — missing labels, images to remove, resizes |

Versions are listed alphabetically, so every `t` sorts before every `v`.

## Reviewing

A verdict is **OK**, **not OK**, or **Review** — corrected and waiting to be
accepted (yellow). Keyboard: `1` OK, `2` not OK, `←` `→` move, `esc` close. An
OK jumps to the next image; a rejection stays put with the comment box focused.

**Comments** are a thread. Any image takes any number of them from any number of
reviewers, with or without a verdict, and a later verdict does not disturb them.
`⌘↵` / `ctrl↵` sends. **edit** rewords one of your own and **×** removes it; the
comment keeps its original author and place in the thread and is marked *edited*.
The card shows a bubble and a count, and *Show → Has comments* filters to them.

Verdicts and comments go to an append-only JSONL log per version/split under
`--review`, never into the dataset. Nothing is ever rewritten, so the history of
who said what is kept.

## Fixing

Everything marked not OK collects on the **Fix** tab, across every split of the
version. Open one and the boxes are editable: drag empty space to draw, drag
inside a box to move it, corners and edges to resize, `1`–`9` to set the class,
`⌫` to delete, `⌘Z` to undo.

Saving does not pass a verdict. It marks the image **Review** and it waits there
until somebody else accepts it on the Review tab — **nobody can accept their own
correction**. Marking it not OK again stays open to whoever fixed it, since that
only takes the image back out. *Revert to original* drops the correction and
returns the image to not OK.

Behind `--user-header` that rule is a real control. Without a proxy, names are
self-declared and it is a courtesy.

The dataset is mounted read-only and is never written to. A corrected label lives
in the review log and is substituted into the zip at download time, so the
corrected dataset exists only in the file you download.

## Downloading a cleaned version

*Download reviewed dataset* streams the version as a zip with the corrected
labels in place of the originals, and with every image still marked not OK or
Review — and its label file — left out. Two receipts travel inside:
`EXCLUDED.csv` for what was held back and why, and `CORRECTED.csv` for which
labels were redrawn and by whom. The dataset itself is untouched.

If any image has never been flagged at all, the download asks first and says how
many, rather than quietly shipping images nobody has looked at.

## Deployment (NUC, behind Caddy)

`compose.yaml` runs the app with no published ports; Caddy is the sole entrypoint
on the VPN address, doing `basic_auth` and setting `X-Remote-User`. With
`--user-header X-Remote-User` the reviewer name comes from the proxy and any
client-sent name is ignored.

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

Mounts: `/srv/data/datasets` → `/data/datasets` **ro**, `/srv/data/review` →
`/data/review` **rw**. Passwords are bcrypt hashes in the Caddyfile, one line per
reviewer:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'YOUR_PASSWORD'
```

> Never add `header_up -X-Remote-User` to the `reverse_proxy` block. Caddy
> applies header ops add, then set, then delete, so the deletion runs *after*
> the line that sets the identity and strips it again — every verdict and
> comment then lands under `unauthenticated`. The line that sets it is already a
> replace, so there is nothing to guard against.

If names stop arriving, the Review page says so in a red bar and the server
prints the same warning once to `docker compose logs browser`. Nothing is lost
when that happens, only unattributed, and anyone can clean up the orphans.

## API

Everything the UI does is a plain HTTP call, so scripts can use it too.

| Route | Returns |
|---|---|
| `GET /api/versions` | `{root, versions[], pillow}` |
| `GET /api/version?v=` | counts, class names, per-split class counts |
| `GET /api/items?v=&split=&mode=&cls=&clsmode=&offset=&limit=` | images with boxes and their review flag |
| `GET /api/tree?path=` | one directory listing, with breadcrumbs |
| `GET /api/review/meta` | statuses, whether the log is writable, proxy user |
| `GET /api/review/summary?v=` | `{ok, no, review, total, unflagged}` |
| `GET /api/review/rejects?v=` | every image held back from the export |
| `GET /api/queue?v=&status=` | images needing work, across every split |
| `GET /api/review/export?v=` | review log as CSV |
| `GET /api/refresh` | drop the scan and flag caches |
| `POST /api/flag` | `{v, split, image, status, reviewer}` |
| `POST /api/comment` | `{v, split, image, text, reviewer}` |
| `POST /api/labels` | `{v, split, image, boxes}` — redraw; sets the status to `review` |
| `POST /api/labels/revert` | `{v, split, image}` — drop the redraw, back to `no` |
| `POST /api/comment/delete` | `{v, split, image, id, reviewer}` — author only |
| `GET /img?v=&split=&n=&t=1` | full image, or a cached thumbnail |
| `GET /file?path=` | one file |
| `GET /download?path=&exclude=1` | streamed zip; `exclude=1` applies the review |

`mode` is `all｜unreviewed｜ok｜no｜review｜commented｜unlabeled｜empty`. `cls`
takes one class index or a comma list (`0,2,5`); `clsmode=any` (default) keeps images
holding at least one, `clsmode=all` only those holding every one. Each `POST`
answers with the image's whole flag, verdict and full thread.

Zips are streamed as the files are read, so a multi-gigabyte version starts
downloading immediately and is never staged in memory or on disk.

**Older logs** written by the previous UI used `ok｜fix｜drop`; `fix` and `drop`
read back as `no`, and the inline rejection `note` becomes the first comment in
that image's thread. Existing review work carries over untouched.
