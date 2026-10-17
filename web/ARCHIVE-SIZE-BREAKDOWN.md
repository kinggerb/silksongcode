# What the upstream community archive is actually made of

The pinned upstream source from
[`web-ports/hollow-knight-silksong`](https://github.com/web-ports/hollow-knight-silksong)
(`bcbe0147`) contains an original Addressables ZIP of **2,083,139,638 bytes**
(**1986.6 MiB / 2083.1 MB**). The player now uses a rebuilt, art-preserving ZIP
of **1,847,328,572 bytes** (**1761.75 MiB / 1847.3 MB**) in 111 parts; see
[§7](#7-the-art-preserving-published-archive) for the exact rebuild and
verification. Sections 1–6 below describe the measured *upstream* archive
before editing: every number was read from its ZIP central directory and
UnityFS bundle metadata, not estimated from names.

The original source archive was fetched and CRC-checked; the survey method is
described at the end.

## 1. The archive is 21 Unity bundles, nothing else

The ZIP holds **21 entries** — all of them Addressables bundles, no loose files:

| # | bundle (Addressables group) | download | on device | objects | main content |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | `scenes-hornet_scenes_all_c907e217…` | 328.0 MiB | 2883 MiB | 4,135,938 | textures 904, particle systems 687, MonoBehaviours 484 |
| 2 | `collections` | 291.8 MiB | 1914 MiB | 2,892 | textures 1865, sprites 39 |
| 3 | `cinematics` | 216.8 MiB | 219 MiB | 70 | 43 MP4 cutscenes 219 |
| 4 | `audio-hornetmusic` | 174.5 MiB | 177 MiB | 181 | AAC audio 177 |
| 5 | `sprites-scenery` | 169.1 MiB | 879 MiB | 2,633 | textures 876 |
| 6 | `prefabs` | 125.1 MiB | 668 MiB | 66,816 | textures 626, particle systems 21 |
| 7 | `audio-hornetvoices` | 108.4 MiB | 117 MiB | 4,456 | AAC audio 116 |
| 8 | `animations-props` | 107.4 MiB | 510 MiB | 1,415 | textures 507 |
| 9 | `audio-sfx` | 95.3 MiB | 101 MiB | 4,549 | AAC audio 100 |
| 10 | `animations-hornet` | 76.3 MiB | 361 MiB | 1,096 | textures 359 |
| 11 | `fonts` | 46.7 MiB | 117 MiB | 155 | textures 72, fonts 44 |
| 12 | `sprites-hero` | 34.0 MiB | 186 MiB | 651 | textures 185 |
| 13 | `sprites-hornet_bosses` | 32.5 MiB | 243 MiB | 794 | textures 242 |
| 14 | `animations-hornetnpcs` | 27.7 MiB | 145 MiB | 493 | textures 145 |
| 15 | `animations-hornetenemies` | 27.7 MiB | 144 MiB | 1,211 | textures 142 |
| 16 | `animations-effects` | 25.6 MiB | 122 MiB | 269 | textures 122 |
| 17 | `audio-voices` | 22.8 MiB | 24 MiB | 1,195 | AAC audio 24 |
| 18 | `sprites-hornet_enemies` | 21.3 MiB | 177 MiB | 898 | textures 175 |
| 19 | `animations-cutscene` | 20.6 MiB | 104 MiB | 238 | textures 104 |
| 20 | `sprites-effects` | 20.1 MiB | 101 MiB | 476 | textures 101 |
| 21 | `sprites-ui` | 15.0 MiB | 112 MiB | 344 | textures 112 |
| | **total** | **1986.6 MiB** | **9306 MiB** | **4.2 M** | |

"Download" is the exact size of each ZIP entry; "on device" is what that bundle
turns into once both compression layers are undone (see §2).

## 2. Two compression layers, so 1986.6 MiB becomes ~9.5 GiB

| layer | bytes | what it is |
| --- | ---: | --- |
| downloaded | 2,083,139,638 (1986.6 MiB) | the 100 `WebGL.zip.partN` files |
| bundle files | 2,486,528,891 (2371.3 MiB) | after the ZIP's deflate |
| bundle contents | 10,147,447,371 (9677.4 MiB) | after each bundle's own LZ4-HC |
| – asset objects | 9,090,612,047 (8669.5 MiB) | every object in every object table |
| – `.resource` payloads | 667,167,761 (636.3 MiB) | cutscene/audio MP4 data |
| – metadata & padding | 389,667,563 (371.6 MiB) | serialized-file headers, type & object tables, alignment |

So the download is not "the game" so much as the game **plus two compression
passes on top of it**. The 21 bundle files total 2.37 GiB after ZIP inflation;
their UnityFS contents total 9.45 GiB when decompressed. Those totals describe
the complete corpus on disk, not simultaneous resident memory in the browser.

## 3. The breakdown by content

Every number below is the sum of real object sizes (from the bundles' object
tables) plus the `.resource` payloads. "In the download" allocates each
bundle's compressed bytes to its contents by how many bytes those contents
occupy inside it; because deflate favours some content over others this column
is an allocation, good to a few percent, while "on device" is exact.

| What | In the download | % | On device | % |
| --- | ---: | ---: | ---: | ---: |
| **Textures & sprite atlases** | 1107.0 MiB | 55.7 % | 6536.6 MiB | 70.2 % |
| **Audio (AAC, ~8,900 clips)** | 402.2 MiB | 20.2 % | 426.9 MiB | 4.6 % |
| **Cutscenes (43 MP4 movies)** | 216.8 MiB | 10.9 % | 218.8 MiB | 2.4 % |
| Particle systems | 82.1 MiB | 4.1 % | 707.8 MiB | 7.6 % |
| Game logic & save data (MonoBehaviour) | 59.3 MiB | 3.0 % | 507.8 MiB | 5.5 % |
| 3D meshes | 50.5 MiB | 2.5 % | 443.4 MiB | 4.8 % |
| GameObjects & transforms | 18.8 MiB | 0.9 % | 164.1 MiB | 1.8 % |
| Sprite renderer components | 17.2 MiB | 0.9 % | 151.0 MiB | 1.6 % |
| Fonts | 17.7 MiB | 0.9 % | 44.4 MiB | 0.5 % |
| Sprites (image assets) | 10.0 MiB | 0.5 % | 67.7 MiB | 0.7 % |
| Colliders, joints & rigidbodies | 2.6 MiB | 0.1 % | 23.1 MiB | 0.2 % |
| Animation clips & controllers | 1.1 MiB | 0.1 % | 6.3 MiB | 0.1 % |
| Manifest / scene settings | 1.2 MiB | 0.1 % | 7.4 MiB | 0.1 % |
| Materials & shaders | 0.1 MiB | 0.0 % | 0.4 MiB | 0.0 % |
| **total** | **1986.6 MiB** | 100 % | **9306 MiB** | 100 % |

The same thing by asset class, for reference:

| class | objects | on device |
| --- | ---: | ---: |
| Texture2D | 2,359 | 6536.6 MiB |
| ParticleSystem | 94,450 | 680.0 MiB |
| MonoBehaviour | 535,264 | 507.8 MiB |
| Mesh | 6,386 | 437.3 MiB |
| SpriteRenderer | 791,606 | 151.0 MiB |
| Transform | 1,180,829 | 87.7 MiB |
| GameObject | 1,182,902 | 76.2 MiB |
| Sprite | 18,548 | 67.7 MiB |
| Font | 31 | 44.4 MiB |
| ParticleSystemRenderer | 94,450 | 27.8 MiB |
| AudioClip | 8,931 | 1.5 MiB (payloads are the 416 MiB above) |
| VideoClip | 26 | 6 KiB (payloads are the 219 MiB above) |

Read that as: **the port is four fifths pictures and one fifth sound and
video.** 4.2 million objects are in the archive because the scene/prefab data
is shipped verbatim (every GameObject, transform, collider, particle system and
sprite renderer the game has), but that data is only ~1.56 GiB unpacked and
~240 MiB of the download.

## 4. Where the bytes actually go

Three things dominate:

1. **Sprite-atlas textures: 1107 MiB of the download (55.7 %), 6.5 GiB on
   device.** 474 of the 2,359 textures are 4 MiB or larger, and 79 of them are
   a full 32 MiB — `8192×4096` BC7 sprite atlases (`sactx-0-…`), the biggest
   single objects in the whole archive. The
   `collections` bundle is only 292 MiB compressed but unpacks to 1.9 GiB
   almost entirely out of them.
2. **Audio: 402 MiB (20.2 %).** 8,900+ clips, stored as MP4/AAC containers in
   `.resource` files (`audio-sfx`, `audio-hornetvoices`, `audio-hornetmusic`,
   `audio-voices`).
3. **Cutscenes: 217 MiB (10.9 %).** The `cinematics` bundle is one entry whose
   payload is 43 MP4 movies (218.8 MiB, no recompression possible).

## 5. 479 MiB of the download is the same atlases shipped twice or more

Hashing every texture object ≥ 1 MiB (904 objects, 6.19 GiB) shows **85 atlases
that are byte-for-byte identical across bundles** — same sha256, shipped 2–11
times each:

| texture | copies | shipped | one copy |
| --- | ---: | ---: | ---: |
| `sactx-0-8192x4096-BC7-Core-a9c0f618` | 11 | 352 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-Memory-b915953c` | 6 | 192 MiB | 32 MiB |
| `sactx-0-8192x4096-BC7-Weave-7e266ec4` | 6 | 192 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-Shellwood-c2c96a02` | 5 | 160 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-Cradle-327dba4c` | 5 | 160 MiB | 32 MiB |
| `sactx-0-8192x4096-BC7-Under-af9b91f9` | 5 | 160 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-Peak-9f1e44cf` | 5 | 160 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-Bell-896caa1d` | 5 | 160 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-Cog-2c181a31` | 4 | 128 MiB | 32 MiB |
| `sactx-0-8192x4096-BC7-Jail-cffa0043` | 4 | 128 MiB | 32 MiB |
| `sactx-0-8192x4096-BC7-Grey-311b2c9f` | 4 | 128 MiB | 32 MiB |
| `sactx-0-4096x8192-BC7-HBone-496f12e3` | 4 | 128 MiB | 32 MiB |
| **85 duplicated atlases** | | **3735 MiB** | **962 MiB** (2773 MiB redundant) |

That is **2.77 GiB of duplicated texture data on device, ≈479 MiB (24 %) of the
1986.6 MiB download** — the same atlas bytes, deflated into separate ZIP
entries, so nothing can deduplicate them on the wire.

Note: the 350-odd small textures named `atlas0`/`atlas1`/`atlas2` in
`collections`/`prefabs` are *not* duplicates — same name, different pixels
(the sprite packer reuses those names). Only content-hash matches are counted
above.

## 6. Why the existing "smaller archive" path saves nothing here

`js/zip-plan.js` decides what to leave out by name and by the first bytes of an
entry: a video file (`.webm`, `ftyp`/EBML magic) or another platform's
`aa/<platform>/` bundle. Run against these 21 entries,
`isVideoEntry()`/`isOtherPlatformEntry()` return **false for all of them** —
they are all `packed-*.bundle` UnityFS files. The cutscene videos in this build
are not loose files at all; they live *inside* `cinematics` as `.resource`
payload, and the audio is inside four more bundles the same way.

For the untouched upstream source, the page's ZIP-pruning planner would keep
all 21 bundles, because the media is embedded inside them. The published
art-preserving rebuild instead replaces the 26 streamed cutscene payloads in
`cinematics` with placeholders before making the ZIP; see §7. The planner still
applies to builds whose videos and other-platform bundles are separate entries.

## 7. The art-preserving published archive

The upstream measurements above were used to rebuild the pinned archive with
[`tools/slim-archive/`](tools/slim-archive/README.md). Texture replacement is
**off by default**: all original Texture2D and sprite-atlas art is retained.
The lossy `--textures` option remains available only as an explicit opt-in.

| change | how | result |
| --- | --- | ---: |
| 26 streamed cutscene-video payloads | replaced in place with the ~600-byte blank MP4 and zero-padded; audio is untouched | 224,097,829 bytes stubbed |
| 6,386 meshes | vertex/index payloads zeroed in place; object counts and offsets retained | 456,033,780 bytes zeroed |
| all Texture2D payloads and original art | no texture edits; `--textures` was not used | preserved |

The 21 bundles total **2,486,528,891 → 2,080,369,134 bytes**
(**2371.3 → 1984.0 MiB**). The deflate ZIP is
**2,083,139,638 → 1,847,328,572 bytes** (**1986.6 → 1761.75 MiB**, 111 parts
of 16 MiB; the final part is 1,834,812 bytes). All ZIP entry CRCs pass, the ZIP
contains the same 21 bundle names as the upstream source, and concatenating the
111 delivery parts reproduces the ZIP byte-for-byte. The original uncompressed
UnityFS streams for `sprites-ui`, `sprites-scenery`, `sprites-hero`, and
`collections` match their upstream versions by SHA-256, confirming that their
art and texture payloads were not altered. The pipeline's class/object layout
remains size-preserving; videos and meshes are the only intended content edits.
The new `cacheKey` also makes the loader remove the prior texture-stripped ZIP
and any cached lazy-part shards before fetching this replacement.

The removed atlas duplicates and meshes are *not* blanked from the published
build: that was the prior lossy texture behavior. Dropping the four audio
bundles or `packed-collections` would remove content and is not done here.

## 8. What could be cut (measurements first, changes second)

The estimates below are based on the original upstream archive unless they
explicitly name the current ZIP; they are not additional savings already taken
by the published art-preserving rebuild.

| option | saves | cost |
| --- | ---: | --- |
| Leave the `cinematics` bundle out | ~217 MiB in the original; only 5,183,665 compressed bytes in the current ZIP because video payloads are already placeholders | One entry, but Unity's Addressables load of that group has to be handled — needs testing on device |
| Ship the 85 duplicated atlases once, in a shared Addressables group | ~479 MiB (24 %) of the original download, 2.8 GiB on device | Requires a rebuild of the archive from the Unity project; the current archive preserves every copy and its art |
| Lower the max sprite-atlas size (8192 → 4096) or re-encode textures | potentially >1 GiB of the original download | Rebuild; changes art crispness |
| Re-encode the audio (AAC bitrate) | up to ~400 MiB | Rebuild; quality loss |
| Trim audio/UI groups for a "training" playthrough | ~600 MiB | Rebuild; the game would be missing content |

The first two are about 700 MiB of the original 1986.6 MiB — a third of that
source download — and neither is visible from the entry names alone.

## 9. How these numbers were produced

The source archive was fetched from the pinned GitHub commit through the GitHub
API; no game payloads are committed under `web/`. The art-preserving output is
published as parts under the new `art-preserved-20261017` tag, with the exact
publish commit pinned by `community-build.json` (the tag contains assets only,
never a working-tree ZIP).

1. The 100 upstream `WebGL.zip.partN` blobs total 2,083,139,638 bytes. The
   ZIP central directory lists 21 entries; every extracted bundle passed its
   ZIP CRC check.
2. Each bundle is parsed as UnityFS: the header and block/node tables are
   **big endian** (including Unity 6's 16-byte alignment and `0x200` block-info
   padding flag); serialized files inside use the version-22 layout and their
   documented byte order.
3. `bundle_tool.py` reads each bundle's block, node, type and object tables;
   `treetools.py` uses UnityPy's type-tree parser and `typetree_read.py` walks
   object fields. The rebuild streams edited bundle blocks to disk and records
   exact before/after bytes in its stats JSON.
4. The ZIP was rebuilt with 21 entries and verified with `zipfile.testzip()`;
   all 111 split parts concatenate to the same SHA-256 as the complete ZIP.
   The uncompressed UnityFS streams of four art-bearing bundles were also
   SHA-256-compared to upstream and matched exactly.

The rebuilding dependencies are `lz4`, `xxhash` and `UnityPy`; install them
with `pip install lz4 xxhash UnityPy`. The upstream analysis tables in §§1–5
refer to the original source, while the pinned published rebuild's metrics are
in §7.
