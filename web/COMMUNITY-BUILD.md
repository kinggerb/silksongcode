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

## What the page loads

- Unity loader, framework, data, and wasm files are fetched from the pinned
  source CDN.
- The Addressables ZIP is split into 75 files totalling exactly
  `1,252,071,320` bytes (about `1.17 GiB`). It is the *slim* rebuild of the
  upstream archive (see [The slim archive](#the-slim-archive)) and lives in
  this repository, published under the `slim-assets` tag and served by
  `raw.githubusercontent.com`, with jsDelivr recorded as a mirror (see [Two
  hosts for the archive parts](#two-hosts-for-the-archive-parts)). The player
  streams those pieces to Safari's Origin Private File System
  (OPFS), where downloads can resume after an interruption. Six parts are on
  the wire at a time — one part at a time means dozens of round trips, which is
  minutes of waiting on a phone — and each part is written to disk at its own
  offset as it arrives, so the queue costs a few chunks of RAM rather than a
  few parts.
- **There is nothing left to leave out of it**, so the player skips the
  planning step entirely (`assetArchive.slim`). The same code path still
  prunes the upstream archive for anyone who points the descriptor back at it —
  see [The smaller archive](#the-smaller-archive) below.
- `zip.js` reads the archive from OPFS and extracts only the bundle Unity asks
  for; the page does not concatenate the ZIP or unpack all bundles in RAM.
- A cutscene request is answered with a ~600-byte blank container (the same
  one `prepare-build.mjs` writes into a prepared build) instead of the real
  video. The upstream archive still holds the high-definition cutscenes, and
  inflating one of those into a Blob is more memory than a phone tab has to
  spare. The cutscene plays as a black frame.

The first run therefore needs Wi-Fi, a normal (non-Private) Safari tab, and
roughly 1.3 GiB of free storage. Leave the tab in the foreground. GitHub rate
limits unauthenticated downloads, so a download can be made to pause part-way
through — the player waits it out and carries on rather than stopping; see
[A 403 in the middle of the download](#a-403-in-the-middle-of-the-download).
Later runs reuse the cached archive. If OPFS or the available quota is
insufficient, the player will explain that rather than trying to put a
multi-gigabyte ZIP in RAM.

## The slim archive

The pinned archive is a rebuilt copy of the upstream one: `tools/slim-archive/`
reads each bundle, edits it **in place** — object rows, offsets and the
decompressed stream layout never move, so Unity still sees 4.2 million objects
with the same path ids — and writes the bundles into a new, ordinary ZIP that
the page reads exactly as before.

| what | how | removed |
| --- | --- | --- |
| the 26 cutscene MP4s in `packed-cinematics` | replaced by the same ~600-byte blank MP4 the page already serves for a cutscene, zero-padded to the original length | 224 MB |
| 85 byte-identical sprite-atlas groups (`sactx-0-8192x4096-BC7-Core` alone ships eleven times) | every copy after the first is emptied out in place: same size, same format, same name, and it renders as one flat colour | 2,789 MB |
| 6,386 meshes (a 2D game never draws the 3D geometry) | vertex and index blobs zeroed, counts and packing metadata kept, so the mesh still loads | 435 MB |
| audio (402 MB), the art-collection atlases (1,833 MB, every one unique), animation data | left alone | — |

Bundles: 2,486.5 MB → 1,426.8 MB. ZIP: `2,083,139,638` → `1,252,071,320`
bytes, i.e. **1986.6 MB → 1194.1 MB**, which is the figure the page shows
before the first download. The parts are 16 MiB each (75 of them) so that
`raw.githubusercontent.com` can serve them, whose limit is 100 MB per blob.
jsDelivr's limit is on the *package* rather than the part, and 1.19 GB is over
it — see [Two hosts for the archive parts](#two-hosts-for-the-archive-parts).

Rebuilding the archive and re-publishing it are one command each:

```sh
python3 tools/slim-archive/slim_pipeline.py bundles   # edit the bundles
python3 tools/slim-archive/slim_pipeline.py zip       # ZIP + parts + hashes
python3 tools/slim-archive/publish_assets.py --parts-dir <dir> --tag slim-assets
```

See [`tools/slim-archive/README.md`](tools/slim-archive/README.md) for the
details, including why the page's own pruning step is skipped for this archive.

## The smaller archive

> **Measured note (`bcbe0147`):** the checks below skip **0 of the 21 entries**
> of the upstream build. The archive holds only Addressables bundles — the
> 43 cutscene MP4s (217 MiB) are *inside* `packed-cinematics`, the audio
> (402 MiB) inside the four `packed-audio-*` bundles — so nothing matches the
> video/other-platform rules and the whole 1986.6 MiB is downloaded. The full
> byte-by-byte breakdown, including 479 MiB of duplicated sprite atlases, is in
> [`ARCHIVE-SIZE-BREAKDOWN.md`](ARCHIVE-SIZE-BREAKDOWN.md). The pruning path
> still applies to builds whose videos are separate entries (and to the
> prepared-build path, where `prepare-build.mjs` replaces loose videos).

The pinned archive is one 1194.1 MB ZIP of game data in 75 parts, dominated by
sprite-atlas textures (the 2,789 MB of duplicated atlases are already gone) and
audio (402 MiB); its 43 cutscene movies are 600-byte blanks inside
`packed-cinematics`. There is nothing left for the planning path below to leave
out of *this* archive — it says so (`assetArchive.slim`) and the page skips the
check — but it is still what stops a build that ships its videos and other
platforms as separate entries from paying for files the player never reads.

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
trimmed archive is published from this repository instead, as blobs under the
`slim-assets` tag — never as working-tree files, so no clone has to carry it —
and `assetArchive.base` pins the raw.githubusercontent.com URL that serves
them, with `assetArchive.mirror` recording the jsDelivr one. A published payload
does make the repository larger on GitHub's side (about 1.2 GB of history); drop
the tag with `git push origin :refs/tags/slim-assets` if that is ever unwanted.
The source descriptor contains the exact commit, file sizes, and URLs. Update
that descriptor together if the upstream build changes. The site requires
access to the archive host at runtime.

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
| `cdn.jsdelivr.net` | `assetArchive.mirror` | refuses a GitHub *package* larger than 150 MB, and this one is ~1.19 GB |

jsDelivr's refusal is per request rather than per package, and only for the
parts it has not already stored — so a download did not fail at the start. It
got as far as the first part jsDelivr had not cached and died there:

```
HTTP 403 for https://cdn.jsdelivr.net/gh/kinggerb/silksongcode@<pin>/parts/WebGL.zip.part6
```

six parts into seventy-five, with `Package size exceeded the configured limit
of 150 MB` in the body. The archive bytes were never the problem, and nothing
had to be rebuilt or re-published: only the order of the two hosts did.

So `assetArchive.base` is GitHub raw, and `assetArchive.mirror` is jsDelivr —
the host that always answers leads, and the CDN that is quicker *when* it
answers is the fallback. Both are pinned to the publish commit rather than to
the `slim-assets` tag, which can move.

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
and a part is one request. This archive is **75** of them, so a single first
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
> per-file limit; publishing the 75 parts as release assets (one release per
> publish, pinned by tag) would let the download run at full speed and leave
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
