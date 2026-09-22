#!/usr/bin/env python3
"""
Dataset Browser — JSON API + static host for the React review UI.

Usage:
    python3 dataset_browser.py /srv/data/datasets --port 8800 --web web/dist

Expects:
    <root>/<version>/images/<split>/*.jpg
    <root>/<version>/labels/<split>/*.txt
    <root>/<version>/classes.txt        (optional, for class names)
    <root>/<version>/data.yaml          (optional, same, used if there is no
                                         classes.txt)

Review flags are written to a SEPARATE directory (--review), never into the
dataset. Each version/split gets an append-only JSONL log, so nothing is ever
overwritten and you keep the full history of who changed what.

A review verdict is "ok" or "no", and any image can carry a thread of comments
from any number of reviewers. Downloads can exclude every image marked "no",
which is how a cleaned-up version of the dataset is produced — the source tree
is never modified.

Dependencies: none (stdlib only). Pillow is used for thumbnails if present.
This server never writes to the dataset root. It opens files read-only.
"""

import argparse
import datetime
import io
import json
import mimetypes
import os
import re
import sys
import threading
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
THUMB_MAX = 420
ZIP_CHUNK = 512 * 1024

try:
    from PIL import Image, ImageOps

    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

ROOT = None
REVIEW = None
WEB = None
USER_HEADER = None   # e.g. "X-Remote-User", set by --user-header behind a proxy
CACHE_DIR = None
_scan_lock = threading.Lock()
_scan_cache = {}
_flag_lock = threading.Lock()
_flags = {}          # (version, split) -> {image: entry}

# A verdict is a keep/reject decision. "review" sits between the two: somebody
# redrew the boxes and the fix is waiting for a second pair of eyes. "fix" and
# "drop" are what older logs on the NUC wrote; both mean "not ok" and fold into
# "no" when read back.
STATUSES = ("ok", "no", "review")
LEGACY_STATUS = {"fix": "no", "drop": "no"}

# Reserved comment id for the single inline note older logs wrote on the verdict.
NOTE_ID = "note"
COMMENT_MAX = 2000

# What gets written when --user-header is set but the proxy sent no identity.
# Those comments belong to nobody, so anyone may edit or delete them — the
# alternative is a thread of orphans that no reviewer can ever clean up.
UNOWNED = "unauthenticated"
_warned_no_identity = False

# The dataset is mounted read-only and this server never writes to it, so a
# corrected label file lives in the review log and is substituted into the zip
# at download time. One image's worth; a dense frame is a few KB.
BOXES_MAX = 1000
MIN_SIDE = 0.002     # a box thinner than this is a slipped click, not a label

# Every route that accepts a body, and how much of one. A relabel carries a
# whole image's geometry; a verdict carries a word. They do not need the same
# ceiling, and one generous limit everywhere would only widen the others.
POST_MAX = {
    "/api/flag": 64_000,
    "/api/comment": 64_000,
    "/api/comment/delete": 64_000,
    "/api/labels": 512_000,
    "/api/labels/revert": 64_000,
}


def now_iso():
    # Milliseconds, so two comments typed in the same second still sort right.
    return datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")


# ---------------------------------------------------------------- filesystem

def safe_under_root(p: Path) -> Path:
    """Resolve p and refuse anything outside ROOT. Blocks ../ traversal."""
    rp = (ROOT / p).resolve() if not p.is_absolute() else p.resolve()
    if rp != ROOT and ROOT not in rp.parents:
        raise PermissionError(f"path escapes root: {p}")
    return rp


def rel_path(raw: str) -> Path:
    """A client-supplied path, stripped of anything that could escape ROOT."""
    parts = [seg for seg in unquote(raw or "").replace("\\", "/").split("/")
             if seg not in ("", ".", "..")]
    return Path(*parts) if parts else Path(".")


def list_versions():
    out = []
    for d in sorted(ROOT.iterdir(), key=lambda x: x.name):
        if d.is_dir() and not d.name.startswith("."):
            if (d / "images").is_dir():
                out.append(d.name)
    return out


def list_splits(version: str):
    imgdir = safe_under_root(Path(version) / "images")
    if not imgdir.is_dir():
        return []
    subs = [d.name for d in sorted(imgdir.iterdir()) if d.is_dir()]
    # Flat layout: images/*.jpg with no train/val/test subfolders
    if not subs and any(f.suffix.lower() in IMAGE_EXT for f in imgdir.iterdir()):
        return ["."]
    return subs


def parse_classes_txt(text: str):
    """One class per line. Accepts bare names and index-prefixed names.

        car              0 car            0: car
        person           1 person         1, person

    Blank lines and # comments are skipped. The indices are only believed when
    every line carries one — a half-indexed file is far more likely to be plain
    names that happen to start with a digit, and reading those as indices would
    scramble the whole list.
    """
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(\d+)[\s:,]+(.+)$", line)
        idx = int(m.group(1)) if m else None
        # Two readings of "747 jet": index 747 named "jet", or a class actually
        # called "747 jet". Keep both until the whole file says which it is.
        rows.append((idx, m.group(2).strip().strip("'\"") if m else "",
                     line.strip("'\"")))
    if not rows:
        return []
    if all(i is not None for i, _, _ in rows):
        indexed = {i: n for i, n, _ in rows}
        return [indexed.get(i, str(i)) for i in range(max(indexed) + 1)]
    return [raw for _, _, raw in rows]


def parse_data_yaml(text: str):
    """Tolerant data.yaml reader. Handles inline lists, block lists and index maps."""
    m = re.search(r"^names:\s*\[(.*?)\]", text, re.M | re.S)
    if m:
        return [s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip()]

    m = re.search(r"^names:\s*$", text, re.M)
    if m:
        names, indexed = [], {}
        for line in text[m.end():].splitlines():
            if not line.strip():
                continue
            if re.match(r"^\s*-\s+", line):
                names.append(line.split("-", 1)[1].strip().strip("'\""))
            elif re.match(r"^\s+\d+\s*:", line):
                k, v = line.split(":", 1)
                indexed[int(k.strip())] = v.strip().strip("'\"")
            elif not line.startswith((" ", "\t")):
                break
        if indexed:
            return [indexed.get(i, str(i)) for i in range(max(indexed) + 1)]
        return names
    return []


# Where class names come from, best first. classes.txt wins over data.yaml —
# it is what the labelling tools write and what people edit by hand, so when
# the two disagree it is the one that matches the label files. A copy at the
# dataset root covers every version that does not carry its own.
CLASS_SOURCES = (
    ("classes.txt", parse_classes_txt, True),
    ("labels/classes.txt", parse_classes_txt, True),
    ("data.yaml", parse_data_yaml, True),
    ("data.yml", parse_data_yaml, True),
    ("dataset.yaml", parse_data_yaml, True),
    ("classes.txt", parse_classes_txt, False),   # shared, at the dataset root
)


def read_classes(version: str):
    """(names, where they came from). Empty list and "" when nothing is found."""
    for name, parse, in_version in CLASS_SOURCES:
        rel = Path(version) / name if in_version else Path(name)
        try:
            f = safe_under_root(rel)
            if not f.is_file():
                continue
            names = parse(f.read_text(encoding="utf-8", errors="replace"))
        except (OSError, PermissionError):
            continue
        if names:
            return names, str(rel).replace("\\", "/")
    return [], ""


def label_file(version: str, split: str, image: str) -> Path:
    """The label file the dataset itself holds for one image. It need not exist."""
    sub = Path(version) / "labels"
    return safe_under_root(sub / split / image if split != "." else sub / image
                           ).with_suffix(".txt")


def parse_label(path: Path):
    """Return list of [cls, xc, yc, w, h] from a YOLO txt. Ignores malformed lines."""
    boxes = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 5:
                    continue
                try:
                    c = int(float(parts[0]))
                    v = [float(x) for x in parts[1:5]]
                except ValueError:
                    continue
                boxes.append([c] + v)
    except OSError:
        pass
    return boxes


def image_size(path: Path):
    """(w, h) from the file header only. None without Pillow."""
    if not HAVE_PIL:
        return None
    try:
        with Image.open(path) as im:
            w, h = im.size
            if (getattr(im, "getexif", None) and
                    im.getexif().get(274, 1) in (5, 6, 7, 8)):
                w, h = h, w          # EXIF rotation swaps the axes
            return [w, h]
    except Exception:
        return None


def scan(version: str, split: str):
    """Build (and cache) the item list for one version/split."""
    key = (version, split)
    with _scan_lock:
        if key in _scan_cache:
            return _scan_cache[key]

    sub = Path(version) / "images" / split if split != "." else Path(version) / "images"
    imgdir = safe_under_root(sub)
    lblsub = Path(version) / "labels" / split if split != "." else Path(version) / "labels"
    lbldir = safe_under_root(lblsub)

    items = []
    if imgdir.is_dir():
        for f in sorted(imgdir.iterdir(), key=lambda x: x.name):
            if f.suffix.lower() not in IMAGE_EXT or f.name.startswith("."):
                continue
            lf = lbldir / (f.stem + ".txt")
            has_label = lf.is_file()
            boxes = parse_label(lf) if has_label else []
            items.append({
                "name": f.name,
                "boxes": boxes,
                "labeled": has_label,
                "size": f.stat().st_size,
                "dim": image_size(f),
            })

    with _scan_lock:
        _scan_cache[key] = items
    return items


def stats_for(version: str):
    classes, class_source = read_classes(version)
    splits, total, unlabeled, empty, counts = {}, 0, 0, 0, {}
    split_counts = {}
    for sp in list_splits(version):
        items = scan(version, sp)
        # Count what the version would export, not what is on disk: an image
        # whose boxes were redrawn is counted as redrawn.
        flags = load_flags(version, sp)
        splits[sp] = len(items)
        total += len(items)
        per = {}
        for it in items:
            entry = flags.get(it["name"])
            boxes = merged_boxes(it, entry)
            fixed = entry is not None and entry["boxes"] is not None
            if not it["labeled"] and not fixed:
                unlabeled += 1
            elif not boxes:
                empty += 1
            for b in boxes:
                counts[b[0]] = counts.get(b[0], 0) + 1
                per[b[0]] = per.get(b[0], 0) + 1
        split_counts[sp] = per
    # A label file can reference an index the name file never mentions. Pad
    # rather than drop it, so a stray class still shows up and stays filterable.
    ncls = max([len(classes)] + [k + 1 for k in counts]) if (classes or counts) else 0
    names = list(classes) + [str(i) for i in range(len(classes), ncls)]
    return {
        "version": version,
        "classes": names,
        "class_source": class_source,
        "splits": splits,
        "total": total,
        "unlabeled": unlabeled,
        "empty": empty,
        "class_counts": counts,
        "split_class_counts": split_counts,
    }


def thumbnail(path: Path):
    """Return (bytes, mime). Falls back to the original file without Pillow."""
    if not HAVE_PIL:
        return path.read_bytes(), mimetypes.guess_type(path.name)[0] or "image/jpeg"
    st = path.stat()
    tag = f"{path}|{st.st_mtime_ns}|{st.st_size}|{THUMB_MAX}"
    cf = CACHE_DIR / (str(abs(hash(tag))) + ".jpg")
    if cf.is_file():
        return cf.read_bytes(), "image/jpeg"
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=82)
        data = buf.getvalue()
        try:
            cf.write_bytes(data)
        except OSError:
            pass
        return data, "image/jpeg"
    except Exception:
        return path.read_bytes(), mimetypes.guess_type(path.name)[0] or "image/jpeg"


# ------------------------------------------------------------------- review

def review_path(version: str, split: str) -> Path:
    """Sidecar log location. Kept outside ROOT so the dataset stays read-only."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", f"{version}__{split}")
    return REVIEW / f"{safe}.jsonl"


def blank_entry():
    """What the log replays into: a verdict, a thread of comments, and the
    corrected boxes if anyone has redrawn them. `boxes` None means nobody has —
    the label file on disk still speaks for the image."""
    return {"status": "", "reviewer": "", "ts": "", "comments": {},
            "boxes": None, "boxes_by": "", "boxes_ts": ""}


def replay(entry, rec):
    """Fold one log line into an image's entry. Called in file order."""
    if rec.get("kind") == "labels":
        boxes = rec.get("boxes")
        # A null reverts to the dataset's own file rather than erasing history:
        # the line that drew them is still in the log above this one.
        entry["boxes"] = None if boxes is None else [list(b) for b in boxes]
        entry["boxes_by"] = "" if boxes is None else rec.get("reviewer", "")
        entry["boxes_ts"] = "" if boxes is None else rec.get("ts", "")
        return

    if rec.get("kind") == "comment":
        cid = rec.get("id")
        if not cid:
            return
        if rec.get("deleted"):
            entry["comments"].pop(cid, None)
        else:
            # An id already in the thread means an edit. Keep the original
            # author and time — a reworded comment is the same comment, and
            # re-dating it would shuffle the thread out from under whoever is
            # reading it — and remember that it was changed.
            was = entry["comments"].get(cid)
            entry["comments"][cid] = {
                "id": cid,
                "text": rec.get("text", ""),
                "reviewer": was["reviewer"] if was else rec.get("reviewer", ""),
                "ts": was["ts"] if was else rec.get("ts", ""),
                "edited": rec.get("ts", "") if was else "",
            }
        return

    st = rec.get("status", "")
    entry["status"] = LEGACY_STATUS.get(st, st)
    entry["reviewer"] = rec.get("reviewer", "")
    entry["ts"] = rec.get("ts", "")

    # Logs written before threads existed carried the reason inline on the
    # verdict: one note per image, the last one winning. Give it a reserved
    # slot in the thread so re-saves of a note being typed collapse into the
    # single comment they always were, instead of stacking up as drafts.
    # Verdicts written since carry no "note" key at all and leave the thread be.
    if "note" in rec:
        note = rec.get("note") or ""
        if note:
            entry["comments"][NOTE_ID] = {"id": NOTE_ID, "text": note,
                                          "reviewer": rec.get("reviewer", ""),
                                          "ts": rec.get("ts", ""), "edited": ""}
        else:
            entry["comments"].pop(NOTE_ID, None)


def load_flags(version: str, split: str):
    """Replay the append-only log into {image: entry}."""
    key = (version, split)
    with _flag_lock:
        if key in _flags:
            return _flags[key]
    latest, f = {}, review_path(version, split)
    if f.is_file():
        try:
            with open(f, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue          # tolerate a torn final line
                    img = rec.get("image")
                    if img:
                        replay(latest.setdefault(img, blank_entry()), rec)
        except OSError:
            pass
    with _flag_lock:
        _flags[key] = latest
    return latest


def thread(entry):
    """An image's comments, oldest first."""
    return sorted(entry["comments"].values(), key=lambda c: (c["ts"], c["id"]))


def flag_view(entry):
    """The shape the API hands out. Never the internal entry: its comments are
    a dict keyed by id, which is replay bookkeeping the client has no use for.

    `corrected_by` is what the four-eyes rule turns on, so the client can grey
    out the accept button for the person who drew them and name whoever else
    the image is waiting on."""
    return {"status": entry["status"], "reviewer": entry["reviewer"],
            "ts": entry["ts"], "comments": thread(entry),
            "corrected": entry["boxes"] is not None,
            "corrected_by": entry["boxes_by"], "corrected_ts": entry["boxes_ts"]}


def flag_of(version, split, image):
    return flag_view(load_flags(version, split).get(image) or blank_entry())


def merged_boxes(item, entry):
    """The boxes that count for one image: a reviewer's redraw if there is one,
    otherwise what the label file on disk says. The single place corrections
    are applied, so the grid, the stats and the download cannot disagree."""
    if entry is not None and entry["boxes"] is not None:
        return entry["boxes"]
    return item["boxes"]


def label_text(boxes):
    """Boxes back out as a YOLO label file."""
    return "".join(f"{int(b[0])} {b[1]:.6f} {b[2]:.6f} {b[3]:.6f} {b[4]:.6f}\n"
                   for b in boxes)


def merged_item(item, entry):
    """One scanned image with its review state folded in, as the API hands it
    out. A corrected image reports the boxes it will actually ship with."""
    boxes = merged_boxes(item, entry)
    return dict(item, boxes=boxes,
                labeled=item["labeled"] or (entry is not None
                                            and entry["boxes"] is not None),
                flag=flag_view(entry) if entry is not None else None)


def comment_digest(entry):
    """Every comment on one image, flattened into a single CSV cell. Authors are
    spelled out per comment: the row's own reviewer column is the person who
    passed the verdict, which need not be the person who explained it."""
    return " | ".join(f"{c['reviewer'] or 'anon'}: {c['text']}" for c in thread(entry))


def append_record(version, split, rec):
    """Append one line to the log and fold it into the cache."""
    REVIEW.mkdir(parents=True, exist_ok=True)
    line = json.dumps(rec, ensure_ascii=False) + "\n"
    with _flag_lock:
        # O_APPEND keeps concurrent reviewers from clobbering each other
        with open(review_path(version, split), "a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
        # Only touch a split already in the cache. Seeding it here would leave
        # a one-record dict standing in for a log full of earlier verdicts.
        cached = _flags.get((version, split))
        if cached is not None:
            replay(cached.setdefault(rec["image"], blank_entry()), rec)
    return rec


def append_flag(version, split, image, status, reviewer):
    if status not in STATUSES + ("",):
        raise ValueError("bad status")
    if status == "ok":
        # Four eyes: nobody signs off their own redraw. Marking it "no" stays
        # open to them — that withdraws a fix, which only ever takes an image
        # out of the export, and refusing it would strand their own mistake.
        entry = load_flags(version, split).get(image)
        drew = entry["boxes_by"] if entry and entry["boxes"] is not None else ""
        if drew and drew == (reviewer or "anon"):
            raise PermissionError(
                "you corrected this image — someone else has to accept it")
    return append_record(version, split, {
        "kind": "status",
        "ts": now_iso(),
        "image": image,
        "status": status,
        "reviewer": (reviewer or "anon")[:64],
    })


def owned_comment(version, split, image, cid, reviewer):
    """The comment cid, if reviewer is allowed to change it."""
    entry = load_flags(version, split).get(image)
    existing = entry["comments"].get(cid) if entry else None
    if not existing:
        raise FileNotFoundError("unknown comment")
    author = existing["reviewer"] or "anon"
    if author != UNOWNED and author != (reviewer or "anon"):
        raise PermissionError("not your comment")
    return existing


def clean_boxes(raw):
    """Validate client-drawn boxes into [cls, xc, yc, w, h] rows.

    This ends up as a label file inside somebody's download, so it is checked
    rather than trusted: finite numbers, a real class index, and a box that
    actually lies on the image."""
    if not isinstance(raw, list):
        raise ValueError("boxes must be a list")
    if len(raw) > BOXES_MAX:
        raise ValueError(f"too many boxes (max {BOXES_MAX})")
    out = []
    for b in raw:
        if not isinstance(b, (list, tuple)) or len(b) != 5:
            raise ValueError("each box is [class, x, y, w, h]")
        try:
            c = int(b[0])
            x, y, w, h = (float(v) for v in b[1:])
        except (TypeError, ValueError):
            raise ValueError("box values must be numbers") from None
        if not all(v == v and abs(v) != float("inf") for v in (x, y, w, h)):
            raise ValueError("box values must be finite")
        if not 0 <= c <= 9999:
            raise ValueError("class index out of range")
        # Clamp to the frame rather than rejecting: a drag that ran off the
        # edge of the image is a normal gesture, not a bad request.
        w, h = min(max(w, MIN_SIDE), 1.0), min(max(h, MIN_SIDE), 1.0)
        x, y = min(max(x, w / 2), 1 - w / 2), min(max(y, h / 2), 1 - h / 2)
        out.append([c, round(x, 6), round(y, 6), round(w, 6), round(h, 6)])
    return out


def append_labels(version, split, image, boxes, reviewer):
    """Store a redraw, then flip the image to "review" waiting for a second
    opinion. Boxes first: a crash between the two lines leaves a correction
    nobody has claimed, never a "review" with nothing behind it."""
    who = (reviewer or "anon")[:64]
    append_record(version, split, {
        "kind": "labels",
        "ts": now_iso(),
        "image": image,
        "boxes": clean_boxes(boxes),
        "reviewer": who,
    })
    return append_flag(version, split, image, "review", who)


def revert_labels(version, split, image, reviewer):
    """Drop a correction and send the image back to where it came from."""
    entry = load_flags(version, split).get(image)
    if not entry or entry["boxes"] is None:
        raise FileNotFoundError("nothing to revert")
    who = (reviewer or "anon")[:64]
    append_record(version, split, {
        "kind": "labels",
        "ts": now_iso(),
        "image": image,
        "boxes": None,
        "reviewer": who,
    })
    # Back to "not OK": that is the state it was in before anyone fixed it, and
    # leaving it in "review" would queue an approval with no redraw to approve.
    return append_flag(version, split, image, "no", who)


def append_comment(version, split, image, text, reviewer, cid=None):
    """Write a comment. With cid, reword the one already under that id."""
    text = (text or "").strip()
    if not text:
        raise ValueError("empty comment")
    if cid:
        owned_comment(version, split, image, cid, reviewer)
    return append_record(version, split, {
        "kind": "comment",
        "id": cid or uuid.uuid4().hex[:12],
        "ts": now_iso(),
        "image": image,
        "text": text[:COMMENT_MAX],
        "reviewer": (reviewer or "anon")[:64],
    })


def delete_comment(version, split, image, cid, reviewer):
    """Tombstone one comment. The log keeps both the comment and its removal."""
    owned_comment(version, split, image, cid, reviewer)
    return append_record(version, split, {
        "kind": "comment",
        "id": cid,
        "ts": now_iso(),
        "image": image,
        "deleted": True,
        "reviewer": (reviewer or "anon")[:64],
    })


# What an export leaves behind: rejects, and fixes still waiting on a second
# pair of eyes. An approved fix is "ok" by then and ships like anything else.
HELD_BACK = ("no", "review")


def rejected(version: str, statuses=HELD_BACK):
    """{split: {image: entry}} for every image the export holds back."""
    out = {}
    for sp in list_splits(version):
        bad = {img: r for img, r in load_flags(version, sp).items()
               if r.get("status") in statuses}
        if bad:
            out[sp] = bad
    return out


def corrected(version: str):
    """{split: {image: entry}} for every redraw that ships — accepted fixes."""
    out = {}
    for sp in list_splits(version):
        fixed = {img: r for img, r in load_flags(version, sp).items()
                 if r["boxes"] is not None and r.get("status") not in HELD_BACK}
        if fixed:
            out[sp] = fixed
    return out


def csv_cell(v):
    v = "" if v is None else str(v)
    return '"' + v.replace('"', '""') + '"' if any(c in v for c in ',"\n') else v


def review_csv(version):
    rows = ["version,split,image,status,reviewer,timestamp,comments"]
    for sp in list_splits(version):
        for img, r in sorted(load_flags(version, sp).items()):
            # A comment with no verdict still belongs in the export: somebody
            # wrote down something about that image.
            if not r.get("status") and not r["comments"]:
                continue
            rows.append(",".join(csv_cell(x) for x in (
                version, sp, img, r.get("status", ""),
                r.get("reviewer", ""), r.get("ts", ""), comment_digest(r))))
    return "\n".join(rows) + "\n"


# -------------------------------------------------------------------- files

def tree(rel: Path):
    """One directory listing: folders first, then files, with sizes."""
    d = safe_under_root(rel)
    if not d.is_dir():
        raise FileNotFoundError(rel)
    dirs, files = [], []
    for e in sorted(d.iterdir(), key=lambda x: x.name.lower()):
        if e.name.startswith("."):
            continue
        try:
            if e.is_dir():
                dirs.append({"name": e.name, "type": "dir",
                             "items": sum(1 for _ in e.iterdir())})
            else:
                st = e.stat()
                files.append({"name": e.name, "type": "file", "size": st.st_size,
                              "mtime": int(st.st_mtime),
                              "image": e.suffix.lower() in IMAGE_EXT})
        except OSError:
            continue
    parts = [] if str(rel) == "." else list(rel.parts)
    return {
        "path": "" if str(rel) == "." else str(rel).replace("\\", "/"),
        "crumbs": [{"name": p, "path": "/".join(parts[:i + 1])}
                   for i, p in enumerate(parts)],
        "entries": dirs + files,
        "dirs": len(dirs),
        "files": len(files),
        "bytes": sum(f["size"] for f in files),
    }


def walk_files(base: Path):
    """Every file under base, as (absolute path, path relative to base)."""
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            p = Path(dirpath) / name
            yield p, p.relative_to(base)


class ChunkedWriter:
    """Write-only file object that frames every write as one HTTP chunk.

    zipfile sees no seek()/tell() and switches to streaming mode, so a
    multi-gigabyte version is never built in memory or staged on disk.
    """

    def __init__(self, wfile):
        self.wfile = wfile
        self.count = 0

    def write(self, data):
        if not data:
            return 0
        self.wfile.write(b"%X\r\n" % len(data))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.count += len(data)
        return len(data)

    def flush(self):
        try:
            self.wfile.flush()
        except OSError:
            pass

    def close(self):
        self.wfile.write(b"0\r\n\r\n")
        self.flush()


def zip_into(writer, base: Path, arc_root: str, skip=None, extra=None):
    """Stream base/ into writer as a zip. skip(relative_path) drops a file."""
    with zipfile.ZipFile(writer, "w", allowZip64=True) as z:
        for src, rel in walk_files(base):
            if skip and skip(rel):
                continue
            arc = str(Path(arc_root) / rel).replace("\\", "/")
            info = zipfile.ZipInfo.from_file(src, arc)
            # JPEG/PNG are already compressed; deflating them burns CPU for ~0%.
            info.compress_type = (zipfile.ZIP_STORED
                                  if src.suffix.lower() in IMAGE_EXT
                                  else zipfile.ZIP_DEFLATED)
            try:
                with z.open(info, "w") as dst, open(src, "rb") as fh:
                    while True:
                        buf = fh.read(ZIP_CHUNK)
                        if not buf:
                            break
                        dst.write(buf)
            except OSError:
                continue
        for name, text in (extra or {}).items():
            z.writestr(str(Path(arc_root) / name).replace("\\", "/"), text,
                       zipfile.ZIP_DEFLATED)


def built_line():
    return ("# built "
            + datetime.datetime.now().astimezone().isoformat(timespec="seconds"))


def exclusion_manifest(version, rej):
    """The receipt for what an export left out."""
    n = sum(len(v) for v in rej.values())
    out = [
        f"# {version} — filtered export",
        built_line(),
        f"# {n} image{'' if n == 1 else 's'} held back after review",
        "# status no = rejected; review = corrected, still waiting to be accepted",
        "",
        "split,image,status,reviewer,timestamp,comments",
    ]
    for sp in sorted(rej):
        for img, r in sorted(rej[sp].items()):
            out.append(",".join(csv_cell(x) for x in (
                sp, img, r.get("status", ""), r.get("reviewer", ""),
                r.get("ts", ""), comment_digest(r))))
    return "\n".join(out) + "\n"


def correction_manifest(version, fix):
    """The receipt for the labels this export replaced."""
    n = sum(len(v) for v in fix.values())
    out = [
        f"# {version} — corrected labels",
        built_line(),
        f"# {n} label file{'' if n == 1 else 's'} redrawn during review and "
        "accepted; the dataset on disk is unchanged",
        "",
        "split,image,boxes,corrected_by,corrected_at,accepted_by,comments",
    ]
    for sp in sorted(fix):
        for img, r in sorted(fix[sp].items()):
            out.append(",".join(csv_cell(x) for x in (
                sp, img, len(r["boxes"]), r["boxes_by"], r["boxes_ts"],
                r.get("reviewer", ""), comment_digest(r))))
    return "\n".join(out) + "\n"


def label_arc(split: str, stem: str) -> str:
    """Where one image's label file sits inside the zip."""
    return f"labels/{stem}.txt" if split == "." else f"labels/{split}/{stem}.txt"


def download_plan(version):
    """(skip, extra) for a reviewed export.

    Two jobs in one pass over the log: drop the images review held back, and
    swap in the labels review redrew. A corrected file is written from `extra`
    at the arcname its original would have had, so `skip` has to drop that
    original too or the zip would carry the same path twice."""
    rej, fix = rejected(version), corrected(version)
    if not rej and not fix:
        return None, {}

    stems = {sp: {Path(i).stem for i in imgs} for sp, imgs in rej.items()}
    flat = {s for v in stems.values() for s in v}
    extra, replaced = {}, {}
    for sp, imgs in fix.items():
        for img, r in imgs.items():
            stem = Path(img).stem
            extra[label_arc(sp, stem)] = label_text(r["boxes"])
            replaced.setdefault(sp, set()).add(stem)

    def skip(rel: Path):
        parts = rel.parts
        stem = Path(rel).stem
        if len(parts) >= 2 and parts[0] in ("images", "labels"):
            # <version>/images/<split>/name.jpg — match within that split only
            split = parts[1] if len(parts) > 2 else "."
            if stem in stems.get(split, set()):
                return True
            return parts[0] == "labels" and stem in replaced.get(split, set())
        # Base is already inside one split, so the split is not in the path.
        # Corrections are keyed by split and cannot be placed here, and this
        # download is one folder rather than a version, so only rejects apply.
        return stem in flat

    if rej:
        extra["EXCLUDED.csv"] = exclusion_manifest(version, rej)
    if fix:
        extra["CORRECTED.csv"] = correction_manifest(version, fix)
    return skip, extra


# ---------------------------------------------------------------- http layer

class Handler(BaseHTTPRequestHandler):
    server_version = "DatasetBrowser/2.0"
    protocol_version = "HTTP/1.1"     # required for chunked download streaming

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, mime="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), "application/json")

    # ---- static UI -------------------------------------------------------

    def _static(self, path: str):
        """Serve the built React app; unknown paths fall back to index.html."""
        if WEB is None or not WEB.is_dir():
            return self._send(503, b"UI not built. Run: cd web && npm run build",
                              "text/plain")
        rel = rel_path(path)
        f = (WEB / rel).resolve()
        if f != WEB and WEB not in f.parents:
            return self._send(403, b"forbidden", "text/plain")
        if not f.is_file():
            f = WEB / "index.html"          # client-side routing
            if not f.is_file():
                return self._send(404, b"not found", "text/plain")
        mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        # Vite fingerprints everything under assets/, so those cache hard.
        cache = ("public, max-age=31536000, immutable"
                 if str(rel).startswith("assets/") else "no-cache")
        return self._send(200, f.read_bytes(), mime, {"Cache-Control": cache})

    # ---- downloads -------------------------------------------------------

    def _download(self, rel: Path, exclude: bool):
        base = safe_under_root(rel)
        if not base.is_dir():
            return self._send(404, b"not found", "text/plain")

        version = rel.parts[0] if rel.parts and str(rel) != "." else ""
        name = rel.parts[-1] if rel.parts and str(rel) != "." else "dataset"
        skip, extra = None, {}
        if exclude and version:
            skip, extra = download_plan(version)
            name += "-reviewed"

        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{name}.zip"')
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if self.command == "HEAD":
            return
        w = ChunkedWriter(self.wfile)
        try:
            zip_into(w, base, name, skip=skip, extra=extra)
            w.close()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True      # reader walked away mid-download

    # ---- GET -------------------------------------------------------------

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if not u.path.startswith("/api/") and \
                    u.path not in ("/img", "/download", "/file"):
                return self._static(u.path)

            if u.path == "/api/versions":
                return self._json({"root": str(ROOT), "versions": list_versions(),
                                   "pillow": HAVE_PIL})
            if u.path == "/api/version":
                return self._json(stats_for(q["v"]))
            if u.path == "/api/items":
                sp = q.get("split", ".")
                flags = load_flags(q["v"], sp)
                items = [merged_item(i, flags.get(i["name"]))
                         for i in scan(q["v"], sp)]
                cls = q.get("cls", "")
                mode = q.get("mode", "all")
                if mode == "unlabeled":
                    items = [i for i in items if not i["labeled"]]
                elif mode == "empty":
                    items = [i for i in items if i["labeled"] and not i["boxes"]]
                elif mode == "unreviewed":
                    items = [i for i in items
                             if not (i["flag"] and i["flag"]["status"])]
                elif mode == "commented":
                    items = [i for i in items if i["flag"] and i["flag"]["comments"]]
                elif mode in STATUSES:
                    items = [i for i in items
                             if i["flag"] and i["flag"]["status"] == mode]
                if cls.strip():
                    # cls accepts one index or a comma list: "3" or "0,2,5".
                    # clsmode=any (default) keeps images holding at least one of
                    # them; clsmode=all keeps only images holding every one.
                    want = {int(c) for c in cls.split(",") if c.strip()}
                    need_all = q.get("clsmode") == "all"

                    def keep(i, want=want, need_all=need_all):
                        have = {b[0] for b in i["boxes"]}
                        return want <= have if need_all else bool(want & have)

                    items = [i for i in items if keep(i)]
                off = int(q.get("offset", 0))
                lim = min(int(q.get("limit", 120)), 500)
                return self._json({"total": len(items), "offset": off,
                                   "items": items[off:off + lim]})
            if u.path == "/api/review/meta":
                return self._json({
                    "statuses": list(STATUSES),
                    "comment_max": COMMENT_MAX,
                    "writable": os.access(REVIEW, os.W_OK) if REVIEW.exists() else False,
                    "user": (self.headers.get(USER_HEADER) or "") if USER_HEADER else None,
                    # Set but empty means the proxy is configured and silent —
                    # a misconfiguration the UI should not let pass unmentioned.
                    "user_header": USER_HEADER,
                })
            if u.path == "/api/review/summary":
                out, seen = {}, 0
                # Count only images that are still on disk: a verdict left in
                # the log for a file since deleted must not make the totals
                # claim more reviewed images than the version has.
                for sp in list_splits(q["v"]):
                    flags = load_flags(q["v"], sp)
                    for it in scan(q["v"], sp):
                        st = (flags.get(it["name"]) or {}).get("status")
                        if st:
                            out[st] = out.get(st, 0) + 1
                            seen += 1
                total = sum(len(scan(q["v"], sp)) for sp in list_splits(q["v"]))
                out["total"] = total
                out["unflagged"] = max(total - seen, 0)
                return self._json(out)
            if u.path == "/api/queue":
                # The fix queue thinks in versions, not splits: the images
                # waiting for work are wherever they happen to live.
                want = {s for s in q.get("status", "no,review").split(",") if s}
                out = []
                for sp in list_splits(q["v"]):
                    flags = load_flags(q["v"], sp)
                    for it in scan(q["v"], sp):
                        entry = flags.get(it["name"])
                        if entry and entry.get("status") in want:
                            out.append(dict(merged_item(it, entry), split=sp))
                return self._json({"version": q["v"], "total": len(out),
                                   "items": out})
            if u.path == "/api/review/rejects":
                rej = rejected(q["v"])
                return self._json({
                    "version": q["v"],
                    "total": sum(len(v) for v in rej.values()),
                    "images": [dict(flag_view(r), split=sp, image=img)
                               for sp in sorted(rej)
                               for img, r in sorted(rej[sp].items())],
                })
            if u.path == "/api/review/export":
                return self._send(200, review_csv(q["v"]), "text/csv", {
                    "Content-Disposition":
                        f'attachment; filename="{q["v"]}_review.csv"'})
            if u.path == "/api/refresh":
                with _scan_lock:
                    _scan_cache.clear()
                with _flag_lock:
                    _flags.clear()
                return self._json({"ok": True})
            if u.path == "/api/tree":
                return self._json(tree(rel_path(q.get("path", ""))))
            if u.path == "/download":
                return self._download(rel_path(q.get("path", "")),
                                      q.get("exclude") == "1")
            if u.path == "/file":
                f = safe_under_root(rel_path(q["path"]))
                if not f.is_file():
                    return self._send(404, b"not found", "text/plain")
                mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
                return self._send(200, f.read_bytes(), mime, {
                    "Content-Disposition": f'attachment; filename="{f.name}"'})
            if u.path == "/img":
                sp = q.get("split", ".")
                rel = Path(q["v"]) / "images" / sp / q["n"] if sp != "." \
                    else Path(q["v"]) / "images" / q["n"]
                f = safe_under_root(rel)
                if not f.is_file():
                    return self._send(404, b"not found", "text/plain")
                if q.get("t") == "1":
                    data, mime = thumbnail(f)
                else:
                    data = f.read_bytes()
                    mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
                return self._send(200, data, mime,
                                  {"Cache-Control": "public, max-age=3600"})
            return self._send(404, b"not found", "text/plain")
        except PermissionError:
            return self._send(403, b"forbidden", "text/plain")
        except KeyError as e:
            return self._json({"error": f"missing param {e}"}, 400)
        except ValueError as e:
            return self._json({"error": f"bad param: {e}"}, 400)
        except FileNotFoundError:
            return self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)

    def do_HEAD(self):
        return self.do_GET()

    # ---- POST ------------------------------------------------------------

    def _target(self, body):
        """Check {v, split, image} against the dataset and name the author."""
        for k in ("v", "split", "image"):
            if not isinstance(body.get(k), str) or not body[k]:
                raise ValueError(f"missing {k}")
        sub = (Path(body["v"]) / "images" / body["split"] / body["image"]
               if body["split"] != "." else
               Path(body["v"]) / "images" / body["image"])
        if not safe_under_root(sub).is_file():
            raise FileNotFoundError("unknown image")
        # An authenticated proxy wins over the self-declared name.
        who = body.get("reviewer", "")
        if USER_HEADER:
            who = self.headers.get(USER_HEADER) or ""
            if not who:
                self._warn_no_identity()
                who = UNOWNED
        return body["v"], body["split"], body["image"], who

    def _warn_no_identity(self):
        """Say so once, loudly. Getting this wrong is silent otherwise: every
        verdict and comment is still saved, just filed under nobody."""
        global _warned_no_identity
        if _warned_no_identity:
            return
        _warned_no_identity = True
        sys.stderr.write(
            f"\n!! --user-header {USER_HEADER} is set, but no request carries it.\n"
            f"!! Verdicts and comments are being filed under \"{UNOWNED}\".\n"
            "!! The proxy is not passing the header. In Caddy, check that the\n"
            "!! reverse_proxy block sets it and that no `header_up -" + str(USER_HEADER) +
            "`\n!! line follows: header ops apply add, set, then delete, so a\n"
            "!! deletion written after the set strips the value again.\n\n")

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if u.path not in POST_MAX:
                return self._send(404, b"not found", "text/plain")
            n = int(self.headers.get("Content-Length", 0))
            if n > POST_MAX[u.path]:
                return self._json({"error": "payload too large"}, 413)
            body = json.loads(self.rfile.read(n) or b"{}")
            v, sp, img, who = self._target(body)

            if u.path == "/api/flag":
                append_flag(v, sp, img, body.get("status", ""), who)
            elif u.path == "/api/comment":
                cid = body.get("id")
                if cid is not None and (not isinstance(cid, str) or not cid):
                    return self._json({"error": "bad id"}, 400)
                append_comment(v, sp, img, body.get("text", ""), who, cid)
            elif u.path == "/api/labels":
                append_labels(v, sp, img, body.get("boxes"), who)
            elif u.path == "/api/labels/revert":
                revert_labels(v, sp, img, who)
            else:
                cid = body.get("id")
                if not isinstance(cid, str) or not cid:
                    return self._json({"error": "missing id"}, 400)
                delete_comment(v, sp, img, cid, who)

            # The whole thread comes back, so a client that missed somebody
            # else's comment catches up on its next write instead of drifting.
            # A relabel also answers with the boxes that are now current.
            out = {"ok": True, "flag": flag_of(v, sp, img)}
            if u.path.startswith("/api/labels"):
                entry = load_flags(v, sp).get(img)
                out["boxes"] = (entry["boxes"] if entry and entry["boxes"] is not None
                                else parse_label(label_file(v, sp, img)))
            return self._json(out)
        except PermissionError as e:
            return self._json({"error": str(e) or "forbidden"}, 403)
        except FileNotFoundError as e:
            return self._json({"error": str(e) or "not found"}, 404)
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except OSError as e:
            return self._json({"error": f"cannot write review log: {e}"}, 500)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)


def main():
    global ROOT, REVIEW, CACHE_DIR, USER_HEADER, WEB
    ap = argparse.ArgumentParser(description="Read-only YOLO dataset browser.")
    ap.add_argument("root", help="directory holding dataset version folders")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--user-header", default=os.environ.get("USER_HEADER") or None,
                    help="trust this request header as the reviewer identity "
                         "(only safe behind an authenticating reverse proxy)")
    ap.add_argument("--review", default=None,
                    help="where review flags are written (default: <root>/../review)")
    ap.add_argument("--cache", default=None, help="thumbnail cache dir (default: ~/.cache)")
    ap.add_argument("--web", default=None,
                    help="built React app (default: web/dist next to this file)")
    a = ap.parse_args()

    ROOT = Path(a.root).resolve()
    if not ROOT.is_dir():
        sys.exit(f"not a directory: {ROOT}")

    USER_HEADER = a.user_header
    REVIEW = Path(a.review) if a.review else ROOT.parent / "review"
    try:
        REVIEW.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    CACHE_DIR = Path(a.cache or (Path.home() / ".cache" / "dataset-browser"))
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    WEB = Path(a.web).resolve() if a.web else (Path(__file__).parent / "web" / "dist")

    print(f"root      {ROOT}")
    print(f"versions  {', '.join(list_versions()) or '(none found)'}")
    print(f"review    {REVIEW}"
          f"{'' if os.access(REVIEW, os.W_OK) else '   [NOT WRITABLE — flags will fail]'}")
    print(f"identity  {USER_HEADER or 'self-declared (no proxy auth)'}")
    print(f"thumbs    {'Pillow' if HAVE_PIL else 'off — pip install Pillow to speed up'}")
    print(f"ui        {WEB}"
          f"{'' if WEB.is_dir() else '   [NOT BUILT — cd web && npm run build]'}")
    print(f"serving   http://{a.host}:{a.port}")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
