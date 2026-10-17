# Loading-performance audit

Audit date: 2026-10-16. Repository baseline: `d9cd77a`.

**Historical audit of the baseline, before implementation.** See
[LOADING-OPTIMIZATIONS.md](LOADING-OPTIMIZATIONS.md) for the implemented changes,
current defaults, test results and remaining real-device acceptance work.

## Executive summary

There are two different problems to solve:

1. **Repeat visits can unnecessarily download the game again.** A real bug in the OPFS capability probe opened/truncated the production cache file rather than its intended temporary file; this was a baseline defect and has since been fixed.
2. **At the audit baseline, a genuine first visit cached the entire 1,252,071,320-byte archive before Unity started.** The current art-preserving descriptor instead points to a 1,847,328,572-byte ZIP, and eager full-archive delivery remains the default. Reducing time to play requires faster delivery, a smaller verified startup working set, or both.

Additional confirmed defects: the six-request setting is clamped to four, worker shutdown waits for an acknowledgement that is never sent, and parallel-download resume incorrectly equates file length with valid downloaded coverage.

At this 2026-10-16 audit baseline, this document was analysis only; the game assets had not yet been republished. The later art-preserving archive publication is described in [COMMUNITY-BUILD.md](COMMUNITY-BUILD.md) and [ARCHIVE-SIZE-BREAKDOWN.md](ARCHIVE-SIZE-BREAKDOWN.md).

## Scope and confidence

Reviewed the entry pages, `play.html`, community adapter, downloader, OPFS worker, manifest/checking code, build tools, slimming pipeline, and existing tests/docs. Also retrieved the exact pinned upstream loader and gzip-compressed framework via GitHub's content API and inspected their source.

Validation:

- `cd web && npm ci && npm test`: **156 tests passed across eight suites**, no failures.
- Small synthetic experiments exercised the real downloader with simulated disk/worker APIs. These reproduced the cache probe, shutdown, concurrency, and resume defects described below.
- An in-memory experiment applying only the proposed probe-option correction and shutdown acknowledgement preserved the seeded cache and made zero asset network requests.
- No real iPad/browser startup trace was available. No full game/asset archive was downloaded or booted for this audit. Network savings, CPU savings, startup bundle dependencies, and real-device timings remain to be measured.
- Historical asset sizes below are attributed to the repository's existing surveys, not newly measured. Those surveys describe the original archive unless explicitly marked slim.

## 1. What actually happens at startup

The root `index.html` redirects to `web/play.html`. The player probes for a prepared `Build/build-manifest.json`; if absent, it selects the pinned community descriptor (`play.html:351–383`). No prepared game build is present in this checkout.

The default community path is:

```text
Resolve descriptor
  -> check OPFS / request persistent storage
  -> initialize disk writer and check cache
  -> download all missing archive parts to OPFS
  -> finish/close the archive
  -> read ZIP directory and install fetch interception
  -> load Unity loader
  -> fetch framework, data and Wasm
  -> decode compressed build files / compile Wasm / initialize Unity
  -> inflate requested ZIP entries into complete bundle Blobs
  -> Unity reads/decompresses/deserializes the requested bundles
  -> render / menu / first playable scene
```

The archive step is an explicit barrier: `await ensureArchive(...)` at `play.html:2625` precedes ZIP mounting at 2671 and `instantiateUnity(...)` at 2695. The loader script itself is not injected until `instantiateUnity` (`2413–2425`).

The archive is **downloaded eagerly but extracted on demand**. These are not the same thing. The existing chunked loader limits RAM usage, but does not let the game start before the archive download finishes.

### Current byte budget

Source: `community-build.json`.

| File/set | Bytes |
| --- | ---: |
| Art-preserving Addressables ZIP | 1,847,328,572 |
| Unity data, compressed | 15,288,449 |
| Wasm, compressed | 20,192,325 |
| Framework, compressed | 104,039 |
| Loader | 118,453 |
| **Known total** | **1,883,031,838** |

This excludes page assets, catalogs, transport overhead, retransmissions, and other runtime requests. The ZIP alone is 1.847 GB decimal / 1.7205 GiB / 1,761.75 MiB. The page labels MiB as “MB.”

There are 111 archive parts: 110 × 16 MiB plus a 1,834,812-byte final part. Raw GitHub is the configured primary host; jsDelivr is the archive mirror. Unity entry points use the upstream jsDelivr root.

### Is eight minutes plausible from the download alone?

Yes. Ideal lower bounds for the archive only:

| Sustained payload throughput | Archive transfer time |
| --- | ---: |
| 10 Mbps | 16 min 42 s |
| 20 Mbps | 8 min 21 s |
| 25 Mbps | 6 min 41 s |
| 50 Mbps | 3 min 20 s |
| 100 Mbps | 1 min 40 s |

Formula: `bytes × 8 / bits_per_second`. Eight minutes corresponds to about **20.9 Mbps** if entirely spent transferring this archive. This does not establish the cause on the user's device: storage backpressure, server throttling, retries and initialization can all consume some of the eight minutes.

## 2. Confirmed defects to fix before larger optimizations

### A. The capability probe destroys the real cache — highest priority

At `js/stream.js:1236–1254`:

```js
var base = {
  dirName: dirName,
  name: opts.cacheKey,
  expectedSize: expectedSize,
  log: opts.onLog,
};
var probeName = opts.cacheKey + '.probe';
var probe = new WorkerSink(
  Object.assign({ workerUrl: opts.workerUrl, name: probeName, expectedSize: 0 }, base)
);
await probe.open(false);
```

`Object.assign` applies later properties last. `base.name` overwrites `probeName`, and `base.expectedSize` overwrites zero. The worker therefore receives the **real cache filename**, with `resume: false`.

`writer.js:80–87` truncates an existing nonempty file on a fresh open. This happens before `runDiskSession` checks its size/completion marker. A valid `.ok` marker cannot save an archive that has already been emptied. An interrupted partial download can be erased the same way.

This affects the normal worker/synchronous-OPFS path, not just a theoretical cache configuration. Browsers falling back to the direct writable sink take a different path.

**Proposed correction:**

```js
Object.assign({}, base, {
  workerUrl: opts.workerUrl,
  name: probeName,
  expectedSize: 0,
})
```

Also close/release the probe handle before deleting its file for cross-browser safety, and test the actual worker setup path rather than only injected `writerFactory` sinks. Consider a read-only cache-hit fast path before creating any writer.

**Reproduction:** seeded a valid four-byte cache plus matching `.ok`, ran the real stream module and real writer script with simulated OPFS/Worker APIs. The probe opened `audit.zip`, not `audit.zip.probe`; the loader fetched the asset again. After an in-memory correction, the probe opened `audit.zip.probe`, the loader returned `opfs-cached`, and there were zero asset requests. This is a functional reproduction, not an iPad speed benchmark.

**Expected value:** if repeated visits spend most of their time downloading, restoring cache reuse can remove nearly that entire transfer phase on subsequent visits. It does not remove a genuine first download or Unity initialization.

### B. Worker shutdown adds an avoidable five-second wait

`WorkerSink.abort()` (`stream.js:289–296`) awaits `call({type:'quit'}, 5000)`. The `quit` handler (`writer.js:194–197`) closes the handle and calls `self.close()` without replying. The pending request thus reaches its five-second timeout.

The capability probe awaits this shutdown before startup can proceed. Other awaited failure cleanups can pay the same timeout.

**Fix:** after `await closeHandle()`, send `reply(id, {ok: true})` before `self.close()`. Preserve timeout/error handling for genuinely unresponsive workers.

The simulated worker experiment took about 5.06 seconds before the changes and about 0.014 seconds with the probe correction and shutdown acknowledgement. These tiny-fixture times demonstrate the timeout, not a predicted game-load time.

### C. “Six parallel downloads” is actually four

The community adapter passes `concurrency: options.concurrency || 6` (`community-build.js:798`), but `stream.js:57` sets `MAX_CONCURRENCY = 4` and line 784 clamps the request to that maximum. Sequential-only sinks are limited to one.

A synthetic delayed-fetch experiment requesting six reached a peak of **four**.

**Fix/test:** expose effective concurrency in diagnostics and benchmark 2/4/6/8 on real target devices and the production host. If six/eight wins, update the cap and the shared write-buffer budget together. The page currently exposes no archive-concurrency URL parameter. Increasing a setting in the adapter alone will not bypass the cap.

More concurrency cannot exceed the user's bandwidth, can worsen throttling, and must not trade bounded RAM for giant part buffers. Four to six is not automatically a 33% reduction in total load time.

### D. Parallel-download resume is unsafe

`streamAll` writes different parts at their final offsets (`stream.js:860–909`). A later part can extend the file before an earlier part finishes, leaving holes.

But `runDiskSession`:

- treats a partial file's length as a valid contiguous prefix (`1345–1348`);
- accepts an expected-length unmarked file as complete (`1296–1306`), with a comment that incorrectly assumes ordered writes;
- uses only size verification for the community archive (`community-build.js:792`).

**Reproduction:** let part one fail while parts two and three complete. The 12-byte file contained `[0,0,0,0,66,66,66,66,67,67,67,67]`. On retry the downloader fetched **zero** parts and classified it as `opfs-cached`. The first part was still missing.

**Fix:** track committed coverage independently of file length: a per-part completion bitmap, or independently finalized chunk files plus a manifest. Flush data before marking it durable. Refetch any uncommitted part; add per-part hashes to the community descriptor. A partial contiguous-prefix strategy is acceptable only if the writer actually maintains a proven contiguous committed prefix.

Test reloads after out-of-order completion, after the final part arrives first, during marker writes, after storage errors, and across build IDs. Merely checking head/tail samples cannot establish that the middle has no holes.

**Expected value:** fewer corrupted cache hits, failed boots and full reinstall/retry cycles. This is a correctness/reliability fix rather than a guaranteed faster successful cold load. Fix it before relying on resume or raising concurrency.

## 3. Ranked optimization opportunities

Impact refers to the phase targeted, not a promise about the full eight minutes. Changes that target the same time overlap and must not have their savings added together.

### Delivery and loading architecture — no original Unity project required

| # | Change | Why it helps / caveat | Effort |
| ---: | --- | --- | --- |
| 1 | Restore cache reuse (defect A) | Potentially removes almost all repeated archive downloading. | Small + regression tests |
| 2 | Fix `quit` acknowledgement (B) | Removes a confirmed five-second startup timeout. | Small |
| 3 | Fix durable resume/coverage (D) | Prevents repeated work/corrupted starts after interruption. | Medium |
| 4 | Use object storage plus a large-file CDN | Replace the raw-GitHub/jsDelivr archive delivery arrangement with a service designed for GB-scale assets. Benchmark sustained throughput and failures from the user's network. | Small–medium |
| 5 | Start from a bootstrap asset set, not the entire ZIP | Fetch menu/hero/first-scene bundles and dependencies first; fetch the rest when needed. Biggest architectural opportunity for first-play time. | Large |
| 6 | Publish individual bundles instead of one all-or-nothing ZIP | Lets existing Addressables URLs resolve directly, gives independent caching and removes the outer ZIP decode when serving raw LZ4 bundles. Requires adapter/catalog/path validation. | Medium–large |
| 7 | Alternatively use a range-backed ZIP reader | Fetch ZIP directory, then only byte ranges covering requested entries. Persist downloaded coverage/chunks and prioritize startup requests. | Large |
| 8 | Overlap Unity entry-point fetch with asset caching | Loader/framework/data/Wasm currently wait behind the archive barrier. Start fetching them earlier with bounded buffering; keep Unity from requesting unavailable assets. | Medium |
| 9 | Benchmark effective concurrency (C) | Can help underfilled connections; not a substitute for reducing bytes. Log disk fallback and actual active requests. | Small–medium |
| 10 | Benchmark larger transfer chunks / one ranged object | On the current raw host, 32 or 64 MiB chunks would reduce 75 requests to about 38 or 19. Fewer requests may reduce overhead, but larger retry units and per-request limits matter. A proper CDN need not use Git blob-sized parts. | Medium |
| 11 | Give immutable assets long-lived cache headers | Content-hashed/pinned asset URLs can use `public, max-age=31536000, immutable`; keep mutable entry HTML/descriptors revalidated. Apply to Unity entry points too. | Small |
| 12 | Keep caches stable across code-only updates | Use per-content asset keys rather than invalidating the full payload for unrelated page changes. Never reuse changed bytes under old keys. | Medium |
| 13 | Make persistence and eviction visible | Persistence is already requested (`play.html:2620`); report whether it was granted and whether the cache exists. Keep stable origin, avoid private mode, preserve saves separately. | Small |
| 14 | Add a real stall watchdog to the community path | The two-minute watchdog exists only around prepared datasets (`2503–2555`). Archive requests can otherwise stall without throwing. Abort only stalled requests, not intentional rate-limit waits. | Medium |
| 15 | Improve mirror/backoff policy | Switch on sustained poor delivery as well as HTTP errors; do not treat every 403 as proof of a temporary rate limit. Share known-bad mirror state across requests. | Medium |

**Hosting requirements:** HTTPS, appropriate CORS for page origin, byte Range support with correct `206`/`Content-Range`, correct file MIME types, stable URLs, predictable cache policy, and allowed large objects/bandwidth. Test Safari rather than assuming a provider's generic defaults are suitable. Do not attach live hosting credentials to client code.

The current adapter can test another host with `?archiveBase=<encoded archive root>`; changing that URL alone does not create or copy the assets. Keep identical bytes, filenames and cache identity for a fair comparison. `?communityBase=` targets the Unity source root; `?base=` is for a prepared build.

**Important rate-limit qualification:** repository comments assert a specific GitHub raw request quota. This audit did not independently establish that quota and does not assume it equals GitHub's REST API limit. What is established is that the client treats GitHub 403/429 as waitable and includes escalating 30 s / 60 s / 120 s / 300 s / 900 s waits. Diagnose actual response bodies/headers and logs. The page passes a default 60-minute budget at `play.html:2637–2640`, despite comments and the adapter default saying 90 minutes. Shortening the wait budget is not itself a download optimization.

The mirror's `mirrorRefused` variable is scoped inside each returned fetch call (`community-build.js:412–422`), so it does not suppress a previously refused mirror for all later parts, despite the accompanying comments. Sharing a host-health state can avoid repeated futile requests, but permanent and transient failures must be distinguished.

### ZIP, storage and compilation — especially relevant after cache repair

| # | Change | Why it helps / caveat | Effort |
| ---: | --- | --- | --- |
| 16 | Persist extracted hot bundles to OPFS | `openArchive().blobFor()` only deduplicates concurrent inflations, then deletes the promise (`community-build.js:1144–1153`). A later request that reaches the mount inflates again. Cache selected extracted bundles with version keys and an LRU/size limit. | Medium |
| 17 | Avoid full entry inflation for every ranged request | `installFetchMount` first obtains the whole bundle Blob and only then slices a range (`1273–1275`). Serve stored/extracted bundle slices directly when possible. | Medium |
| 18 | Benchmark ZIP STORE or direct LZ4 bundles | Current bundles are LZ4-compressed inside a deflated ZIP. Removing outer deflate trades more transfer bytes for less browser work, particularly useful on warm loads. | Medium |
| 19 | Benchmark ZIP decode off the main thread | Current ZIP configuration explicitly disables workers and requests native compression streams (`1087–1102`). A controlled long-lived worker may help fallback codecs/interaction, but native streams may already win. | Medium |
| 20 | Stream extraction rather than waiting for a full Blob | The current fetch response cannot start until `getData(BlobWriter)` finishes. A bounded stream/OPFS extraction pipeline may reduce copies and let consumers overlap work if supported. Preserve integrity/error handling and test Unity's actual consumption. | Large |
| 21 | Change the pinned loader to enable real streaming Wasm compilation | The inspected upstream loader fully buffers/decompresses Wasm and sets `b.wasmBinary` before framework startup. The framework's `instantiateStreaming` branch only runs when that binary is absent. Correct MIME alone does not enable streaming in this build. | Medium–large |
| 22 | Use native HTTP decoding for compressed Unity entry points | The pinned framework is gzip-compressed. Correct `Content-Encoding` and MIME avoid the loader's fallback decoder when the response carries Unity's compression marker. Inspect actual production headers; do not guess `.unityweb` encoding or double-compress it. | Medium |
| 23 | Profile OPFS IPC and batch small writes if needed | Every network chunk is transferred to a writer, acknowledged, and calls `getSize()`. Bounded coalescing (e.g. benchmark 256 KiB–1 MiB buffers) can reduce overhead on a storage/IPC-bound device. Preserve backpressure and durable resume. | Medium |
| 24 | Fix prepared-path-only serialization/probing if that deployment is used | Prepared mode probes remote chunks before cache reuse and awaits data before Wasm (`play.html:2714–2779`). Validate cache first and overlap independent fetches with RAM bounds. This is not on the current community critical path. | Medium |

The repository's slim-archive documentation reports approximately 1,426.8 MB of bundle files versus the current 1,252.1 MB ZIP. Using those figures, skipping outer deflate may add roughly **175 MB / 14%** to a full transfer. At 20 Mbps that costs about 70 seconds before any CPU savings. Test cold and warm cases; don't assume “less compression” always means faster first load.

A range-backed ZIP still has a granularity limit: one deflated entry generally must be inflated from its start, and the historical archive has only 21 large entries. Ranges avoid downloading **unused entries**, not magically arbitrary assets inside a deflate stream. If the first scene depends on most large bundles, lazy download alone saves less than expected.

On native decoding/compilation: the exact pinned loader contains `T("codeUrl")` and later `b.wasmBinary = e[1]`. The inspected framework contains `instantiateAsync(binary, ...)` with the guard `if (!binary && ... instantiateStreaming ...)`. A replacement/verified loader patch or newer build is required to change this path; merely renaming files to `.wasm` is insufficient. HTTP decoding helps decoder overhead separately from streaming compilation.

### Asset/build changes — largest possible byte reductions, more invasive

The original Unity project is not in this repository (`BUILD.md:§1`). The existing Python tools can patch serialized bundles, but do not replace a proper dependency-aware asset build.

| # | Change | Why it helps / caveat | Effort |
| ---: | --- | --- | --- |
| 25 | Split large Addressables groups by scene/region/startup needs | The historical survey lists a 328 MiB compressed all-scenes bundle. Independent bootstrap/region bundles prevent loading a whole game's group for the first room. Requires dependency-aware rebuild/catalog updates. | Large |
| 26 | Provide a mobile texture/atlas tier | The historical survey identifies textures as the largest category. Halving width and height can quarter raw texel/block count, but does not guarantee a quarter of total download. Preserve sprite metadata/layout and choose supported GPU compression. | Large |
| 27 | Rebuild genuine shared atlas dependencies | The current art-preserving archive keeps every duplicate texture intact; it does not redirect consumers to shared assets. Proper shared groups could eliminate duplicated storage/load work without missing artwork. | Large |
| 28 | Defer optional content and audio | Load art collections, later bosses, music/voice banks and unused languages only when required. The original survey reports roughly 402 MiB compressed audio across bundles. Dependencies and saved-game spawn location determine what is actually optional. | Medium–large |
| 29 | Offer a reduced-audio quality tier | Re-encode music/voices at lower bitrate where acceptable; preserve necessary SFX. Stream long tracks and measure both decode cost and transfer bytes. Do not assume “mute” avoids downloads. | Large |
| 30 | Tune Unity startup and build configuration from a profiler trace | Release build, no development/profiling payload, safe managed stripping, controlled shader variants, deferred initialization and measured Wasm memory growth can help post-download startup. Changes require a compatible rebuild and regression testing. | Large |

The original archive was 2,083,139,638 bytes. The currently pinned art-preserving ZIP is 1,847,328,572 bytes: about **11.3% smaller**. Video replacement and mesh zeroing are applied by `tools/slim-archive/`; texture replacement is off by default, so the duplicate sprite-atlas art is preserved. Do not count the earlier lossy texture blanking as a current saving.

The video/mesh edits are size-preserving at the decompressed object-layout level. Zero-filled video/mesh payloads compress well, but retain their declared object dimensions/layout/counts; this does not prove corresponding reductions in Unity allocation or deserialization work. The explicit `--textures` option is still destructive: flat-color duplicate textures are not lossless reference deduplication, and loading order does not redirect references to an intact copy. Blanket mesh zeroing can also affect visible geometry. Validate gameplay across scenes before extending these techniques.

Likewise, the survey's multi-GiB fully decompressed totals describe the whole original asset corpus, not measured simultaneous resident memory for every run. Actual Unity residency, copies, GPU uploads and peak memory must be profiled.

`makeUnityConfig` supplies `INITIAL_MEMORY` and `maximumHeapSize`, but the inspected pinned generated framework does not read these fields; it exports its Wasm memory and has a hard-coded heap-growth maximum. Do not assume page-level numbers reconfigure that binary. Verify the compiled memory limits/growth behavior before tuning, and distinguish any separate page watchdog from an actual engine allocation limit. Increasing the heap on an iPad can make stability worse.

## 4. How to measure and choose

### Establish separate test cases

1. Cold install: no asset cache, fresh browser process.
2. Warm reload: same origin, completed asset cache, same build.
3. Warm reopen: restart browser, same completed cache.
4. Interrupted install: deliberately stop during different parts, then reopen.
5. Resume a late-game save: bootstrap dependency needs may differ from a new game.

Use at least three runs per meaningful case on the actual target device. Keep network, power/thermal state, foreground status and game-save position comparable. Report median plus individual results; test slower Wi-Fi as well as a fast connection. Avoid collecting multiple cold-install samples by clearing the user's real saves.

### Add stage timing rather than trusting the progress percentage

Use `performance.mark()` / `performance.measure()` or equivalent timestamps for:

- Start pressed / descriptor resolved.
- Storage probe start/end; chosen sink type; **effective** concurrency.
- Cache lookup hit/miss with reason; cache size, completion/coverage status and build ID.
- First asset network byte; archive/required-bundle download complete; network-byte counts and intentional retry waits.
- ZIP directory opened.
- Loader/framework/data/Wasm fetch start/end; native versus fallback decode; Wasm compile/instantiate start/end.
- Each requested bundle's filename, compressed/uncompressed size, extraction start/end, cache hit and request range.
- Unity ready, first rendered menu, and first **controllable gameplay** separately.

`createUnityInstance` resolving is not a universal “first playable” marker. The existing `game booted` log should be supplemented with a game-side readiness signal or a measured scene/input milestone.

Use Safari Web Inspector for the network waterfall and CPU timeline; collect response status, Range behavior, Content-Type, Content-Encoding, cache headers and CORS visibility. Resource Timing needs `Timing-Allow-Origin` for full cross-origin details. Log storage quota/headroom and peak heap where available, without storing saves or credentials in telemetry.

The current UI uses coarse/reused stages (including a generic “Loading into memory” label), so it cannot by itself distinguish download, decompression, compilation and scene initialization.

### Quick interpretation

| What dominates | First action |
| --- | --- |
| Full archive downloaded on every visit | Repair probe truncation; confirm cache hit and nearly zero archive network bytes |
| Cold archive transfer | Better delivery and smaller required startup set |
| Many long pauses / failures | Inspect retry/status logs and host behavior; add stall handling |
| Local ZIP extraction after a cache hit | Extracted-bundle cache, direct bundles/STORE experiments |
| Wasm compile after entry-point download | Streaming-capable loader/rebuild and compilation profiling |
| Unity deserialization, texture upload, startup code | Mobile assets, bundle splitting and Unity profiling |

## 5. Recommended implementation order

1. **Correctness patch:** probe option ordering, acknowledged shutdown, durable parallel coverage and completion validation. Add real-worker-path tests and interrupted out-of-order-write tests. Keep game content unchanged.
2. **Instrument and verify:** measure cold/warm startup on the target iPad. Warm archive requests should be zero after a valid cache hit. Confirm whether the reported eight minutes is a first-install or every-visit problem.
3. **Delivery experiment:** copy byte-identical assets to a proper large-file host; compare the existing override URL against the current host. Then benchmark effective concurrency and part size.
4. **Warm-load experiment:** persist only startup/hot extracted bundles, using storage budgets and eviction. Compare ZIP decode time and memory before expanding the cache.
5. **First-play architecture:** implement individual/lazy bundles or a range-backed ZIP, identify the true startup dependency set, and background-prefetch the rest after interactive startup.
6. **If still necessary:** rebuild smaller mobile textures/audio and scene-specific Addressables groups, then profile the remaining Wasm/Unity initialization.

### Illustrative target, not a promise

If a measured startup dependency set were 200 MB instead of the full 1.847 GB, its transfer floor at 25 Mbps would fall from about **591 seconds to 64 seconds**. Unity entry points, decompression, compilation and scene initialization still add time. The repository does not currently establish that a 200 MB bootstrap set is feasible.

**Bottom line:** repair the cache-destroying probe first. For genuine first loads, the biggest lever is changing “download the entire game before boot” to “download what is needed to play first,” backed by reliable large-file hosting. UI/CSS minification or a lower render-resolution setting will not eliminate a gigabyte-scale mandatory transfer.
