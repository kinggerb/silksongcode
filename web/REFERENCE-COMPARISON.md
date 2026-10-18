# Reference port vs this repo — the deep comparison

This is a file-by-file comparison between the working upstream web port
(`https://git.gay/web-ports/hollow-knight-silksong`, mirror
`https://github.com/web-ports/hollow-knight-silksong`, pinned commit
`bcbe014765f2f6ca4b1d82ac25755a0299a600ab`) and this repository's
`web/play.html` shell, written to answer one question: **why does the
reference show the game while this port shows a black screen?**

It is deliberately blunt. The reference is a tiny page that does almost
nothing. This repo is a 3,700-line shell with a 1,772-line archive layer, a
484-line binary-patcher, OPFS storage, a custom fetch mount, a custom canvas
contract and a homemade slim build of the game. Every one of those is a new
way for the boot to fail, and one of them — the **payload** — is not the game
the reference runs at all.

> Short version: you did not port the reference's recipe, you re-implemented
> it, and then you swapped the game data for a lossy rebuild.
>
> **This has now been changed**: the default archive is the reference's own
> unmodified ZIP, cutscenes are real, the archive is no longer pruned, the
> `desynchronized` canvas hint is gone, and the loading overlay no longer
> turns into a bare black canvas after 60 s. §7 lists every edit.

---

## 1. What the reference actually does

The whole port is **`index.html` (about 280 lines) + `jszip.js` + the stock
Unity build**. There is no service worker, no OPFS, no loader patching, no
wasm patching, no custom canvas handling.

### 1.1 `index.html`

| Line(s) | What it does |
| --- | --- |
| 3 | `<base href="https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@master/">` — every relative URL in the page (build files, `StreamingAssets/…`, ZIP parts) resolves to the CDN. |
| 25–40 | Replaces `window.fetch` with a wrapper that looks at `url.split("/").pop()` and returns `cache.match(that basename)` if it exists, otherwise `originalFetch`. This is the entire "asset server". |
| 42–52 | `isCached()` checks for a `CACHE_COMPLETE` marker in CacheStorage `hksilksongcache-v2`. |
| 54–90 | `unzipAndStore()` runs `JSZip.loadAsync` over the merged 2.08 GB blob and writes **every entry** into CacheStorage with `cache.put(file.name, new Response(blob))`, 10 at a time. |
| 95–145 | `fetchWithProgress()` downloads each part with the browser's own `fetch` and concatenates the buffers. |
| 155–180 | `mergeFiles()` fetches **all 100 parts in parallel** and returns `new Blob(buffers)`. |
| 183–208 | `getParts("StreamingAssets/aa/WebGL.zip", 1, 100)` — the archive is 99 × 20,866,662 B + 17,340,100 B = **2,083,139,638 B**. |
| 210–275 | `createUnityInstance(canvas, config, onProgress)` with `dataUrl: "Build/w-pt.data.unityweb"`, `frameworkUrl: "Build/w-pt.framework.js.unityweb"`, `codeUrl: "Build/w-pt.wasm.unityweb"`, `streamingAssetsUrl: "StreamingAssets"`, `companyName`, `productName`, `showBanner`. `.then()` removes the loading bar; `.catch(alert)`. |
| 268 | Loads the loader from `https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@latest/Build/w-pt.loader.js` — **stock, unmodified**. |

That is the entire port. It has exactly three moving parts: a `<base>`, a
CacheStorage-backed fetch shim, and Unity's own loader.

### 1.2 The stock loader (`Build/w-pt.loader.js`, SHA-256 `6705d6c0…`)

* `webglContextAttributes: { preserveDrawingBuffer: false, powerPreference: 2 }`
  (line 32) — **nothing else**. `alpha`, `antialias`, `stencil`, `depth`,
  `desynchronized` and `premultipliedAlpha` are left at the browser/Unity
  defaults.
* `wasmFileSize: 82574276`, `locateFile: e => e`.
* `streamingAssetsUrl: "StreamingAssets"` is **overwritten** at line 72 with
  `new URL("StreamingAssets", document.querySelector('base').href).href`.
  The page's `<base>` is therefore load-bearing.
* The gzip predicate `hasUnityMarker` is hard-coded to `true` (line 2109): the
  loader always runs the fetched `.unityweb` payloads through its inflate
  worker. If the browser already decoded `Content-Encoding: gzip`, the data
  parser at line 2252 throws a very explicit error instead of silently
  corrupting.
* The loader downloads the wasm itself and passes the bytes through
  `WebAssembly.instantiate` (`b.wasmBinary`). There is no streaming
  compilation hook, no heap patch, no unload patch, no framework patch.
* `cacheControl` is `must-revalidate` for `dataUrl` and `*.bundle`, `no-store`
  for everything else.

### 1.3 Boot order

1. Download 100 parts → merge → `JSZip.loadAsync` → extract every entry to
   CacheStorage.
2. `createUnityInstance` → loader fetches the framework (gunzip in a worker),
   the wasm and the data.
3. The framework starts; Addressables request `StreamingAssets/aa/…` URLs.
   The fetch shim answers any request whose **basename** is in the cache;
   everything else goes to the CDN.
4. On later visits, `CACHE_COMPLETE` short-circuits the download entirely.

There is no progress state machine, no memory ladder, no retry logic, no
`<base>` emulation. If anything fails, the promise rejects and `alert()` shows
it.

---

## 2. What this repo actually does

`web/play.html` is 3,700+ lines, `web/js/community-build.js` is 1,772,
`web/js/unity-startup.js` is 484, `web/js/stream.js` is 1,657 and
`web/js/zip-plan.js` is 841. The boot path is:

### 2.1 Build selection (`play.html`, `resolveAssetBase`)

* Probe `Build/build-manifest.json`; if absent, fetch
  `community-build.json` (or `?communityConfig=`).
* The descriptor's `base` is the **upstream reference repo on jsDelivr**
  (`…/hollow-knight-silksong@bcbe014…/`), while `assetArchive.base` points at
  **`raw.githubusercontent.com/kinggerb/silksongcode/a2c4553…/parts/`** — a
  111-part, 1,847,328,572 B rebuild.
* `ASSET_BASE` is the descriptor base + `/`.

### 2.2 Runtime patches (`js/unity-startup.js`)

`prepare()` fetches the loader, framework and wasm in parallel and rewrites
them in memory:

* **loader**: digest-pinned (`6705d6c0…`), then
  * `hasUnityMarker` is replaced with a real gzip-MIME check (so an
    already-decoded body is not inflated twice);
  * the WebGPU adapter probe is replaced with `SystemInfo.hasWebGPU = !1`;
  * if streaming is available, `T("codeUrl")` is replaced with
    `b.instantiateWasm ? Promise.resolve(null) : T("codeUrl")`.
* **framework**: digest-pinned, inflated, and the
  `disconnectSource`/`_pauseMediaElement` block is patched so released room
  audio gives its decoder back.
* **wasm**: streamed through a `TransformStream` that patches two windows at
  fixed offsets — the initial memory declaration (2048 → 1536 MiB, maximum
  untouched) and an 11-byte "unload assets" gate — then compiled with
  `WebAssembly.compileStreaming`.
* The loader and framework are served from **blob URLs**; the compiled module
  is handed to Unity through `config.instantiateWasm`.

The reference does none of this.

### 2.3 Archive (`js/community-build.js`)

* `ensureArchive()` downloads the 111 parts with resume, a 90-minute
  GitHub-rate-limit wait, a jsDelivr mirror, and optional pruning; stores the
  joined ZIP in OPFS.
* `openArchive()` reads the ZIP central directory with zip.js.
* `installFetchMount(window, mount, …)` replaces `window.fetch` and answers
  requests that contain `/streamingassets/`:
  * **cutscenes** (`.mp4/.webm/...`, or a segment named `video`, `cutscene`,
    `cinematic`, `intro`, `movie`) get a **622-byte sample-less MP4** or a
    **196-byte WebM that libavformat cannot even open**;
  * other ZIP entries are inflated **on demand** through a custom
    `ReadableStream` writer, or served as a `File` slice from the extracted
    bundle cache;
  * everything else falls through to the network (`previous(input, init)`).
* `planArchive()` is the "leave the cutscenes out of the download" planner. It
  is skipped entirely when the descriptor says `"slim": true` — which this
  repo's descriptor does — so `onPlan` never fires and
  `plan.videoNames` is never populated.

### 2.4 Page extras (`play.html`)

* `provideUpstreamBase()` inserts a `<base>` element with **no `href`
  attribute** and defines an own `href` property on the instance so
  `document.querySelector('base').href` returns the asset root while
  `document.baseURI` stays the page URL.
* `compatMode` (menu button, `localStorage['sk.compat']`, or `?compat=1`) is the
  only switch that changes `stencil`.
* `applyResolution()` writes `canvas.width/height` directly
  (`innerWidth × perf.scale`, min 160×120); `setCanvasCss()` keeps the
  element at 100 %/100 %.
* A `requestAnimationFrame` wrapper implements the FPS cap.
* `makeUnityConfig()` passes `devicePixelRatio: 1`,
  `matchWebGLToCanvasSize: false`, and a full
  `webglContextAttributes` object including
  **`desynchronized: true`**, `alpha: false`, `antialias: false`,
  `stencil: !!compatMode` (default **false**), `premultipliedAlpha: false`,
  `powerPreference`.
* `completeUnityBoot()` keeps the loading overlay up until **3 frames** have
  been drawn, but `finishBootOverlay('timeout')` hides it after **60 s
  regardless**. `currentStage` is `first scene (engine ready, no frame yet)`.
* `surfaceEngineFailure()`/`DRAW_FAILURE_MSG` catch a throwing frame callback
  and raise a recovery panel; a silent 0-fps engine is only visible in the
  log.

### 2.5 The payload

The 1,847,328,572 B archive is built by `web/tools/slim-archive/`:

* **6,386 Mesh objects**: every vertex/index payload zeroed —
  **456,033,780 bytes**. Counts and packing metadata are left intact, so the
  meshes are valid but have no shape.
* **26 cutscene payloads**: replaced with a ~600-byte blank MP4, zero-padded
  to their original length — **224,097,829 bytes**.
* Every bundle is re-encoded with **LZ4 blocks** and rewritten, then deflated
  into a new ZIP. Textures are preserved by default (verified byte-identical
  for `sprites-ui`: 82 `Texture2D`, 232 `Sprite`, 117,119,596 B of payload,
  identical SHA-256 for every texture).

Measured central-directory diff against the upstream ZIP (both 21 entries,
same names):

* **18/21** entries have the **same uncompressed size** — the object streams
  were not resized; only the internal LZ4 blocks and the UnityFS header were
  rewritten.
* **3/21** change size: `scenes-hornet_scenes_all` 504,314,372 → 420,690,162
  (`-83.6 MB`), `cinematics` 228,270,727 → 6,085,413 (`-222.2 MB`),
  `sprites-ui` 117,783,892 → 17,433,659 (`-100.3 MB`, recompression only —
  proven identical above).
* **All 21 ZIP CRC-32s differ.** Even bundles with no content edit (audio)
  differ, because the bundle file itself was re-encoded (the UnityFS header
  records compressed block sizes). The bundled game is therefore not
  byte-identical to the one the reference runs, even where its objects are.

---

## 3. Side-by-side

| # | Aspect | Reference | This repo | Can it black-screen? |
| --- | --- | --- | --- | --- |
| 1 | Game payload | original **2,083,139,638 B**, 100 parts | rebuilt **1,847,328,572 B**, 111 parts; meshes zeroed, videos stubbed | **Yes** — content damage; `scenes-hornet` is 83.6 MB smaller |
| 2 | ZIP entries | 21 bundles, extracted **all at once** | 21 bundles, inflated **on demand** | **Yes** — 420 MB scene bundle inflates during the first scene |
| 3 | Fetch shim | matches by **basename only** | requires `/streamingassets/` in the URL, then path/`aa/`/basename | Possible 404s if Addressables ever uses a bare name |
| 4 | Loader | stock | digest-pinned but **rewritten** (WebGPU, gzip, codeUrl) | Yes if a patch is wrong for the browser |
| 5 | Framework | stock | inflated, digest-checked, **audio block patched**, blob URL | Possible |
| 6 | Wasm | stock, fetched by loader | **streamed-compiled** with 2 byte patches, `instantiateWasm` | Yes on browsers without `compileStreaming`/`DecompressionStream` (falls back, but then no heap patch) |
| 7 | WebGL attrs | `preserveDrawingBuffer:false, powerPreference:2` | `alpha:false`, `antialias:false`, `premultipliedAlpha:false`, `stencil:!!compat`, **`desynchronized:false`** | Was **yes**; the hint is gone |
| 8 | Canvas size | Unity's default 960×600 | page-owned `innerWidth × perf.scale`, DPR 1, `matchWebGLToCanvasSize:false` | Possible |
| 9 | Cutscenes | real files | 622 B/196 B placeholders (default) | Only for fetch-based video |
| 10 | Loading UI | stays until `createUnityInstance` resolves | kept up with a status line; steps aside after 10 min | Was **yes**; fixed |
| 11 | Cache | CacheStorage, complete extract | OPFS ZIP + extracted-bundle cache + UnityCache disabled for bundles | Possible (stale/partial archive) |
| 12 | Recovery | `alert()` on rejection | overlay after a frame exception; log otherwise | No |
| 13 | `<base>` | real `<base href>` | fake `<base>` with own `href` property | Yes if the loader ever reads the attribute |
| 14 | Upstream pin | `@latest` loader | `@bcbe014` for build files and data | Drift risk only |

---

## 4. The four things most likely to make it black — in order

> **Status: all four have been fixed in this checkout** (§7). This section is
> kept as the diagnosis that motivated the change, so the reasoning is not
> lost; the code no longer behaves the way it is described here.

### 4.1 You are not running the reference's game (highest confidence)

The reference runs the **original** 2.08 GB archive. This repo runs a
**rebuilt** one in which:

* every mesh in the game is a zero-filled buffer (456 MB of vertex/index
  data);
* every cutscene is a blank 600-byte MP4;
* every bundle has been re-encoded, so all 21 file CRCs differ from upstream.

"All the assets load" only proves the ZIP and the fetch mount work. It says
nothing about whether the *game* is still the game. `slim-archive/README.md`
says it outright: *"This is inherited lossy geometry removal; validate game
scenes before assuming empty meshes are harmless."*

There is a second-order effect: because the catalog is fetched from the
**pristine** upstream CDN but the bundles come from the **rebuilt** archive,
the two halves of Addressables are from different builds. The runtime has the
checker — `w-pt.wasm` contains `CRC Mismatch` / `Will not load AssetBundle`
at offset 73,799,333 — and all 21 rebuilt bundle files have new CRC-32s. If
the catalog's binary extra data carries a non-zero `m_Crc`, **all 21 bundles
are refused** while every HTTP request still succeeds. Measured caveat:
`catalog.bin` contains no ASCII `m_Crc`/`Crc` and none of the 21 ZIP CRC
values appear in it verbatim, so the CRC values are either zero or stored in
an encoding that was not decoded here. Treat CRC refusal as a real mechanism,
not a proven one; the confirmed difference remains the content damage.

**Test it first** — §6.

### 4.2 The first scene is inflated on demand, and the UI gives up after 60 s

The reference extracts the whole ZIP to CacheStorage before Unity starts, so
every bundle is already a local blob when Addressables asks for it.

This page starts Unity first and inflates the requested bundle from the ZIP
through a `ReadableStream` — for the first real scene that can be
`packed-scenes-hornet_scenes_all` (329 MB compressed / 420 MB uncompressed) or
`packed-collections` (306 MB / 350 MB). On top of the download you already
did, that is a multi-minute inflate + Unity copy + asset instantiation on a
tablet. At 60 s `finishBootOverlay('timeout')` **hides the loading overlay even
though no frame has been drawn**, leaving a black canvas with no status text.
That is exactly the symptom being debugged.

### 4.3 You changed the WebGL context contract

The reference passes **only** `preserveDrawingBuffer:false` and
`powerPreference:2`. This page adds `desynchronized:true`, `alpha:false`,
`antialias:false`, `premultipliedAlpha:false`, `stencil:false` and a custom
`devicePixelRatio`/`matchWebGLToCanvasSize`.

`desynchronized:true` is a low-latency canvas hint with a history of blank /
not-composited canvases on some browser/GPU combinations; it is not used by
the reference and it is not needed here. `stencil:false` (the default unless
`localStorage['sk.compat']` is set) also changes what URP can do.

### 4.4 The cutscene placeholder path does not do what the comment says

`_JS_Video_Create(url)` in the framework does:

```js
var video = document.createElement("video");
video.src = str;
video.muted = true;
video.crossOrigin = "anonymous";
```

That is a **native media load** — it never goes through `window.fetch`. So:

* the `bypassVideos` branch of `installFetchMount` cannot affect
  `VideoPlayer.url` playback; the browser loads the real `.webm` from the
  CDN whether or not the mount is listening;
* `?videos=real` only changes requests that some *other* code makes through
  `fetch` (e.g. an explicit `UnityWebRequest`), not the cutscene elements;
* `videoNames` is only filled by `planArchive()`, which is skipped for
  `"slim": true` descriptors, so on this build it is **always empty**.

The placeholder therefore protects nothing on this build and only adds a way
to hand invalid media to anything that *does* fetch it.

---

## 5. Smaller defects worth fixing regardless

1. **`slim:true` disables the planner silently.** `ensureArchive()` only calls
   `planArchive()` when `!archive.slim` (line 777). With the shipped
   descriptor, `onPlan` never fires, `videoNames` is empty and the
   "First run downloads about …" subtitle never updates. If the mount ever
   depends on `videoNames`, it is broken by configuration.
2. **`<base>` with an own `href` property.** `provideUpstreamBase()` relies on
   `document.querySelector('base').href` reading the JS property rather than
   the content attribute. Any code that uses `getAttribute('href')`,
   `baseURI`, or a URL parser sees the page URL instead. The reference just
   ships a real `<base href>`.
3. **Loader digest fallback is silent.** If the loader changes, `prepare()`
   serves the **stock** loader — the WebGPU probe comes back and `?stock` is
   not needed for that failure mode to appear.
4. **`cacheControl` disables UnityCache for bundles.** `no-store` for every
   `.bundle`/`StreamingAssets` URL (unity-startup 372–380) is the opposite of
   the reference's `must-revalidate`.
5. ~~**The 60 s timeout is unconditional.**~~ Fixed: the overlay now keeps
   reporting progress and only steps aside after 10 minutes.
6. **The page depends on the reference repo's CDN** for the 144 loose
   bundles, `catalog.bin`, `catalog.hash`, `settings.json` and the build
   files. That is 249 MB + 4.2 MB of runtime dependencies that are not in
   this repo at all (`git ls-files web/StreamingAssets` is 0).

---

## 6. The three runs that settle it

### Run 0 — the default is now the reference recipe

The default `community-build.json` points at the **untouched** reference
archive (2,083,139,638 B in 100 parts), cutscenes are real, the archive is not
pruned and the non-standard context attributes are gone. A plain visit to
`web/play.html` is therefore already "the reference's game, on this shell".

### Run 1 — stock parity

```
web/play.html?stock=1
```

`?stock=1` does all of the following:

* the same reference archive (it is the default now);
* `prune:false`, so no archive planning;
* `streaming:false`, `loaderPatch:false`, `frameworkPatch:false`,
  `wasmPatches:false`, `cacheControl:false` — **the stock loader, stock
  framework, stock wasm and stock UnityCache defaults**;
* no `webglContextAttributes` at all — Unity's own defaults, exactly like
  `index.html`;
* the upstream `companyName`/`productName` (`EDUrocks Group, Truffled,
  GN-Math` / `Hollow Knight SilkSong`), which key Unity's IndexedDB FS,
  PlayerPrefs and UnityCache — the shell's own names are `Team Cherry` /
  `Hollow Knight Silksong`, so **its saves and the reference's are in
  different stores**;
* `bypassVideos:false` — real cutscenes.

If this shows the title screen, the shell is capable of booting the game and
**the rebuilt archive is the problem**. If it is still black, the problem is in
the page (or the machine), not the payload — continue with Run 2.

### Run 2 — isolate the shell changes

Keep the stock archive but re-enable pieces one at a time:

```
(default)                # shell + the reference archive
?loaderPatch=0           # no loader rewrite
?bundleStream=0          # Blob delivery instead of streams
?unloadPatch=0           # no unload patch
?compat=1                # stencil:true for this load
?videos=placeholder      # the old blank cutscenes
```

The first one that fixes the picture names the defect.

### Run 3 — bisect the rebuild (only if Run 1 works)

Rebuild without the two content edits, then add them back:

```
python3 web/tools/slim-archive/slim_pipeline.py bundles \
    --no-meshes --no-videos --src <upstream-bundles> --out <out>
```

* `--no-meshes --no-videos` keeps the recompression but removes the data
  damage. If the game appears, the black screen was the mesh/video edit.
* If it stays black, the **recompression/rewrite itself** is the problem
  (Unity rejecting the rewritten UnityFS blocks), not the payload bytes.

Then reintroduce one flag at a time (`--no-meshes` only, `--no-videos` only)
to find which edit did it.

---

## 7. What was changed to make this playable

1. **The default archive is the reference's own ZIP.**
   `web/community-build.json` now describes the upstream
   `StreamingAssets/aa/WebGL.zip` — 100 parts, **2,083,139,638 B**, commit
   `bcbe014…`, GitHub raw with jsDelivr as mirror, `slim:false`. Nothing is
   zeroed, stubbed or re-encoded. The rebuilt archive moved to
   `web/community-build-slim.json` and is opt-in with
   `?communityConfig=community-build-slim.json`.
2. **Cutscenes are real by default.** `bypassVideos` is only on with
   `?videos=placeholder`; the default no longer substitutes 622-byte blank
   MP4s.
3. **The archive is not pruned by default.** `prune` is `?prune=1`; the page
   downloads exactly the bytes the reference downloads, cutscenes included.
4. **The 60-second black screen is gone.** The first-frame watchdog now logs
   and keeps the overlay with a live "Still loading the first scene…" status
   at 60 s, and only steps aside after **10 minutes**
   (`FIRST_FRAME_TIMEOUT_MS = 600000`).
5. **`desynchronized` is no longer requested** (`false`), and the test that
   pinned it now pins its absence.
6. **StreamingAssets has its own host.** `assetArchive.streamingBase` points
   at GitHub raw, so `catalog.bin`, `catalog.hash`, `settings.json` and the
   loose menu bundles are not subject to jsDelivr's ~20 MB per-file cap (one
   of them is 20.4 MB). The loader's `<base>` now names the same root the
   config does.
7. **Retired caches are dropped.** `previousCacheKeys` now lists the rebuilt
   archive's cache key, so a visitor who already downloaded the edited ZIP
   gets the real one instead of the old bytes.
8. **Control switches kept**: `?stock=1` (no patches at all), `?loaderPatch=0`,
   `?videos=placeholder`, `?prune=1`, `?compat=1`, `?assets=lazy`,
   `?communityConfig=community-build-slim.json`.

Tests: `npm test` passes (page suite 42/42, community-build suite 42/42, all
other suites green).

---

## 7b. What was verified after the change

Everything below was checked against the real bytes, not inferred:

* **The default descriptor matches the real ZIP.** The upstream
  `StreamingAssets/aa/WebGL.zip.part100` ends with an EOCD of **21 entries**,
  central directory at `2,083,136,364`, total `2,083,139,638` — exactly
  `community-build.json`'s `total`, `parts.length` and last-part size
  (`17,340,100`). The 21 entry names are basenames, which is what the fetch
  mount indexes.
* **The catalog is fully covered.** `catalog.bin` (4,171,048 B) names **162**
  bundles: **21** are inside the ZIP, **141** are loose files under
  `StreamingAssets/aa/WebGL/`, and **0** are missing from both. The two sets
  do not overlap, so every request is answered by exactly one source.
* **The mount answers from the ZIP and only from the ZIP.** A new integration
  test builds a real ZIP with the 21 real bundle names, opens it with the
  production `openArchive` + zip.js, installs the production fetch mount, and
  proves all 21 are served locally while `catalog.bin`, `catalog.hash`,
  `settings.json` and the loose menu bundle fall through to the network.
* **The hosts serve the pinned paths.** `gh api` at the pinned commit returns
  the expected sizes for the loader (118,453), framework (104,039), data
  (15,288,449), wasm (20,192,325), `catalog.bin`, `catalog.hash` (32),
  `settings.json` (850), the loose menu bundle (15,053,980) and
  `packed-audio-atmos` (**20,381,291 B** — the reason StreamingAssets does not
  go through jsDelivr). Live `fetch` of
  `…/StreamingAssets/aa/settings.json` and `…/catalog.hash` on GitHub raw
  returns them, and jsDelivr returns the pinned loader.
* **Tests.** `npm test` passes: page 42/42, community build 43/43, plus stream,
  manifest, zip-plan, webdata, wasm-patch, save-codec and pipeline suites.

## 8. The one-paragraph answer

The reference works because it is **one page, one `<base>`, one cache, and
the original game**. This repo replaced the cache with OPFS streaming,
replaced the loader/framework/wasm with patched copies, replaced the canvas
contract with its own, and used to hide its loading screen after 60 seconds
even when nothing had drawn. Every one of those is a way to fail that the
reference does not have — and on top of them it pointed at a **rebuilt archive
whose meshes were zeroed, whose cutscenes were blank, and whose 21 bundles
were all byte-different from the ones the catalog was built for**. The default
now runs the reference's own archive with the reference's own cutscenes, and
the shell differences are behind switches; debug anything that remains from
that baseline, not from a game that has been edited beyond recognition.
