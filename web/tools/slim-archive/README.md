# slim-archive — rebuilding the pinned Addressables archive

The pinned community archive is a trimmed copy of the upstream
[`web-ports/hollow-knight-silksong`](https://github.com/web-ports/hollow-knight-silksong)
Addressables ZIP: **1986.6 MB → 1194.1 MB**, with the game still a game. This
directory holds the tools that build it, plus the publisher that puts it where
the page can fetch it.

| file | what it is |
| --- | --- |
| `bundle_tool.py` | reads, patches and rewrites a UnityFS bundle one block at a time |
| `typetree_read.py` | AssetStudio-style type-tree walker that records the byte span of every field |
| `treetools.py` | pulls the type trees out of a serialized file |
| `slim_pipeline.py` | the three edits + the ZIP/parts writer |
| `publish_assets.py` | commits the parts as git blobs behind a tag, via the API |

## What it does

Every edit is **size-preserving**: objects are never moved, no object row is
removed, and the decompressed stream keeps its exact layout, so every path id
still resolves and the bundle stays valid. Only bytes inside the stream change.

1. **Cutscenes.** Each `VideoClip` in `packed-cinematics` points at an MP4 in
   the bundle's `.resource` node. The payload is overwritten with the same
   ~600-byte blank MP4 (`makePlaceholderVideo` in `tools/unity-webdata.mjs`)
   and zero-padded to its original length: 224 MB gone, the clip still loads.
   Audio-only MPEG payloads (`soun`) are left alone — that is the game's audio.
2. **Duplicate textures.** 85 groups of byte-identical `Texture2D` image data
   ship once per bundle set (the top atlas eleven times). The first copy is
   kept, every later copy is overwritten with its own first BC7 block repeated:
   a flat, legal texture of exactly the same size, and 2,789 MB of raw texture
   data that is never downloaded twice. Nothing else can dedupe it — every
   bundle is its own ZIP entry, and a deflate window cannot span entries.
3. **Meshes.** 6,386 `Mesh` vertex/index blobs are zeroed (counts and packing
   metadata stay), so the geometry a 2D game never draws costs nothing:
   435 MB.
4. **The ZIP.** Bundles are written back with LZ4 blocks (the container the
   player expects) and deflated into one ZIP, split into 16 MiB parts —
   small enough for `raw.githubusercontent.com` to serve, whose limit is
   100 MB per blob. jsDelivr's limit is on the *package*, not the part, and
   1.19 GB is over it.

Measured result: bundles 2,486.5 MB → 1,426.8 MB, ZIP `2,083,139,638` →
`1,252,071,320` bytes, in 75 parts. Left alone on purpose: audio (402 MB), the
art-collection atlases (`packed-collections`, 1,833 MB, all unique) and the
animation data.

## Running it

Needs Python 3 and `lz4` (`pip install lz4`); the bundles come out of
`StreamingAssets/aa/WebGL.zip` of the pinned build.

```sh
python3 slim_pipeline.py bundles --src bundles --out slim      # ~17 min
python3 slim_pipeline.py zip --src slim --out slim.zip --parts-dir parts \
        --part-size 16777216
```

`bundles` prints a per-bundle table (`before -> after`, patch counts) and writes
`slim-stats.json`; `zip` prints the entry table and the part totals. Both run
in a few hundred megabytes of RAM regardless of archive size.

## Publishing

GitHub *release* assets are the natural home, but their upload endpoint
(`uploads.github.com`) is not reachable from every network. The git data API is,
so the parts are committed straight through it — no branch is touched, nothing
lands in a local clone — and referenced by a lightweight tag:

```sh
python3 publish_assets.py --parts-dir parts --tag slim-assets \
        --repo kinggerb/silksongcode --workers 6
```

It prints the two URLs that serve the result:

```
https://raw.githubusercontent.com/kinggerb/silksongcode/slim-assets/parts/
https://cdn.jsdelivr.net/gh/kinggerb/silksongcode@<commit>/parts/
```

`community-build.json` keeps the **raw.githubusercontent** URL as
`assetArchive.base` and records the jsDelivr one as `assetArchive.mirror`, both
pinned to the publish *commit* rather than to the tag, which can move.

That order used to be the other way round, on the theory that the CDN the build
files already use was the safer host and CORS is known to work there. It is not:
jsDelivr refuses a GitHub *package* larger than 150 MB, and this one is
~1.19 GB, so it answers `403 Package size exceeded the configured limit of 150
MB` for every part it has not already cached — a download reached part 6 of 75
and stopped there. raw.githubusercontent.com serves any committed blob under
100 MB and a part is 16 MiB, so it always answers; jsDelivr is still worth
keeping as the mirror for the parts it does serve. `js/community-build.js`
retries a refused or unreachable part once against the mirror (`mirrorFetch`),
so either host can lead, and swapping the two is a descriptor-only change —
nothing has to be rebuilt or re-published. The page can be pointed at either by
hand with `?archiveBase=https://host/path/`.

## What the page does differently

`assetArchive.slim = true` tells `js/community-build.js` that there is nothing
left to leave out, so it skips the plan step (a couple of hundred range
requests) and downloads the parts directly, six at a time. The cutscene bypass
in the fetch mount stays as a safety net for any video path that is not in the
archive. The download itself runs through `mirrorFetch`, which asks
`assetArchive.mirror` once for any part the base refuses (403/404/408/429/5xx)
or cannot be reached for.
