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
  an interruption.
- `zip.js` reads the archive from OPFS and extracts only the bundle Unity asks
  for; the page does not concatenate the ZIP or unpack all bundles in RAM.

The first run therefore needs Wi-Fi, a normal (non-Private) Safari tab, and
roughly 2 GiB of free storage. Leave the tab in the foreground. Later runs reuse
the cached archive. If OPFS or the available quota is insufficient, the player
will explain that rather than trying to put a multi-gigabyte ZIP in RAM.

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
