# slim-archive — rebuilding the pinned Addressables archive

The pinned community archive is a rebuilt copy of the upstream
[`web-ports/hollow-knight-silksong`](https://github.com/web-ports/hollow-knight-silksong)
Addressables ZIP. The published, art-preserving archive is **2,083,139,638 →
1,847,328,572 bytes** (**1986.6 → 1761.75 MiB**) in 111 parts. The rebuild
stubs streamed cutscene video and zeroes mesh payloads, but **preserves original
texture art by default**. Texture replacement is available only as an explicit
lossy opt-in. This directory holds the bundle editor, ZIP/parts writer, and
publisher.

| file | what it is |
| --- | --- |
| `bundle_tool.py` | reads, patches and rewrites a UnityFS bundle one block at a time |
| `typetree_read.py` | AssetStudio-style type-tree walker that records the byte span of every field |
| `treetools.py` | adapts UnityPy's type-tree parser to the local field walker |
| `slim_pipeline.py` | the video/mesh edits, optional lossy texture edit, ZIP and parts writer |
| `publish_assets.py` | publishes the parts as Git blobs and creates a lightweight tag via the GitHub API |

## What it does

Every edit is **size-preserving**: objects are never moved, no object row is
removed, and the decompressed stream keeps its exact layout, so every path id
still resolves and the bundle stays valid. Only bytes inside the stream change.

1. **Cutscenes.** The 26 streamed video payloads in `packed-cinematics` are
overwritten with the same ~600-byte blank MP4
(`makePlaceholderVideo` in `tools/unity-webdata.mjs`) and zero-padded to their
original lengths. The rebuild stubbed **224,097,829 bytes** of video; audio-only
MPEG payloads are left alone.
2. **Meshes.** The vertex/index payloads of 6,386 `Mesh` objects are zeroed,
while counts and packing metadata stay intact: **456,033,780 bytes** of mesh
data. This is inherited lossy geometry removal; validate game scenes before
assuming empty meshes are harmless.
3. **Textures.** All Texture2D payloads and atlas art are kept unchanged by
default. `--textures` opts into the old destructive behavior: later byte-
identical image payloads are replaced with a repeated 16-byte block. That is
**not deduplication**; each Texture2D remains in its original bundle, but its
art becomes a flat color. Do not use this flag for the published/community
build. `--no-textures` remains accepted and explicitly keeps the default
art-preserving behavior.
4. **The ZIP.** Bundles are written back with LZ4 blocks (the container the
player expects) and deflated into one ZIP, split into 16 MiB parts. The 111
parts are each below GitHub raw's 100 MB per-blob limit. jsDelivr's limit is on
the whole GitHub package, not on a part, and the 1.72 GiB package exceeds it.

Measured rebuild:

- bundle bytes: `2,486,528,891` → `2,080,369,134` (**2371.3 → 1984.0 MiB**);
- ZIP bytes: `2,083,139,638` → `1,847,328,572` (**1986.6 → 1761.75 MiB**);
- parts: **111** × 16 MiB maximum; final part **1,834,812 bytes**;
- output ZIP: 21 bundle entries; every entry CRC passes;
- the 111 concatenated parts reproduce the complete ZIP byte-for-byte;
- the uncompressed UnityFS streams for `sprites-ui`, `sprites-scenery`,
  `sprites-hero`, and `collections` match the upstream SHA-256 exactly.

Audio, original texture art (including duplicate atlas copies), animation data,
and all non-video/non-mesh payloads remain untouched. See
[`../../ARCHIVE-SIZE-BREAKDOWN.md`](../../ARCHIVE-SIZE-BREAKDOWN.md) for the
measured upstream breakdown and current archive results.

## Running it

The upstream source is pinned to
`web-ports/hollow-knight-silksong@bcbe014765f2f6ca4b1d82ac25755a0299a600ab`.
Its `StreamingAssets/aa/WebGL.zip` is split into 100 GitHub blobs. Fetch those
blobs through the GitHub API (not a raw URL or `curl`), join them, verify the
ZIP, and extract all 21 bundles before rebuilding. Install the Python
requirements:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install lz4 xxhash UnityPy
```

From the directory containing the extracted `bundles/`, the 622-byte
`placeholder.mp4`, and this tool (for example the ignored `.tmp/hkss/` workspace):

```sh
python3 /path/to/slim_pipeline.py bundles --src bundles --out slim \
  --placeholder placeholder.mp4
python3 /path/to/slim_pipeline.py zip --src slim --out slim.zip \
  --parts-dir parts --part-size 16777216
```

The `bundles` command defaults to `textures=False`. Add `--textures` only for a
deliberately art-stripped build; `--no-textures` is still parsed as an explicit
preservation flag. Bundle processing took about **21 minutes** on the measured
21-bundle rebuild, dominated by the large `collections` and `scenes` bundles.
The default stats file is written to `<out>/slim-stats.json`; `--stats FILE`
chooses another location. `zip` prints the entry table, exact archive size, and
part totals. Memory scales with the largest bundle; the measured peak during
the full run was about 1.7 GiB.

## Publishing

The parts were published under the new tag `art-preserved-20261017`; the
resulting publish commit is
`a2c4553a3e40ee536672eabb39341856e0ba35ee`. The descriptor pins the commit, not
the mutable tag. No branch is touched and no ZIP/part files enter the working
clone. To publish another version, choose a new tag and update
`web/community-build.json` with the commit and exact part sizes:

```sh
python3 publish_assets.py --parts-dir parts \
  --tag art-preserved-YYYYMMDD --repo kinggerb/silksongcode --workers 4
```

The publisher prints the tag-based URLs and the pinned commit URL. The
`community-build.json` descriptor records the raw GitHub URL as
`assetArchive.base` and the jsDelivr URL as `assetArchive.mirror`, both pinned
to the publish commit. GitHub raw serves every part because each is below 100
MB. jsDelivr refuses uncached parts of packages over 150 MB; the current
package is 1.72 GiB, so raw leads and jsDelivr is only the fallback.

## What the page does differently

`assetArchive.slim = true` tells `js/community-build.js` there is no further
entry-level pruning to do. **Eager delivery is the default:** all parts stream
to OPFS before Unity starts. `?assets=lazy` opts into loading ZIP metadata and
requested bundles on demand; this has synthetic delivery/failure tests, but it
is not the default until a full real-game run proves every startup dependency.
A failed requested part or bundle is surfaced in the page UI and propagated as
an error instead of silently mounting incomplete assets.

The cutscene bypass in the fetch mount stays as a safety net for any video
path that is not in the archive. Both loading modes use `mirrorFetch`, which
asks `assetArchive.mirror` once for any part the base refuses (403/404/408/429/
5xx) or cannot reach. See
[`../../COMMUNITY-BUILD.md`](../../COMMUNITY-BUILD.md) and
[`../../LOADING-OPTIMIZATIONS.md`](../../LOADING-OPTIMIZATIONS.md) for storage,
rate-limit and loading-mode behavior.
