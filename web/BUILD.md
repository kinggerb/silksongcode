# Building and preparing the web port

For a prepared Unity build, the scripts in `web/tools/` validate and package
its browser assets. They never touch the game installation — the input build is
only ever read. The default community source is described separately below.

```
prepare-build.mjs   check → prune → replace cutscenes → patch → chunk → manifest
verify-build.mjs    sizes, digests, archive structure, entry points, page files
serve.mjs           static server with Range requests and correct MIME types
make-fixture-build.mjs   a synthetic build, for tests and for demo.html
```

GitHub Pages publishes this repository's root. The root `index.html` sends the
project homepage to `web/play.html` while preserving the query and hash, and the
root `.nojekyll` file prevents Jekyll from transforming the site. The page first
uses a prepared `web/Build/build-manifest.json` when one is present. If not, it
uses the pinned community WebGL source in `web/community-build.json`: Unity's
small compressed entry points are loaded from that source, and its roughly
1.94 GiB Addressables ZIP is streamed into OPFS and read bundle-by-bundle. The
game payload is not copied into this Git repository. See
[`COMMUNITY-BUILD.md`](COMMUNITY-BUILD.md) for storage, network, and source
notes. `?community=0` disables this fallback; with no local build, the page then
shows **Game build not found** and links to this guide and `demo.html`.

---

## 1. You need a Unity WebGL build

This repository contains the RL mods (`mods/`), the trainer (`trainer/`) and
the web port (`web/`), but not Silksong's original Unity project. For a prepared
local build, the tools expect Unity's WebGL output to look like this:

```
Build/
  <name>.loader.js        exports createUnityInstance
  <name>.framework.js     Unity's WebGL framework
  <name>.wasm             the IL2CPP module
  <name>.data             the UnityWebData1.0 archive
  StreamingAssets/…
```

That layout comes from Unity's **WebGL build target**; it cannot be produced
from an installed PC/console game or from this repository alone. The page now
also supports the separately prepared community WebGL source described above.
That source has a different compressed build/Addressables layout, so it is
loaded by the community adapter rather than by `prepare-build.mjs`. The fixture
below remains synthetic and is only for testing the generic preparation
pipeline — it does not contain game content:

```bash
node web/tools/make-fixture-build.mjs --out /tmp/unity-build --filler 40MB
node web/tools/prepare-build.mjs --build /tmp/unity-build --out /tmp/web-out --part-bytes 20MB
node web/tools/verify-build.mjs --out /tmp/web-out
```

---

## 2. What `prepare-build.mjs` does

```bash
node web/tools/prepare-build.mjs --build "<unity Build dir>" --out web
```

| Step | Detail |
| --- | --- |
| **check** | the loader really calls `createUnityInstance`, the framework looks like Unity, the wasm parses (magic, version, sections, function count), the data file is a `UnityWebData1.0` archive whose directory is readable, and every entry points inside the archive. A gzip/zip-wrapped `.data` is refused with an explanation. |
| **prune** | `.symbols`, `.debug.wasm`, `.map`, pre-compressed `.gz`/`.br` twins, `.unityweb`, `.bak`, editor leftovers and `TemplateData/` are left out. `--prune <glob>` adds, `--keep <glob>` protects, `--no-prune` disables. |
| **videos** | every cutscene in the archive is replaced by a tiny black placeholder (MP4 `ftyp`+`moov`+`mdat`, ~600 bytes; WebM EBML + a 2×2 `V_VP8` track, ~200 bytes) or truncated to its container head with `--video-strategy truncate --video-keep-bytes 65536`. The archive index is rewritten with the new sizes and offsets, so Unity still finds every file it asks for. |
| **patch** | framework fixes from `tools/patches.mjs` (release the `<audio>` source when a channel disconnects) and wasm byte patches from `web/patches/*.json` — each one verified against the bytes it expects, so a patch for another build is skipped, never guessed. |
| **chunk** | `data` and `wasm` are split into equal parts (default 20 MiB, `--part-bytes`) named `<name>.data.partN` / `<name>.wasm.partN`. |
| **manifest** | `Build/build-manifest.json` (schema 2) records every chunk's path, exact size and sha256, whole-file and head/tail digests, the entry-point paths, the patch list and a report of what was replaced. This is the only thing the page trusts. |

Useful flags: `--dry-run` (report only), `--json`, `--no-full-hash` (skip the
whole-file digest), `--align`, `--name`, `--list-videos`, `--scan [file]`.

### A 20 MiB chunk size, and why

Chunks are the unit of resume, of verification, and of the page's `Range`
probes. 20 MiB is small enough that a killed session loses little, large enough
that a 600 MB archive is ~30 requests, and small enough to hash in one go on an
iPad. Changing it only affects the page through the manifest.

---

## 3. What `verify-build.mjs` checks

```bash
node web/tools/verify-build.mjs [--quick] [--json]
```

1. the manifest parses and the arithmetic adds up (chunks → totals);
2. every chunk exists and is exactly the size the manifest claims;
3. every chunk hashes to its recorded sha256 (`--quick` skips this);
4. the **assembled** data still starts with `UnityWebData1.0`, and the whole
   file table is read back *across the chunk boundaries* and validated entry by
   entry;
5. the **assembled** wasm parses and reports its function count;
6. the loader, framework (and whether the room-audio patch is in it) and
   `StreamingAssets/` are present;
7. the page itself is complete (`play.html`, `js/*`).

Exit code 0 means the prepared build is complete and matches its manifest; 1
means something is wrong and the message says what. For prepared builds, the
page performs a cheaper version before downloading (one `Range` request per
chunk). The community mode instead checks its pinned descriptor and exact part
sizes, then lets zip.js validate/read the archive directory.

---

## 4. Patching the build (the memory work)

Some of the iPad-relevant fixes have to happen *inside* the build. Two kinds:

**framework.js** — implemented and applied automatically when they match
(`tools/patches.mjs`):

* *release the audio source*: `channel.disconnectSource` clears
  `mediaElement.src` and calls `load()`, and drops the framework's own
  pending-autoplay entry. Without it WebKit keeps every room's music decoder
  alive.
* *fix the undefined variable*: some framework versions log `error` inside a
  `catch(e)` block, so stopping a sound throws `ReferenceError` — an unhandled
  error at exactly the wrong moment.

**wasm byte patches** — data, in `web/patches/*.json`. The one that matters is
the equivalent of the Hollow Knight port's fix:

```
GameManager.IsUnloadAssetsRequired()      compares memory against desktop
                                          limits (2.5 GB) a 32-bit wasm heap
                                          never reaches  →  always false  →
                                          Resources.UnloadUnusedAssets() never
                                          runs on a room change  →  memory
                                          grows with every room
```

`node web/tools/prepare-build.mjs --scan "<name>.wasm"` shortlists functions
whose body *ends* in `local.get N; end` and compares floating-point constants —
exactly the shape of that check. Confirm the candidate, then write the patch:

```json
{
  "for": "Silksong <version> · Unity <version>",
  "patches": [
    {
      "name": "unload-assets-always",
      "why": "room changes must run Resources.UnloadUnusedAssets",
      "offset": 6527956,
      "expect":  "20 01 0b",
      "replace": "41 01 0b"
    },
    {
      "name": "same, found by pattern",
      "mode": "search",
      "expect":  "20 01 0b",
      "replace": "41 01 0b"
    }
  ]
}
```

`expect` must equal the bytes at `offset` (or, with `mode: "search"`, exist
somewhere) — otherwise the patch is skipped and reported. `expect` and `replace`
must be the same length: a resize would move every offset in the module.

The archive viewer (`tools/unity-webdata.mjs`) has an `--list-videos` mode, the
wasm tools have `--scan`, and both print what they found before changing
anything.

---

## 5. Putting it on a static host

```bash
node web/tools/prepare-build.mjs --build "<unity Build dir>" --out web
node web/tools/verify-build.mjs --out web
node web/tools/serve.mjs 8080
```

This repository's GitHub Pages site serves the repository root; the root
`index.html` redirects visitors to `web/play.html`. The optional Actions
template remains at `web/ci/pages-workflow.yml` and is not installed under
`.github/workflows/` (which requires extra repository permissions). Note that
`web/Build/` is **git-ignored** by default: a prepared build is hundreds of MB
and does not belong in a code repository — publish it from a release, an object
store, or a CDN and point the page at it with `play.html?base=https://…/`. The
page and the tools only need that URL.

The host must:

* serve `application/wasm` for `.wasm` (Unity stream-compiles it otherwise);
* support `Range` requests;
* allow large responses (`client_max_body_size` is not the issue, but proxy
  buffering of a 600 MB body is — nginx: `proxy_buffering off`).

`tools/serve.mjs` does all three, which is why the docs point at it.
