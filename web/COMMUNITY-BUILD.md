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
- The Addressables ZIP is split into 100 files totalling exactly
  `2,083,139,638` bytes (about `1.94 GiB`). The player streams those pieces to
  Safari's Origin Private File System (OPFS), where downloads can resume after
  an interruption. Four parts are on the wire at a time — one part at a time
  means a hundred round trips, which is minutes of waiting on a phone — and
  each part is written to disk at its own offset as it arrives, so the queue
  costs a few chunks of RAM rather than a few parts.
- **Most of that archive is never downloaded.** Before the download starts, the
  player reads the ZIP's own index (its central directory) with two small byte
  range requests, works out which files inside it are needed, and then fetches
  only those — see [The smaller archive](#the-smaller-archive) below.
- `zip.js` reads the archive from OPFS and extracts only the bundle Unity asks
  for; the page does not concatenate the ZIP or unpack all bundles in RAM.
- A cutscene request is answered with a ~600-byte blank container (the same
  one `prepare-build.mjs` writes into a prepared build) instead of the real
  video. The upstream archive still holds the high-definition cutscenes, and
  inflating one of those into a Blob is more memory than a phone tab has to
  spare. The cutscene plays as a black frame.

The first run therefore needs Wi-Fi, a normal (non-Private) Safari tab, and
roughly 2 GiB of free storage. Leave the tab in the foreground. Later runs reuse
the cached archive. If OPFS or the available quota is insufficient, the player
will explain that rather than trying to put a multi-gigabyte ZIP in RAM.

## The smaller archive

The published archive is one 1.94 GiB ZIP, and a good part of it is the
high-definition cutscenes — the very files the player answers with a
placeholder instead of the real bytes. Downloading them is an hour on a phone
and a gigabyte of storage nobody can use.

So the player looks before it leaps. A ZIP keeps its index (the *central
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

The game payload remains hosted at the pinned external source; it is **not**
committed under `web/Build/`. This avoids a multi-gigabyte repository and lets
the existing iPad page continue to handle the files as a low-memory stream. The
source descriptor contains the exact commit, file sizes, and URLs. Update that
descriptor together if the upstream build changes. The site requires access to
the source CDN at runtime.

To disable this fallback and use only a prepared local/CDN build, add
`?community=0` to the play URL. To point this community build at a mirror, use
`?communityBase=https://your-host/path/` (the mirror must preserve the source
paths and serve the Unity `.unityweb` files and split ZIP parts unchanged).

`zip.js` is distributed under the BSD 3-Clause license; the license notice is
in [`js/zip-LICENSE.txt`](js/zip-LICENSE.txt).

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
