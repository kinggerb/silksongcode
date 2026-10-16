# What the 1986.6 MB community build is actually made of

The first run of `play.html` downloads the pinned Addressables archive from
[`web-ports/hollow-knight-silksong`](https://github.com/web-ports/hollow-knight-silksong)
(`bcbe0147`), and the page reports **1986.6 MB** — exactly
`2,083,139,638` bytes (`1986.6 MiB` / `2083.1 MB`). This document is a measured
breakdown of those bytes: every number below was read out of the archive itself
(the ZIP central directory, then each UnityFS bundle's block table, type list
and object table), not estimated from names.

Measured on the archive as published; the survey method is described at the end.

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
passes on top of it**. The 21 bundle files total 2.37 GiB on disk; the game data
inside them is 9.45 GiB, which is what the tab ends up holding (and, one bundle
at a time, what it must be able to hold).

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

So the page downloads the whole 1986.6 MiB, prints that figure, and the
cutscene placeholder only fires later, when Unity asks for a video URL. The
pruning in the docs (`COMMUNITY-BUILD.md` §"The smaller archive") is written
for builds whose videos are separate entries.

## 7. What was cut

The measurements above turned into the pinned archive in
[`tools/slim-archive/`](tools/slim-archive/README.md), rebuilt and republished
as described in [`COMMUNITY-BUILD.md`](COMMUNITY-BUILD.md) §"The slim archive".

| change | how | removed |
| --- | --- | ---: |
| the 43 cutscene MP4s (217 MiB, of which 26 are `VideoClip` payloads) | the 26 streamed MP4s are overwritten in place with the ~600-byte blank container and zero-padded | 224 MB |
| the 85 duplicated atlas groups (2,773 MiB redundant) | every copy after the first is emptied in place — same size, same format, one flat colour | 2,789 MB |
| 6,386 meshes | vertex/index blobs zeroed, counts kept | 435 MB |
| audio (402 MB), `packed-collections` (1,833 MB of unique atlases), animation | left alone | — |

Bundles 2,486.5 MB → 1,426.8 MB; ZIP `2,083,139,638` → `1,252,071,320` bytes
(**1986.6 MB → 1194.1 MB**, 75 parts of 16 MiB). Every edit is
size-preserving, and the rewritten bundles were re-read with an independent
parser (and UnityPy) to confirm the object tables, texture payloads and mesh
counts survive: 344/344 objects in `sprites-ui`, 70/70 in `cinematics`, mesh
vertex counts unchanged with zeroed data.

Two options in the table below are *not* taken, because they remove content
rather than redundancy: dropping the four audio bundles (402 MB) and
`packed-collections` (1,833 MB of unique art atlases, 334 MB of download).

## 8. What could be cut (measurements first, changes second)

| option | saves | cost |
| --- | ---: | --- |
| Leave the `cinematics` bundle out (43 MP4s, black-frame placeholders as today) | ~217 MiB (10.9 %) | One entry, but Unity's Addressables load of that group has to be handled — needs testing on device |
| Ship the 85 duplicated atlases once, in a shared Addressables group | ~479 MiB (24 %) of the download, 2.8 GiB on device | Requires a rebuild of the archive from the Unity project |
| Lower the max sprite-atlas size (8192 → 4096) or re-encode textures | potentially >1 GiB of the download | Rebuild; changes art crispness |
| Re-encode the audio (AAC bitrate) | up to ~400 MiB | Rebuild; quality loss |
| Trim audio/UI groups for a "training" playthrough | ~600 MiB | Rebuild; the game would be missing content |

The first two are 700 MiB of the 1986.6 MiB — a third of the download — and
neither is visible from the entry names alone.

## 9. How these numbers were produced

Everything was read out of the published *upstream* archive; no game files are
committed under `web/`. The trimmed copy that §7 describes is published from
this repository as a tag (`assets` only, never a working-tree file).

1. The 100 `WebGL.zip.partN` files (2.08 GiB) come from the pinned commit; each
   part is one blob from the GitHub API.
2. The ZIP central directory (last 64 KB of `part100`) lists 21 entries with
   their compressed/uncompressed sizes and offsets; each entry is inflated
   (raw deflate) and verified against the index byte count.
3. Each bundle is parsed as UnityFS: the header and the block/node tables are
   **big endian** (with the 16-byte alignment before the blocks info, and the
   `0x200` "block info padded" flag that Unity 6 sets), the serialized files
   inside are **little endian** — header fields big endian, payloads little —
   with the version-22 header layout (`u32` metadata size, `i64` file size,
   `i64` data offset, one extra `i64`). Verified per file against
   `metadata_size`/`file_size`.
4. Only the metadata region of each node is decompressed, so a 3.2 GiB stream
   is measured without holding it; per-class byte totals are the sums of the
   object-table `byte_size` values, and `.resource` nodes are counted
   separately (they are MP4/AAC and MP4 movie data — `ftyp`/`moov`/`mdat`).
5. Duplicates are full sha256 hashes of each texture object ≥ 1 MiB.

The survey scripts live in the (git-ignored) `.tmp/survey/` directory of this
working copy: `deep_survey.py` (the bundle/object walk), `hash_textures.py`
(duplication), `final_report.py` and `make_tables.py` (the tables above). They
need `lz4` and a local copy of the 21 bundles; ask if you want them committed
under `web/tools/`.
