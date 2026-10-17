# Optimized loading: implementation and validation

## Goal and status

The target is **three minutes or less to playable gameplay**, not merely to a
full progress bar. The loader now removes the full-archive-before-boot barrier,
repairs cache reuse, overlaps native Wasm compilation, and avoids repeated
bundle extraction where storage allows.

**This is not yet a measured three-minute Silksong/iPad result.** Real game
startup dependencies, bandwidth and device initialization determine the final
time. Browser integration uses the **exact pinned Unity loader**, but synthetic
game data/framework and a small real Wasm module; it is not a full-game test.

## Enabled by default

- **Read-only warm-cache lookup** before opening a writer. A storage probe can
  no longer truncate the real archive. Probes use the proper temporary file,
  close before removal, and are shared once per worker/directory per page.
- **Acknowledged worker shutdown**, removing the old five-second timeout.
- **Durable completed-part journals** for concurrent downloads. Sparse file
  length is never treated as a valid prefix or proof of completion. Old,
  unjournaled partial files are rebuilt; valid completed caches are preserved.
- **Lazy split-ZIP reader**: ZIP metadata and only parts covering a requested
  bundle are downloaded into OPFS. Requested bundle extents prefetch with up
  to six active downloads on a desktop and three on a phone or tablet
  (each in-flight part holds a 16 MiB buffer), configurable between one and
  eight. There is no automatic whole-game prefetch competing with startup.
- **Existing complete ZIP reuse**, without copying it into the new part cache.
  Corrupt legacy indexes/bundles invalidate that cache and recover through lazy
  parts instead of getting stuck on a bad old completion marker.
- **Bounded extracted-bundle cache**: at most 512 MiB by default; old unpinned
  entries are evicted oldest-first. Files already handed to Unity are pinned
  for the session. Web Locks serialize cross-tab writers; browsers without Web
  Locks can read existing extracted entries but use Blob extraction for misses.
  The optional cache declines writes when quota/budget is insufficient, falling back to normal ZIP-to-Blob extraction.
- **CRC-verified streaming extraction to disk**, with completion published only
  after CRC/length checks. Warm requests/ranges use the extracted file rather
  than inflating the entry again. SHA-256 part verification is used when the
  descriptor supplies digests (the original pinned descriptor has none).
- **Native streaming Wasm compilation overlapping asset setup**. The loader
  patch is enabled only after the exact upstream SHA-256 and unique patch
  locations match. Unknown loaders or unsupported native APIs use the stock
  Wasm path. The original loader is never guessed or blindly patched.
- **Native-decoding compatibility fix**: the pinned upstream gzip predicate
  always returned true, including on already HTTP-decoded JS/data. The verified
  patch checks gzip magic instead, preventing double decompression.
- **Versioned front-end/worker URLs** to avoid mixing an old cached downloader
  with the new lazy adapter immediately after deployment.
- **Preconnect and Unity data/framework preloads**, immutable Unity entry-point
  caching, and no second UnityCache copy of OPFS-managed bundles.
- **Header/body stall timeouts**, cancellation cleanup, shared refused-mirror
  state, and the existing bounded rate-limit waiting. Intentional backoff is
  not mistaken for a stalled body. Network failures still require retries;
  a three-minute target cannot override missing bandwidth/server refusals.
- **Prepared-build cache-first validation and parallel data/Wasm loading**,
  with failure cleanup and the existing integrity checks retained.
- **Stage timings**, bundle decode timings, reused/downloaded lazy-part byte
  counts, and persistence-grant diagnostics. `window.SKLoading.timings()`
  exposes milestones; a game-side bridge can call `SKLoading.markPlayable()`
  at its first controllable scene. Engine-ready is a separate milestone.

The current page caches by content/build identity, not the page deployment
revision, so changing front-end code does not invalidate unchanged game data.
Saves remain in their existing IndexedDB storage; asset-cache operations do not
clear saves.

## Controls and fallbacks

| Query | Meaning |
| --- | --- |
| `?assets=eager` | Original full-ZIP-before-boot path, now with cache/resume fixes |
| `?streaming=0` | Stock buffered Wasm path; verified gzip guard still applies |
| `?downloads=4` | Limit lazy part downloads (1–8; default 3 on a phone/tablet, 6 on a desktop) |
| `?bundleCacheMB=0` | Disable optional extracted-bundle disk cache |
| `?bundleCacheMB=256` | Set extracted cache budget (0–1024 MiB) |
| `?archiveBase=https://host/version/` | Byte-identical ZIP parts on another host |
| `?communityBase=https://host/version/` | Unity entry-file source override |
| `?communityConfig=https://host/community-build.json` | Alternate pinned descriptor |
| `?bundleBase=https://host/version/bundles/` | Direct raw LZ4 bundle host; descriptor index avoids even ZIP metadata parts |
| `?archiveWait=10` | Maximum rate-limit-wait budget in minutes (default 90); not a speed setting |

A lazy part is still a whole immutable source shard, so hosts that ignore Range
work without repeated whole-part downloads. This deliberately avoids hundreds
of tiny GitHub range requests. Startup may fetch a little boundary data from
adjacent bundles. Large bundles remain large: lazy transfer cannot split the
assets **inside** one compressed UnityFS bundle.

## Faster hosting, larger parts and direct bundles

This repository cannot provision/pay for an external CDN. The current pinned
host remains unchanged until byte-identical or repackaged assets are actually
uploaded elsewhere. A descriptor override alone does not upload anything.

`tools/package-assets.py` packages an existing authorized ZIP **without changing
any game objects, textures, audio, meshes or references**:

```sh
# Preserve the original ZIP bytes, but produce fewer/larger delivery shards.
python3 web/tools/package-assets.py --zip /path/slim.zip \
  --out web/optimized-assets \
  --asset-base https://assets.example/silksong/v1/ \
  --compression preserve --part-mib 32

# Alternative: remove outer deflate and publish raw UnityFS/LZ4 bundles too.
# Use a separate empty output directory for each packaging experiment.
python3 web/tools/package-assets.py --zip /path/slim.zip \
  --out web/optimized-assets-direct \
  --asset-base https://assets.example/silksong/v2/ \
  --compression store --part-mib 64 --bundles \
  --bundle-base https://assets.example/silksong/v2/bundles/
```

Use an ignored/external directory for all game payloads (only
`web/optimized-assets/` is newly ignored by default). Do not commit generated
multi-GB output. The tool refuses nonempty output directories and unsafe ZIP
paths, checks source CRCs, and emits:

- delivery parts with exact byte counts and SHA-256;
- a content-versioned `community-build.json`;
- a small `zip-index.json` with entry sizes/CRCs;
- optional byte-identical raw bundles.

Upload the output to the actual host, then test with `communityConfig=` or
replace the deployed descriptor deliberately. With `bundleBase` and the index,
**no ZIP parts are needed**: requested raw bundles stream directly to OPFS and
are checked against their ZIP CRC. Direct bundle paths support nested folders.
Do not enable direct mode unless the raw files really exist at that URL.

`--compression store` trades more download bytes for less outer decompression;
compare cold and warm performance before choosing it. The original repository
figures suggest about 14% extra full-transfer bytes, so it can lose on slow
connections even while improving warm loads. Raw UnityFS LZ4 compression stays
intact. `--compression deflate` is available for a lossless comparison too.

The bundled server now supports correct Wasm/Unity MIME and native gzip
headers, CORS, exposed Range/encoding headers, Timing-Allow-Origin, conditional
ETags, correct/clamped byte ranges and empty-file handling. Mutable HTML/JS/JSON
revalidate. Content-addressed asset paths are immutable; for a separately
versioned asset root you control, set `IMMUTABLE_ASSETS=1`. Never enable that for
mutable asset filenames you overwrite in place.

GitHub Pages/third-party CDN headers are not controlled by this Node server.
For production object storage/CDN configure the equivalent headers there.

## Validation performed

- `cd web && npm ci && npm test`: **187 tests across ten suites** (baseline 156,
  plus delivery/packaging and loading regressions). Covers real writer code
  through a storage model, out-of-order interruption/recovery, exact build
  matching, timeouts, CRC, digests, budgets, lazy reads, direct bundles and
  preserve/STORE/deflate repackaging.
- `npm run test:browser`: Chromium with **real OPFS synchronous-access workers**,
  Cache API, IndexedDB, native decompression and Wasm. Exact upstream loader
  digest/hook is exercised, not a lookalike loader. Cold lazy, warm lazy, eager,
  warm eager, stock-Wasm fallback, raw gzip, native HTTP gzip, ranges, saved
  data retention, two simultaneous cold tabs with shared cache pins, and stalled
  body cleanup pass without uncaught page errors.
- Synthetic browser fixture: **374,370 of 1,160,802 archive bytes** fetched
  before cold ready (32.3%); **zero archive bytes on warm ready**. Observed local
  fixture timings were subsecond after warm-up. These are functional/transfer
  regression results, **not full-game or iPad performance claims**.
- The actual pinned 20,192,325-byte Wasm gzip was natively decoded to
  82,574,276 bytes and stream-compiled successfully in Node (629 imports, 623
  exports). This validates the binary/decode path, not gameplay startup.
- `web/ci/loading-tests-workflow.yml` provides a GitHub Actions template for
  the suites and synthetic real-browser integration. To activate it, an account
  with workflow-edit permission must copy it to `.github/workflows/web-tests.yml`.
  The connected GitHub app cannot install workflows; validation for this change
  was run locally, not through an active Actions workflow.

## Follow-up (shell 1.1.1): force WebGL 2, pin the canvas buffer

Fast initialization succeeded on the target iPad and the game still showed a
black screen at 0 fps: `ERROR frame callback: GPUCanvasContext.configure:
Unable to configure. render target: 9440×5872 for a 1180×734 screen`. The
pinned Unity 6 loader found a WebGPU adapter, the renderer chose WebGPU, and
the canvas context configure failed — initialization success was not
rendering success, and the page's small render scale never bounded the actual
GPU allocation (8× the viewport per axis). The shell therefore:

- removes the SHA-verified pinned loader's WebGPU adapter probe in both Wasm
  modes (no adapter request, `SystemInfo.hasWebGPU` forced false before the
  framework picks a renderer), with a `preRun` guard clearing the flag again
  for any loader that could not be text-patched;
- owns the canvas size strictly: `devicePixelRatio: 1`,
  `matchWebGLToCanvasSize: false`, full-viewport CSS with no transform, and
  the backing store written directly (never `Module.setCanvasSize`). A 25 %
  render scale on an 1180×734 Retina screen is a 295×184 buffer. An
  unchanged size is never reassigned — the assignment itself clears the
  WebGL frame;
- raises the recovery overlay for a throwing frame callback after boot (the
  failure used to be a silent 0 fps log line), and restores the error screen
  when a startup failure lands after the loading overlay was hidden;
- versions the shell scripts as `?v=1.1.1` and logs
  `shell=1.1.1 WebGL2`. Game-data cache keys, saves and downloaded assets
  are untouched. The reported 2 GiB wasm heap is real (the pinned binary
  ignores the heap size hints); the misleading comments are corrected.

Validation: **191 tests across ten suites** (`cd web && npm ci && npm test`),
including regressions for the exact probe in both Wasm modes, the fallback
renderer guard, the reported Retina/25 % sizing (295×184, no-op resize
preserves buffers) and the visible GPU-failure overlay. The real-browser
integration was strengthened to advertise a WebGPU adapter, require **zero**
adapter requests, read **real WebGL pixels** back across several frames and
require every sampled buffer to stay within the viewport; it passes in
Chromium 153 against the exact pinned loader, which this session could
download and digest-verify. Full gameplay on the affected iPad still needs a
device check: the boot log must show `shell=1.1.1 WebGL2`, the buffer must
stay 295×184 at 25 %, and FPS must be non-zero with the title screen visible.

Browser prerequisites:

```sh
cd web
npm ci
CHROME_BIN=/path/to/chrome npm run test:browser
```

The test uses a public GitHub API request for the exact pinned loader, or set
`PINNED_LOADER_PATH=/path/to/w-pt.loader.js` for an offline copy; its digest is
always checked. `CHROMIUM_MODULE` optionally points to an installed
`@sparticuz/chromium` module. Browser binaries/system libraries are not committed.

## Follow-up (shell 1.1.2): flight recorder, crash report, safe mode

After shell 1.1.1 the affected iPad still never showed the title screen: a
black screen, then the tab crashed and Safari reloaded it. A warm cache made
loading look instant, and the in-page log died with the tab, so there was
nothing to read. With WebGL 2 actually working, the working theory — code-level
support, not a device measurement — is that the game now boots and allocates,
and iPadOS jetsam-kills the tab mid-load. Each in-flight ZIP part holds a
16 MiB buffer; the old default kept 6 of them (96 MiB) on top of the
compiled-in ~2 GiB wasm heap, which no HTML setting can shrink and which this
shell does not patch.

Shell 1.1.2 does **not** claim that gameplay works. It makes the next kill
diagnosable and offers a lower-memory start:

- a flight recorder (`sk.lastlog`) flushed every 2.5 s and when the tab is
  hidden, consumed on the next visit and cleared on a clean `pagehide`, so
  only a real kill leaves a report;
- a start-screen crash report: outcome, heap at death, "It never reached the
  game." for stage-only deaths, the starting preset, the last 14 log lines,
  and Copy diagnostics (shell version, user agent, last-session summary,
  stage, previous log, current log);
- **Start in safe mode**
  (`preset=rock_bottom&fps=24&auto=1&downloads=2&bundleCacheMB=64`), which
  does not clear saves or the game-data cache;
- small devices keep 3 part downloads in flight by default, desktops 6
  (`?downloads=` still overrides, 1–8). The 512 MB extracted-bundle budget is
  OPFS disk, not RAM, and is unchanged except when safe mode asks for 64;
- post-boot reassertion of canvas CSS (`width`/`height` 100%, `transform:
  none`) at 1 s and 5 s, because the pinned framework's
  `Browser.updateCanvasDimensions` strips inline canvas CSS during takeover.
  Those timers never write `canvas.width`/`height`;
- engine failures (`onAbort`, window `error` capture, `unhandledrejection`)
  raise the recovery overlay only when the game has booted and never drawn a
  frame. After frames flow, errors only log;
- a payload magic check before Unity starts, on both boot paths. The first
  16 bytes are fetched with a Range header; fetch decodes `Content-Encoding:
  gzip` transparently. The pinned `.unityweb` files are themselves gzip
  (`1f 8b`); their inner bytes are `UnityWebData1.0\0` and wasm
  `00 61 73 6d` (confirmed against commit `bcbe014` by inflating a prefix,
  not the file). A container is inflated from a few KB, never downloaded
  whole for the check. The log says whether the real game data reached
  Unity, or the cached copy does not look like game data (captive-portal
  HTML is the mismatch). A jetsam kill is not treated as a corrupt cache,
  and nothing here clears saves or game-data cache keys;
- shell scripts versioned as `?v=1.1.2`, boot log `shell=1.1.2 WebGL2`.
  Game-data cache keys, saves and downloaded assets are not invalidated.

Already confirmed against the pinned framework, and not re-litigated here:
the framework pushes onto `Module.preRun` (the WebGL 2 guard survives),
`_JS_SystemInfo_HasWebGPU` returns `Module.SystemInfo.hasWebGPU` directly,
`GetMatchWebGLToCanvasSize` / `GetPreferredDevicePixelRatio` honour
`matchWebGLToCanvasSize: false` (ratio 1), and
`Browser.updateCanvasDimensions` strips inline canvas CSS. The old
9440×5872 target was the old `scale(4)` CSS transform times devicePixelRatio
2 on an 1180×734 screen.

Validation: **198 tests across ten suites** (`cd web && npm ci && npm test`;
was 191). New regressions cover the crash report from a seeded heartbeat and
log, a mid-load stage death (and a hidden or stale marker that must not
report), a clean `pagehide` clearing the recorder, `downloadConcurrency` 3/6
with `?downloads=` still overriding, the safe-start URL, the pre-frame
engine-failure overlay and its absence after `noteEngineFrame`, and payload
magic success, a captive-portal mismatch, and a gzip `.unityweb` container.
The Chromium 153 integration from shell 1.1.1 still stands and was not
re-run as a graphics change: zero WebGPU adapter requests with an adapter
advertised, real WebGL pixels, viewport-bounded buffers, both Wasm modes,
against the digest-verified pinned loader. `tools/test-browser.mjs` now
expects `shell=1.1.2 WebGL2`. Gameplay on the affected iPad is not claimed
until a device report shows non-zero FPS and a visible title screen.

## Still requires external assets/project/device work

The original Unity project and a paid/large-file hosting account are not in
this repository. Consequently this change does **not** claim to:

- split the actual all-scenes/Addressables groups into smaller region bundles;
- rebuild atlases into genuine shared dependencies;
- resize/repack sprite atlases without damaging sprite coordinates;
- re-encode/rebank audio or change language dependencies;
- change compiled heap limits, managed stripping, shaders or scene startup code;
- prove every boss/scene/save works or that an iPad reaches gameplay in 180 s.

These are not safe HTML switches. Existing destructive slimming is not
extended. Runtime/download alternatives can be mutually exclusive; the tools
and switches make them testable rather than enabling contradictory modes.

For the remaining three-minute acceptance test: use the deployed build on the
target iPad with a new game and a later save, record cold/warm times and stage
logs, verify foreground Wi-Fi behavior, and report the **first controllable
scene**. At 25 Mbps, 180 seconds carries at most 562.5 MB before protocol/CPU
cost; a minute of initialization leaves about 375 MB for all downloads. If the
actual startup dependency set exceeds that, bundle/asset rebuilds or faster
hosting are necessary, even with an optimized loader.
