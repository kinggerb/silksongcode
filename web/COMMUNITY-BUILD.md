# Community WebGL build source

The iPad player has two build modes:

1. A prepared build in `web/Build/build-manifest.json` takes priority.
2. If that manifest is absent, the player uses the pinned source described in
   [`community-build.json`](community-build.json).

The community source is the WebGL build in
[`web-ports/hollow-knight-silksong`](https://github.com/web-ports/hollow-knight-silksong)
at commit `bcbe014765f2f6ca4b1d82ac25755a0299a600ab`. The related
[`indiamonda/silksong`](https://github.com/indiamonda/silksong) repository is a
fork in the same project lineage. This source was selected at the repository
maintainer's request, with their stated permission to reuse it.

## Lazy loading (opt-in; eager is the default)

By default, the player downloads the complete art-preserving ZIP to OPFS before
Unity starts; the ZIP is never concatenated in RAM. `?assets=lazy` opts into
on-demand parts and bundle extraction, with a bounded extracted-bundle cache
and native Wasm compilation overlapping asset setup. Synthetic integration
tests cover requested-bundle delivery and visible failures, but a complete
real-game/browser boot has not yet proven every startup dependency, so lazy
loading is not the default. See [LOADING-OPTIMIZATIONS.md](LOADING-OPTIMIZATIONS.md)
for implementation, tests, alternate hosting, direct bundles and controls.

## What the page loads

- Unity loader, framework, data, and wasm files are fetched from the pinned
  source CDN.
- The Addressables ZIP is split into 111 files totalling exactly
  `1,847,328,572` bytes (**1.72 GiB**; the page displays `1761.7 MB`). It is the
  art-preserving rebuild of the upstream archive (see [The slim archive](#the-slim-archive)),
  published under the `art-preserved-20261017` tag and pinned to commit
  `a2c4553a3e40ee536672eabb39341856e0ba35ee`. GitHub raw serves the parts and
  jsDelivr is recorded as a mirror (see [Two hosts for the archive parts](#two-hosts-for-the-archive-parts)).
  Eager mode streams all 111 parts to OPFS before Unity starts. In opt-in lazy
  mode, only the parts covering ZIP metadata and requested bundles are fetched.
  Up to six parts download at a time (configurable 1–8), streamed to disk with
  bounded write buffers. Completed pieces survive reloads.
- The archive is already slim (`assetArchive.slim`), so the historical pruning
  step below is skipped. Eager delivery remains default until a full game run
  proves the lazy dependency set; `?assets=lazy` prioritizes requested bundles.
- `zip.js` extracts requested bundles and verifies their CRC, surfacing failed
  reads in the page UI. Extracted output is cached within a quota-aware budget.
  The ZIP is never concatenated in RAM.
- A cutscene request is answered with a ~600-byte blank container (the same
  one `prepare-build.mjs` writes into a prepared build) instead of the real
  video. The 26 streamed video payloads were stubbed in the rebuilt archive;
  cutscenes therefore play as black frames. Audio payloads remain unchanged.

The first run therefore needs Wi-Fi, a normal (non-Private) Safari tab, and
at least **1.72 GiB** of free storage for the eager archive, plus headroom for
extracted bundles and Unity. Leave the tab in the foreground. GitHub rate
limits unauthenticated downloads, so a download can be made to pause part-way
through — the player waits it out and carries on rather than stopping; see
[A 403 in the middle of the download](#a-403-in-the-middle-of-the-download).
On the first run after this archive update, the descriptor's new cache key
causes the loader to remove the old texture-stripped ZIP and its cached lazy
parts before downloading; save data and unrelated OPFS files are not cleared.
Later runs reuse the new cached parts/extracted bundles (or an existing complete
archive). If OPFS or the available quota is insufficient, the player explains
that rather than trying to put a multi-gigabyte ZIP in RAM.

## The slim archive

The pinned archive is a rebuilt copy of the upstream one: `tools/slim-archive/`
reads each bundle, edits it **in place** — object rows, offsets and the
size-preserving serialized layout stay in place — and writes the bundles into
a new ordinary ZIP. Texture replacement is **off by default**, so the original
sprite-atlas art that was blanked in the bad archive is preserved. The lossy
`--textures` flag is an explicit opt-in; keep it off for publication.

| what | how | result |
| --- | --- | ---: |
| 26 streamed cutscene-video payloads in `packed-cinematics` | replaced with the same ~600-byte blank MP4 the page serves for a cutscene, zero-padded to original length | 224,097,829 bytes stubbed |
| all Texture2D and sprite-atlas art | no texture payload edits in the published build | preserved |
| 6,386 meshes (a 2D game never draws the 3D geometry) | vertex/index payloads zeroed; counts and packing metadata kept | 456,033,780 bytes zeroed |
| audio, all art-collection atlases, animation data | left alone | — |

Bundles: `2,486,528,891` → `2,080,369,134` bytes (**2371.3 → 1984.0 MiB**).
ZIP: `2,083,139,638` → `1,847,328,572` bytes (**1986.6 → 1761.75 MiB**), which
the page displays as `1761.8 MB`. The archive is split into 111 parts of at most
16 MiB (the final part is 1,834,812 bytes), so GitHub raw's 100 MB per-blob
limit is respected. jsDelivr's 150 MB limit applies to the whole package, and
1.72 GiB exceeds it — see [Two hosts for the archive parts](#two-hosts-for-the-archive-parts).

The published archive was rebuilt and verified with ZIP CRC checks, exact
source/output bundle names, matching concatenated-part and ZIP SHA-256 hashes,
and matching uncompressed UnityFS streams for four art-bearing bundles. The
new parts live under the `art-preserved-20261017` tag; the descriptor pins the
publish commit so a moved tag cannot change the downloaded bytes.

```sh
python3 tools/slim-archive/slim_pipeline.py bundles --src bundles --out slim \
  --placeholder placeholder.mp4
python3 tools/slim-archive/slim_pipeline.py zip --src slim --out slim.zip \
  --parts-dir parts --part-size 16777216
python3 tools/slim-archive/publish_assets.py --parts-dir parts \
  --tag art-preserved-20261017
```

See [`tools/slim-archive/README.md`](tools/slim-archive/README.md) for the
source-fetch, dependencies, rebuild, verification and publish details.

## The smaller archive

> **Measured note (`bcbe0147`):** the pruning checks below skip **0 of the 21
> entries** of the untouched upstream build. It contains only Addressables
> bundles — the cutscene MP4s are inside `packed-cinematics` and audio is inside
> four `packed-audio-*` bundles — so those entry-level rules cannot omit them.
> The published art-preserving rebuild instead stubs the 26 streamed video
> payloads inside the bundle. The full source breakdown, including the 479 MiB
> of duplicated atlases, is in
> [`ARCHIVE-SIZE-BREAKDOWN.md`](ARCHIVE-SIZE-BREAKDOWN.md). The pruning path
> still applies to builds whose videos are separate entries (and to the
> prepared-build path, where `prepare-build.mjs` replaces loose videos).

The pinned art-preserving archive is `1,847,328,572` bytes (**1.72 GiB**, 111
parts). It keeps all sprite-atlas textures, including the byte-identical atlas
copies, and the 402 MiB of audio. Its cutscene-video payloads are placeholders;
mesh payloads are zeroed. The archive is marked `assetArchive.slim`, so the
historical planning step below is skipped. Eager full-ZIP delivery remains the
default; `?assets=lazy` opts into requested-bundle loading and is not yet
verified by a complete real-game boot.

For such a build the player looks before it leaps. A ZIP keeps its index (the *central
directory*) at the end of the file, and that index says where every file
inside it lives. Two small range requests — the last 64 KB and the directory
itself — are enough to read it, and they cost a few hundred kilobytes instead
of two gigabytes.

With the index in hand the player:

1. **Decides what to leave out.** The cutscenes (by name, and by the bytes at
   the start of the file: a Unity bundle starts with `UnityFS`, a video with
   `ftyp` or the WebM magic) and any bundle for another platform (a WebGL
   build never loads one). The bytes are only looked at for the big files, and
   the result is remembered, so it is a one-off.
2. **Fetches only what is left**, in byte ranges of the published parts, and
   writes the files it kept into a new, smaller ZIP. The files are copied byte
   for byte — nothing is recompressed, so the game data cannot be damaged —
   and the ZIP's directory is rewritten to match the new offsets.
3. **Serves the cutscenes from the placeholder** as before, so a file that is
   no longer in the archive is answered rather than 404'd.

The result is an ordinary ZIP: `zip.js` reads it exactly as it reads the
published one, and the file on the device is smaller as well as the download.
The page shows the real figure once the index has been read.

If anything about this does not work — the CDN does not honour byte ranges,
the archive is not shaped the way we expect, the index cannot be read — the
player falls back to downloading the whole archive, exactly as before. The
pruning is an optimisation, never a requirement.

`js/zip-plan.js` does the reading and the planning; `js/stream.js` moves the
bytes; `js/community-build.js` ties them together. `tools/test-zip-plan.mjs`
checks the whole thing against an archive built with `zip.js`: that the index
is read with two small requests, that the cutscenes are the files that are left
out, that the files that are kept come out byte for byte the same, that the
new archive is smaller, that a download of it can be resumed, and that a CDN
without byte ranges gets the whole archive instead.

The build files (`Build/*.unityweb`, the loose StreamingAssets) remain hosted at
the pinned external source; they are **not** committed under `web/Build/`. The
art-preserving archive is published from this repository as blobs under the new
`art-preserved-20261017` tag — never as working-tree files — and
`assetArchive.base` pins the publish commit on raw.githubusercontent.com, with
`assetArchive.mirror` recording the jsDelivr URL. This publication adds about
1.72 GiB of GitHub-side blobs; the prior bad archive/tag remains separate. The
source descriptor contains the exact commit, file sizes and URLs. Update that
descriptor together if the upstream build changes. The site requires access to
the archive host at runtime.

To disable this fallback and use only a prepared local/CDN build, add
`?community=0` to the play URL. To force a different home for the *archive*
only (for example the jsDelivr mirror recorded as `assetArchive.mirror`), add
`?archiveBase=https://host/path/`. To point this community build at a mirror, use
`?communityBase=https://your-host/path/` (the mirror must preserve the source
paths and serve the Unity `.unityweb` files and split ZIP parts unchanged).

`zip.js` is distributed under the BSD 3-Clause license; the license notice is
in [`js/zip-LICENSE.txt`](js/zip-LICENSE.txt).

## Two hosts for the archive parts

The parts are published once, and two hosts serve them — but not equally:

| host | recorded as | the limit that matters |
| --- | --- | --- |
| `raw.githubusercontent.com` | `assetArchive.base` | serves any committed blob under 100 MB, and a part is 16 MiB, so every part is served |
| `cdn.jsdelivr.net` | `assetArchive.mirror` | refuses a GitHub *package* larger than 150 MB, and this one is 1.72 GiB |

jsDelivr's refusal is per request rather than per package, and only for the
parts it has not already stored — so a download may not fail at the start. In
the earlier 75-part publication, it got as far as the first part jsDelivr had
not cached and died there:

```
HTTP 403 for https://cdn.jsdelivr.net/gh/kinggerb/silksongcode@<pin>/parts/WebGL.zip.part6
```

with `Package size exceeded the configured limit of 150 MB` in the body. The
current archive has 111 parts and the same package-size limitation; the archive
bytes are unchanged between the two hosts, so raw remains first and jsDelivr
only a fallback.

So `assetArchive.base` is GitHub raw, and `assetArchive.mirror` is jsDelivr —
the host that serves each part leads, and the CDN is the fallback. Both are
pinned to the publish commit rather than to the movable
`art-preserved-20261017` tag.

`js/community-build.js` wraps the fetch the downloader uses (`mirrorFetch`) so
that a part which is refused — 403, 404, 408, 429 or any 5xx — or whose host
cannot be reached at all is asked for **once** more from the mirror, at the
same path and with the same request, byte ranges included. Two rules keep that
safe: only a URL under the archive's own root is ever rewritten, and a URL that
is already on the mirror is never mirrored, so a download cannot ping-pong
between two hosts that are both refusing it. Both `stream.ensureDataset` calls
and the archive plan read through that one wrapper;
`tools/test-community-build.mjs` pins all of it.

## A 403 in the middle of the download

Raw leads because it serves every part — but not every *request*. GitHub rate
limits unauthenticated downloads (60 requests an hour per IP since
[May 2025](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)),
and a part is one request. This archive has **111** parts, so a single first
run can outrun the budget on its own, and the answer is the same `403` a
browser sees for a file it may not have:

```
HTTP 403 for https://raw.githubusercontent.com/kinggerb/silksongcode/<pin>/parts/WebGL.zip.part28
```

a third of the way in, with jsDelivr equally unwilling (its `403` is about the
package and never changes) and a few seconds of retries in between. Nothing was
wrong with the bytes: the parts already on the device were fine, and a reload
would have resumed from them — but no download was going to *finish*.

The two refusals look alike and are not:

| refusal | what it means | what the page does |
| --- | --- | --- |
| `403` / `429` from `raw.githubusercontent.com` | GitHub wants us to slow down | **waits it out** and asks again |
| `403` from `cdn.jsdelivr.net` | `Package size exceeded the configured limit of 150 MB` — about the package, true for every part it has not already cached | takes it as final, and stops asking the mirror for the rest of the download |
| anything else (404, 408, 5xx, an unreachable host) | this host, this moment | asks the mirror once, keeps the downloader's own backoff |

Waiting is bounded, because a pause costs the user's time even though it costs
nothing else: escalating pauses — 30 s, 1 min, 2 min, 5 min, then 15 min —
until a budget is spent, 90 minutes by default (`?archiveWait=<minutes>`
changes it; the seven first pauses add up to 53 minutes, so an hour would stop
a few minutes short of the very window it is waiting for). The budget is shared
by the whole download, and so is each pause: the six parts that are on the wire
at once wait *together* instead of each spending a request to be told the same
thing — refusals that arrive together are one round, not one escalation each.
A part that gets through starts the escalation over.

When GitHub says how long it wants — `retry-after`, or `x-ratelimit-reset` —
that is the wait, floored at five seconds and read at the moment the answer
arrives, so a part that sat behind another part's pause does not serve the same
hour twice. Cross-origin those headers are usually not readable, and then the
escalation is the guess.

When the budget runs out the page says so — and the parts already saved stay
saved, so starting again carries on from there.

The status line reads `GitHub is rate-limiting the download (HTTP 403) —
pausing 2 min. Nothing is lost, it carries on where it stopped.`, and the log
panel records every pause.

Two details make it safe: the waiting lives in the fetch wrapper, so the
downloader does not spend its own four retries (eight more requests) on a
refusal that has already been waited out — `archiveRetryAfter` gives up on a
rate limit at once and leaves every other failure to the usual backoff; and
`tools/test-community-build.mjs` runs the whole thing on a clock the tests
control, including a download that is refused from the fourth part of six and
still finishes.

> **The durable fix is to re-host the archive.** A waiting page is a page the
> user has to keep open. GitHub *release* assets are served from
> `objects.githubusercontent.com` with no per-hour request budget and a 2 GB
> per-file limit; publishing the 111 parts as release assets (one release per
> publish, pinned by version) would let the download run at full speed and leave
> raw and jsDelivr as fallbacks. That needs the bytes re-uploaded —
> `publish_assets.py` would gain a release path — not a page change.

## What the upstream loader expects from the page

The upstream `Build/w-pt.loader.js` is not stock Unity. Upstream serves it from
a page whose `<head>` carries
`<base href="https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@master/">`,
and `createUnityInstance` was changed to ignore the `streamingAssetsUrl` it is
given in favour of:

```js
b.streamingAssetsUrl = new URL("StreamingAssets", document.querySelector('base').href).href;
```

Without a `<base>` that line throws as soon as Unity is started, which on iPad
Safari reads `null is not an object (evaluating
'document.querySelector('base').href')` — after the whole archive has been
downloaded. A real `<base href>` cannot fix it: it would re-root every relative
URL of `play.html` onto the CDN. So `play.html` adds a `<base>` **without** an
`href` attribute, which does not change the document's base URL, and gives
that element an `href` property that answers with the community asset root
(the pinned `base`, or `?communityBase=`). The loader therefore computes the
same StreamingAssets URL the page passes anyway, and the element stays for the
life of the page in case anything reads it again later.
`tools/test-page.mjs` runs that exact upstream line against the page.

## The runtime patches (shell 1.2.0)

The pinned module declares a 2048 MiB initial wasm heap, which the browser
backs at instantiation — on top of the module itself, the first scene's
bundles and the GPU textures that follow. That is what jetsam-killed the
tab seconds after `engine ready`. Since shell 1.2.0 the page patches the
pinned binaries **in the browser, while they load** (`js/unity-startup.js`);
nothing is re-hosted and the pinned commit does not change:

| Patch | What it does | Verified against |
| --- | --- | --- |
| `wasm-initial-heap` | rewrites the memory section's initial-size LEB128 at offset 207746: 32768 pages → 24576 (1536 MiB default; `?wasmHeap=1280` or `1024`; safe mode 1024). The declared 4080 MiB maximum is untouched, so the heap still grows on demand. | inflated size 82,574,276 bytes + the 10-byte section window `05 08 01 01 80 80 02 80 fe 03` at 207742 |
| `unload-assets-always` | the unique 11-byte context at 52123552 ending in function #106897's `local.get 9; end` tail, forced to return true so room changes unload assets. Structural candidate, not a name lookup — IL2CPP strips names. | full context `20 0c 41 b0 04 6a 24 00 20 09 0b`; the bare tail occurs 309× and is never patched alone |
| framework `disconnectSource` | the Unity 6 audio-release patch (same output as `tools/patches.mjs`): a stopped channel gives its media-element decoder back instead of pinning it. | framework SHA-256, gzipped `03bf4bc6…` or plain `972cecea…` |

Every patch fails open: a context or digest mismatch is logged
(`wasm patch … skipped — …`) and the stock bytes load instead. The wasm
patches ride the verified streaming compile path (the page owns the byte
stream there); with `?streaming=0` the stock loader fetches the module
itself and the page logs that the heap starts at its compiled-in 2048 MiB.
Switches, for A/B-ing on the device: `?wasmHeap=<MiB>` (256–4080),
`?heapPatch=0`, `?unloadPatch=0`, `?frameworkPatch=0`,
`?wasmPatch=0`, `?bundleStream=0` (bundles go through an in-RAM Blob
again instead of a stream). The boot log lines to check:
`runtime patches requested: …`, then `wasm patch wasm-initial-heap:
applied`, then `game memory: 1536 MB of wasm heap`.

To host a pre-patched mirror instead (for a browser without the streaming
path), `tools/patch-community-wasm.mjs` writes patched, still-gzipped
`w-pt.wasm.unityweb` / `w-pt.framework.js.unityweb` from the pinned files;
serve the four `Build/` files anywhere static and point
`?communityBase=` at them. The runtime patcher recognises an
already-patched mirror and leaves it alone. The 111 asset parts are
never part of this — they are untouched in both modes.
