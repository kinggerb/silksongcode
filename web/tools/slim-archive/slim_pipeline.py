#!/usr/bin/env python3
"""Build the slimmer Silksong web archive.

Per bundle, without ever moving an object (every edit is size-preserving, so
the decompressed stream layout and every object offset stay exactly where they
were):

  1. cutscene videos - the MP4 payloads streamed out of a `.resource` node are
     replaced with the tiny placeholder MP4 this repository already uses for
     prepared builds, zero-padded to the original length;
  2. duplicate textures - a Texture2D whose image data is byte-identical to one
     already seen anywhere in the archive is emptied out in place (its first
     BC7 block repeated: a legal, flat texture of the same size).  Nothing else
     can dedupe across bundle boundaries, because each bundle is its own ZIP
     entry and a deflate window cannot span two entries;
  3. meshes - the vertex/index blobs of every Mesh are zeroed, leaving the
     counts and the packing metadata intact, so the mesh still loads as an
     empty mesh instead of the 3D geometry a 2D game never draws;
then every bundle is written back with LZ4 blocks (keeping the container the
player expects) and packed into one deflate ZIP.

Usage:
    slim_pipeline.py bundles [--only a,b] [--verify] [--out DIR]
    slim_pipeline.py zip     [--src DIR] [--out FILE] [--part-size N]
"""
import argparse
import glob
import hashlib
import json
import os
import struct
import sys
import time
import zlib
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle_tool as BT          # noqa: E402
import treetools                  # noqa: E402
import typetree_read as TR        # noqa: E402

MIB = 1048576.0
TEXTURE_MIN = 64 * 1024          # only bother with textures this big
MESH_MIN = 512                   # only bother with meshes this big


# --------------------------------------------------------------------- video
def video_region(raw):
    """(offset, size) of the streamed payload a VideoClip/AudioClip points at."""
    p = raw.find(b"archive:/")
    if p < 4:
        return None
    n = struct.unpack_from("<I", raw, p - 4)[0]
    if n <= 0 or p + n > len(raw):
        return None
    q = (p + n + 3) & ~3
    if q + 16 > len(raw):
        return None
    off, size = struct.unpack_from("<QQ", raw, q)
    return off, size


def mp4_kind(head):
    """'video' / 'audio' / '' - MP4 with a video or sound track?"""
    if len(head) < 12 or head[4:8] != b"ftyp":
        return ""
    if b"vide" in head:
        return "video"
    if b"soun" in head:
        return "audio"
    return ""


class Slimmer:
    def __init__(self, src, out, placeholder, log=print,
                 videos=True, textures=True, meshes=True):
        self.src = src
        self.out = out
        os.makedirs(out, exist_ok=True)
        self.placeholder = open(placeholder, "rb").read()
        self.log = log
        self.opt = dict(videos=videos, textures=textures, meshes=meshes)
        self.seen = {}                   # (size, digest) -> bundle + object
        self.tot = Counter()
        self.per_bundle = []

    # ------------------------------------------------------------------ utils
    @staticmethod
    def _trees(bundle, node):
        _ver, types = treetools.trees_for(bundle, node)
        return {cid: tree for cid, tree in types}

    def _walk(self, bundle, obj, tree):
        """Parse one object, but only if the walk consumes exactly its bytes."""
        raw = bundle.read(obj["abs"], obj["size"])
        r = TR.TreeReader(raw)
        try:
            _v, end = r.read(tree, 0)
        except Exception:
            return None, None
        if end > obj["size"] or obj["size"] - end > 8:
            return None, None
        return r, raw

    # ----------------------------------------------------------------- videos
    def stub_videos(self, bundle, patches, objects, res_offset, res_size):
        """Replace every streamed cutscene payload with the placeholder."""
        stubbed = kept = 0
        for o in objects:
            raw = bundle.read(o["abs"], min(o["size"], 512))
            reg = video_region(raw)
            if not reg:
                continue
            off, size = reg
            if size <= len(self.placeholder) or off + size > res_size:
                continue
            head = bundle.read(res_offset + off, 4096)
            if mp4_kind(head) != "video":
                kept += size
                continue
            patches.append(("bytes", res_offset + off, self.placeholder))
            patches.append(("zero", res_offset + off + len(self.placeholder),
                            size - len(self.placeholder)))
            stubbed += size
            self.tot["video.stubbed"] += size
            self.tot["video.count"] += 1
        self.tot["video.kept"] += kept
        return stubbed

    # --------------------------------------------------------------- textures
    def stub_textures(self, bundle, patches, objects, tree):
        stubbed = 0
        for o in objects:
            if o["size"] < TEXTURE_MIN:
                continue
            r, raw = self._walk(bundle, o, tree)
            if r is None:
                self.tot["texture.walk_failed"] += 1
                continue
            span = r.span("Base.image data")
            if not span or span[1] < TEXTURE_MIN:
                continue
            off, size, _kind = span
            img = raw[off:off + size]
            key = (size, hashlib.blake2b(img, digest_size=16).digest())
            first = self.seen.get(key)
            if first is None:
                self.seen[key] = (os.path.basename(bundle.path), o["path_id"])
                self.tot["texture.unique"] += size
                continue
            patches.append(("fill16", o["abs"] + off, size, img[:16]))
            stubbed += size
            self.tot["texture.stubbed"] += size
            self.tot["texture.stubbed.count"] += 1
        return stubbed

    # ----------------------------------------------------------------- meshes
    def stub_meshes(self, bundle, patches, objects, tree):
        """Zero the vertex blobs: the mesh keeps its counts but has no shape."""
        stubbed = 0
        for o in objects:
            if o["size"] < MESH_MIN:
                continue
            r, raw = self._walk(bundle, o, tree)
            if r is None:
                self.tot["mesh.walk_failed"] += 1
                continue
            zeroed = 0
            for path, (off, size, kind) in r.spans.items():
                if kind != "bytes" or size < 64:
                    continue
                if path in ("Base.m_Name",) or path.endswith(("m_Name", ".__count")):
                    continue
                patches.append(("zero", o["abs"] + off, size))
                zeroed += size
            if zeroed:
                stubbed += 1
                self.tot["mesh.zeroed"] += zeroed
                self.tot["mesh.count"] += 1
        return stubbed

    # ------------------------------------------------------------------- main
    def run_bundle(self, name):
        t0 = time.time()
        src = os.path.join(self.src, name)
        dst = os.path.join(self.out, name)
        b = BT.BundleEdit(src)
        patches = []
        info = Counter()
        nodes = [(n, None) for n in b.nodes if not n["name"].endswith((".resource", ".resS"))]
        for node, _ in nodes:
            try:
                sf = b.serialized(node)
            except Exception as exc:
                self.log("    %-52s unparsed: %s" % (node["name"][:52], exc))
                continue
            if "objects" not in sf:
                continue
            node["_sf"] = sf
        resources = [n for n in b.nodes if n["name"].endswith((".resource", ".resS"))]

        # textures and meshes live in the serialized nodes
        for node, _ in nodes:
            sf = node.get("_sf")
            if not sf or not sf["objects"]:
                continue
            objs = sf["objects"]
            by_class = Counter(o["class_id"] for o in objs)
            info["objects"] += len(objs)
            if not (self.opt["textures"] and by_class.get(28)) and \
               not (self.opt["meshes"] and by_class.get(43)):
                continue
            trees = self._trees(b, node)
            if self.opt["textures"] and by_class.get(28) and trees.get(28):
                info["textures"] = self.stub_textures(
                    b, patches, [o for o in objs if o["class_id"] == 28], trees[28])
            if self.opt["meshes"] and by_class.get(43) and trees.get(43):
                info["meshes"] = self.stub_meshes(
                    b, patches, [o for o in objs if o["class_id"] == 43], trees[43])

        # videos are pointed at by clips in a serialized node but live in the
        # resource node next to it
        if self.opt["videos"]:
            for res in resources:
                for node, _ in nodes:
                    sf = node.get("_sf")
                    if not sf:
                        continue
                    clips = [o for o in sf["objects"] if o["class_id"] in (329, 83)]
                    if not clips:
                        continue
                    info["videos"] += self.stub_videos(
                        b, patches, clips, res["offset"], res["size"])

        patches.sort(key=lambda p: p[1])
        for i in range(1, len(patches)):
            if patches[i][1] < 0:
                raise ValueError("negative patch offset")
        b.patches = patches
        size = b.save(dst, mode="lz4")
        dt = time.time() - t0
        self.log("  %-44s %7.1f -> %7.1f MiB  patches=%-5d videos=%-2d tex=%-3d mesh=%-4d [%ds]" % (
            name[7:36], os.path.getsize(src) / MIB, size / MIB, len(patches),
            info["videos"], info["textures"], info["meshes"], dt))
        rec = dict(name=name, before=os.path.getsize(src), after=size,
                   patches=len(patches), videos=info["videos"],
                   textures=info["textures"], meshes=info["meshes"], seconds=round(dt, 1))
        self.per_bundle.append(rec)
        self.tot["bundle.before"] += rec["before"]
        self.tot["bundle.after"] += rec["after"]

    def run(self, names):
        for i, name in enumerate(names, 1):
            self.log("[%2d/%d] %s" % (i, len(names), name[7:60]))
            try:
                self.run_bundle(name)
            except Exception as exc:
                import traceback
                traceback.print_exc()
                self.log("    FAILED: %s" % exc)


# ------------------------------------------------------------------ zip build
def build_zip(src, out_zip, parts_dir=None, part_size=20866662, entries=None):
    """Deflate the slim bundles into one ZIP (the player reads it like the old one)."""
    import zipfile
    names = entries or sorted(os.listdir(src))
    names = [n for n in names if n.endswith(".bundle")]
    t0 = time.time()
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, allowZip64=True,
                         compresslevel=9) as zf:
        for name in names:
            path = os.path.join(src, name)
            info = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, "rb") as fh, zf.open(info, "w", force_zip64=True) as out:
                while True:
                    chunk = fh.read(4 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            print("  + %-70s %9.1f MiB" % (name, os.path.getsize(path) / MIB))
    total = os.path.getsize(out_zip)
    print("zip: %.1f MiB in %.0fs" % (total / MIB, time.time() - t0))
    if parts_dir:
        os.makedirs(parts_dir, exist_ok=True)
        parts = []
        with open(out_zip, "rb") as fh:
            i = 1
            while True:
                data = fh.read(part_size)
                if not data:
                    break
                p = os.path.join(parts_dir, "WebGL.zip.part%d" % i)
                with open(p, "wb") as ph:
                    ph.write(data)
                parts.append(dict(path="StreamingAssets/aa/WebGL.zip.part%d" % i,
                                  bytes=len(data)))
                i += 1
        print("parts: %d (last %d bytes)" % (len(parts), parts[-1]["bytes"]))
        return total, parts
    return total, None


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bundles")
    b.add_argument("--src", default="/tmp/hkss/bundles")
    b.add_argument("--out", default="/tmp/hkss/slim")
    b.add_argument("--placeholder", default="/tmp/hkss/placeholder.mp4")
    b.add_argument("--only", default="")
    b.add_argument("--no-videos", action="store_true")
    b.add_argument("--no-textures", action="store_true")
    b.add_argument("--no-meshes", action="store_true")
    z = sub.add_parser("zip")
    z.add_argument("--src", default="/tmp/hkss/slim")
    z.add_argument("--out", default="/tmp/hkss/silksong-slim.zip")
    z.add_argument("--parts-dir", default="")
    z.add_argument("--part-size", type=int, default=20866662)
    a = ap.parse_args()

    if a.cmd == "bundles":
        names = sorted(os.path.basename(p) for p in glob.glob(os.path.join(a.src, "*.bundle")))
        if a.only:
            want = [w.strip() for w in a.only.split(",") if w.strip()]
            names = [n for n in names if any(w in n for w in want)]
        print("bundles: %d" % len(names))
        s = Slimmer(a.src, a.out, a.placeholder,
                    videos=not a.no_videos, textures=not a.no_textures,
                    meshes=not a.no_meshes)
        t0 = time.time()
        s.run(names)
        print("\n%.1f MiB -> %.1f MiB in %.0fs" % (
            s.tot["bundle.before"] / MIB, s.tot["bundle.after"] / MIB, time.time() - t0))
        for k in sorted(s.tot):
            print("   %-24s %d" % (k, s.tot[k]))
        with open("/tmp/hkss/slim-stats.json", "w") as fh:
            json.dump(dict(totals=dict(s.tot), bundles=s.per_bundle), fh, indent=1)
    else:
        build_zip(a.src, a.out, a.parts_dir or None, a.part_size)


if __name__ == "__main__":
    main()
