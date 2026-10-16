# Running Silksong in Safari on an iPad

This folder is the browser side of the port. It takes the same approach as the
Hollow Knight web port (`kinggerb/hollowknightgame`): **stream the game in
chunks onto the device, never build it in RAM, and keep the tab under iPadOS's
memory ceiling.** The automated checks are in `web/package.json` (`npm test`);
full CDN download and real iPad Safari behavior still need device testing.

> **Read this first:** the repository does not contain Silksong's original
> Unity project. The play page now uses a pinned community WebGL build source by
> default when no prepared local build is present. Its first run downloads about
> 1.94 GiB of Addressables data into OPFS; see
> [COMMUNITY-BUILD.md](COMMUNITY-BUILD.md) for the source, storage requirements,
> and limitations. `demo.html` remains a small loader test that does not download
> or pretend to contain the game.

---

## 1. Why a naive page kills Safari

A Unity WebGL build is one big `*.data` archive plus a `*.wasm` module. The
obvious page glues the chunks together in memory:

```js
N × new Blob(chunks)          // ~ size
fetch(blobUrl).blob()         // ~ size, again
new Blob([...blobs])          // ~ size, again
Unity's dataUrl fetch         // ~ size, again  ==> 3–4× the file size, at once
```

That peak lands exactly when the progress bar reaches ~100 %, and iPadOS
jetsam-kills the WebContent process: the tab simply disappears with no error.
The Hollow Knight port hit precisely this wall at 926 MB.

## 2. What this port does instead

| Step | How | Effect |
| --- | --- | --- |
| Download | every chunk is streamed straight into the **Origin Private File System** through a worker (`FileSystemSyncAccessHandle`) | peak RAM during download: a few MB, not GB. `js/writer.js` |
| Second visit | prepared files and the community Addressables archive stay in OPFS, keyed by build id | completed data is reused; interrupted downloads resume |
| Addressables | the community ZIP is indexed from its OPFS `File`; `zip.js` extracts only requested bundles | no 2 GB `ArrayBuffer`, and no eager unpack of every bundle |
| Hand-off | a prepared build gives Unity one file-backed blob URL; the community build uses Unity's compressed CDN entry points | avoids concatenating multi-gigabyte assets in page memory |
| Verification | prepared builds probe chunk sizes and sample digests; the community source uses pinned commit IDs, exact ZIP-part sizes and a ZIP directory check | stale or truncated files fail before Unity uses them |
| Data | prepared builds can replace cutscenes with ~600-byte black placeholders and omit junk (`prepare-build.mjs`) | reduces the prepared build's download and storage footprint |
| Memory | render-scale ladder (100 % → 25 %), frame cap, auto-degrade, a hard heap cap that reloads, and a crash ladder that starts the next session lower | the tab stays under the ceiling instead of being killed |
| Audio | a guard relabels iOS's `NotSupportedError` on `play()` as `NotAllowedError`, which is the error Unity waits out | sound starting late no longer kills the game |
| Room audio | the framework's `disconnectSource` drops the `<audio>` source (`tools/patches.mjs`) | WebKit frees each room's music decoder |

Measured on the Hollow Knight port, the same changes took the peak during load
from ~3.7 GB to one copy of the data (~930 MB → 659 MB after the cutscene
replacement). Silksong's numbers depend on your build; `prepare-build.mjs`
prints them.

## 3. How to open it

| Where | URL |
| --- | --- |
| Local, from this repo | `node web/tools/serve.mjs 8080` → `http://<your-computer-ip>:8080/play.html` |
| GitHub Pages project root (redirects to `web/play.html`) | `https://kinggerb.github.io/silksongcode/` |
| The loader self-test (no game download) | `https://kinggerb.github.io/silksongcode/web/demo.html` |
| With a prepared build hosted elsewhere | `play.html?base=https://…/` |
| Disable the pinned community build fallback | `play.html?community=0` |

Open the project URL in Safari on the iPad and tap **Start**. With the default
community source, the first run streams about 1.94 GiB of addressable assets to
OPFS and may take a long time; use Wi-Fi, keep Safari in the foreground, and
make sure the device has enough free storage. Later runs use the cached archive.
The compressed Unity entry points remain on the pinned source CDN. Add the page
to the home screen (*Share ▸ Add to Home Screen*) if you want Safari to retain
the origin's cache longer.

`tools/serve.mjs` exists because `python -m http.server` ignores Range requests
and serves `.wasm` as octet-stream, which breaks both the loader's size probes
and Unity's stream compilation.

## 4. What to expect

* **First run** — the community ZIP parts (or, for a prepared build, the data
  and wasm chunks) are written to OPFS as they arrive. The community build's
  compressed Unity files are fetched from the pinned CDN. Unity then loads its
  runtime memory ("Loading into memory — x %"); keep the tab in the foreground.
* **Later runs** — the large community ZIP is reused from OPFS. Prepared-build
  chunks use sampled digest verification; community ZIP parts use exact sizes
  and a pinned source commit.
* **Graphics** — iPads start at **Balanced** (85 % render scale, 60 fps cap).
  Menu ▸ Graphics & performance has seven levels down to **Rock bottom**
  (25 % scale, 24 fps).
* **Storage** — the cache lives in the origin's private file system; *Menu ▸
  Clear cached game data* deletes it.
* **Crashes** — a killed tab leaves a heartbeat behind, so the next visit shows
  *last crash at x MB heap* and starts one level lower on its own.

## 5. Graphics & performance

| Preset | Render scale | Frame cap | Pixels vs. High |
| --- | --- | --- | --- |
| High | 100 % | 60 | 100 % |
| Balanced | 85 % | 60 | 72 % |
| Smooth | 70 % | 45 | 49 % |
| Low | 55 % | 30 | 30 % |
| Potato | 40 % | 30 | 16 % |
| Minimum | 30 % | 30 | 9 % |
| Rock bottom | 25 % | 24 | 6 % |

A lower render scale shrinks the canvas backing store; CSS stretches it back
over the screen, so the picture gets softer while GPU work, video memory and
heat all drop. One-off overrides are useful for finding a device's limit:

```
play.html?preset=low      play.html?fps=30      play.html?scale=0.5
play.html?check=strict    play.html?verify=full play.html?auto=0
```

These `check` and `verify` options apply to prepared-manifest builds:
`?check=0` skips the pre-download data check, `?check=strict` refuses to boot a
build with a bad chunk, and `?verify=full` hashes the whole data file instead of
sampling its first and last 4 MB. The community mode validates its pinned
source descriptor and split ZIP sizes instead.

The page also caps the frame rate by wrapping `requestAnimationFrame` — on a
120 Hz iPad an uncapped game draws twice the frames for no visible gain — and
auto-degrades one level if the frame rate stays under 80 % of the cap for three
seconds.

## 6. Touch controls

| Button | Keyboard | Action |
| --- | --- | --- |
| D-pad | Arrows | move / look up & down |
| Jump | `Z` | jump |
| Attack | `X` | slash (direction from up/down + facing) |
| Dash | `C` | dash |
| Focus | `A` | focus / bind (heal, hold) |
| Cast | `E` | cast / silk skills |
| Dream | `D` | tool / crest |
| Map | `Tab` | map |
| Pause | `Escape` | pause / inventory |

The pad auto-hides when a physical keyboard or gamepad is used, and comes back
with Escape or a long press. A Bluetooth keyboard or an iPad-compatible
controller works too.

## 7. Saves

Saves are the game's own `userN.dat` files inside Unity's IDBFS database, so the
page can export, import and *install* them:

* *Menu ▸ Export save* — this page's own JSON export.
* *Menu ▸ Export .dat slot* — a native `userN.dat`, which desktop mods (and the
  boss-rush tools in `mods/boss-rush`) understand.
* *Menu ▸ Import save* — accepts a native `.dat`, an editor download renamed to
  `.dat.html`, a `BossSave/*.json.gz`, plain save JSON, or base64 text.
  `js/save-codec.js` validates it (AES-256-ECB, the key both Team Cherry games
  use) before anything is written.
* *Menu ▸ Boss saves* — the roster from `mods/boss-rush` (run
  `node web/tools/stage-boss-scenes.mjs` once to copy it next to the page).
  Pick a boss and a slot, install, reload — the game reads that slot on boot,
  which is how the RL mods jump straight into a fight.

## 8. Troubleshooting

| Symptom | What to try |
| --- | --- |
| Tab disappears while playing | Graphics → Low, then Potato, then Minimum. Close other tabs. The next start already begins lower after a crash. |
| Tab disappears during "Loading into memory" | Retry (the data is cached, so it skips the download) and lower the render scale. |
| The tab vanishes with no message at all | That is jetsam, and it happens too fast for the page to draw. *Menu ▸ Stability* shows the heap the last session died at. |
| Black screen after the bar | Check the log panel: `saved file is N bytes, expected M` means the download was cut; reload and it resumes. `the data check` lines say if a chunk is wrong. |
| `There is not enough free storage` | Free space in *Settings ▸ General ▸ iPad Storage*; the community ZIP alone needs about 1.94 GiB, plus headroom for extracted bundles and Unity. |
| `null is not an object (evaluating 'document.querySelector('base').href')` right after the archive finishes | The community loader asks the page for a `<base>` element (see [COMMUNITY-BUILD.md](COMMUNITY-BUILD.md#what-the-upstream-loader-expects-from-the-page)); `play.html` now provides one. Reload — the archive is cached (`cache hit:` in the log), so it goes straight to Unity, and the log shows `community loader <base>: …`. |
| No sound | Tap the screen once — iOS wants a gesture. Then check the log for `audio guard` lines. |
| Everything is slow | Graphics → Smooth or Low. Auto-degrade does this on its own. |
| Boss saves missing in the menu | `node web/tools/stage-boss-scenes.mjs` (the roster is not committed twice). |

*Menu ▸ Copy diagnostics* puts the whole log on the clipboard.

## 9. Working on it

```bash
cd web
npm install                    # jsdom, for the page tests
npm test                       # all suites
npm run test:stream            # chunk streaming, resume, verification
npm run test:pipeline          # fixture build → prepare → verify
npm run fixture                # write a synthetic Unity build
npm run prepare-build -- --build <unity Build dir> --out .
npm run verify-build
node tools/serve.mjs 8080      # static server with Range + wasm MIME
```

The suites cover the things that hurt on a tablet: byte-exact assembly, resume
after an interruption, refusing a chunk that disagrees with the manifest,
sampled-digest verification, archive rewriting with videos replaced, verified
wasm byte patches, the save codec against the repo's real boss saves, and the
page's graphics ladder, crash ladder and memory limits in jsdom.

A bug worth knowing about: the loader in the Hollow Knight port wrote resumed
chunks at `partOffset` instead of `partOffset + skip`, so an interrupted download
silently shifted the tail of the file. `js/stream.js` here fixes that (and
`test-stream.mjs` covers it) — worth back-porting there.

A second one, this time in the size check: comparing the manifest against the
response's `Content-Length` looks like a cheap way to catch a stale deploy before
downloading 2 GiB, but a cross-origin CDN is allowed to put a transfer encoding
on the answer. Then `Content-Length` describes the *encoded* body while
`response.body` yields *decoded* bytes, and `Content-Encoding` is not a
CORS-safelisted header — the page cannot even read it to tell the two apart. The
community build streams from jsDelivr, so a compressed part aborted a perfectly
good download with `part N is X bytes on the server but Y in the manifest —
rebuild or re-run prepare-build.mjs`, which the page also treats as permanent, so
there was no retry. `js/stream.js` now trusts the header only when it claims
*more* than the manifest (compression cannot do that) and otherwise decides on
the bytes that actually arrive: an oversized part is refused as soon as it
overruns the manifest, a short one still fails with `ended early`. Do not
"fix" a size mismatch by re-running `prepare-build.mjs` unless the server really
is serving a different file than the one that was chunked.

A third one, in the cache file itself: a `FileSystemSyncAccessHandle` (and a
`createWritable()` stream) takes an **exclusive lock** on its file — while one
is open, the next open of the same file is refused. Browsers release that lock
*asynchronously* when the holder goes away, so there is a window where the file
is still locked although nothing is using it any more, and three perfectly
ordinary situations land inside it: this page's own *Try again* does a
`location.reload()` and the new page asks for the file while WebKit is still
letting go of the previous page's worker; a tab iPadOS jetsam-killed
mid-download never ran `close()`; and a second Safari tab on this site holds
the lock for as long as it is open. The engines do not even spell the refusal
the same way — WebKit throws `InvalidStateError` ("The object is in an invalid
state."), Chromium throws `NoModificationAllowedError` — which is how one brief
window showed up on an iPad as a permanent, mysterious `could not open the
cache file: The object is in an invalid state.`

Two defects turned that window into a dead end: `ensureDataset` only released
the sink on the memory-fallback branch, so every other failure rethrew with
the worker still holding the exclusive handle — one failed download made the
*next* open fail too — and `sink.open()` was attempted exactly once, so even
the normal release window after a reload was fatal. `js/stream.js` now retries
the open for a few seconds (recognising both engines' spellings), always
releases the sink before rethrowing (`WorkerSink.abort()` sends `quit`, which
flushes and `close()`es the handle instead of leaving `terminate()` to reap
it), and a permanently locked file now tells the player to close the other
tabs or clear the cache rather than anything about the cache being broken.
`test-stream.mjs` pins all of it — do not "simplify" any of this back to a
single open attempt.

A fourth one, and a correction to the second: "trust `Content-Length` when it
claims *more* than the manifest, compression cannot do that" is wrong. A content
coding only shrinks data that compresses; on incompressible data it just adds its
own framing, and every ZIP part of the community build is incompressible.
jsDelivr's edge content-codes them anyway, so the wire body comes out up to ~45
bytes *larger* than the file: part 1, correctly 20866662 bytes in the manifest,
is announced as 20866707, and loaders 1.0.1–1.0.2 refused it before its first
byte with `part 1 is 20866707 bytes on the server but only 20866662 in the
manifest — rebuild or re-run prepare-build.mjs` — permanent again, no retry.
Since 1.0.3 the rule is: `Content-Length` may only fail a part up front when no
hidden transform is possible — no readable `Content-Encoding` other than
`identity`, *and* every header visible, which means a same-origin URL (or Node,
in the tests). Cross-origin, CORS hides `Content-Encoding` but still exposes
`Content-Length`, so a coded answer looks exactly like a plain one. Any other
disagreement, in either direction, only logs `part N: the server announced X
bytes for a Y byte part (a compressed transfer does that) — checking the bytes as
they arrive`, and counting the bytes that arrive stays the guard everywhere: a
part that really overruns the manifest still fails with `bigger than the
manifest`, a short one with `ended early`. A player who hit the refusal has
nothing to resume from (it came before part 1's first byte was written), so the
first load on 1.0.3 downloads the archive from zero. Again: do not "fix" this by
re-running `prepare-build.mjs` — the manifest was right all along.

## 10. What is still a limit of the port

Unity still holds the data archive plus its own WebAssembly heap inside one tab.
The page can control pixels, frame rate, GPU flags, when assets are unloaded and
what is downloaded — it cannot shrink the game's own memory footprint, which is
why the graphics ladder and the crash ladder exist. Real reductions there mean a
rebuilt Unity project (smaller textures, streamed asset bundles,
`masterTextureLimit`), which is [BUILD.md](BUILD.md)'s territory.
