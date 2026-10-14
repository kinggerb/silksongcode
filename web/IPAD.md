# Running Silksong in Safari on an iPad

This folder is the browser side of the port. It takes the same approach as the
Hollow Knight web port (`kinggerb/hollowknightgame`): **stream the game in
chunks onto the device, never build it in RAM, and keep the tab under iPadOS's
memory ceiling.** Everything here is tested (`web/package.json` → `npm test`).

> **Read this first:** this repository does not contain Silksong. It contains the
> RL mods, the trainer and this port. A Unity **WebGL build** of the game is
> required for `play.html` to actually start the game — see
> [BUILD.md §1](BUILD.md#1-you-need-a-unity-webgl-build). Everything else is
> ready: chunking, verification, caching, the graphics ladder, saves and the
> boss-rush roster. `demo.html` proves the pipeline works on your device without
> a build.

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
| Second visit | the merged file stays on disk, with a `.ok` marker keyed by build id | no download at all; a crash + retry resumes from the byte it reached |
| Hand-off | Unity gets **one** file-backed blob URL | its own ArrayBuffer is the only big allocation left |
| Verification | chunk sizes probed with `Range: bytes=0-0` before the download, digests checked after | a truncated or stale build is caught before Unity shows a black screen |
| Data | cutscene videos are replaced by ~600-byte black placeholders and junk is left out (`prepare-build.mjs`) | hundreds of MB less to download and to hold |
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
| GitHub Pages (after the workflow runs) | `https://kinggerb.github.io/silksongcode/` |
| The loader self-test (no build needed) | `…/demo.html` |
| With the assets somewhere else | `play.html?base=https://…/` |

On the iPad: open the URL in Safari → **Start** → keep the tab in the
foreground until the game appears. Add it to the home screen
(*Share ▸ Add to Home Screen*) if you want Safari to stop evicting the cached
data after a week.

`tools/serve.mjs` exists because `python -m http.server` ignores Range requests
and serves `.wasm` as octet-stream, which breaks both the loader's size probes
and Unity's stream compilation.

## 4. What to expect

* **First run** — the download is written to disk as it arrives, then Unity
  copies it into memory ("Loading into memory — x %"). That last phase is the
  memory-hungry one: keep the tab in the foreground.
* **Later runs** — no download; the cache is verified with sampled digests and
  served straight from disk.
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

`?check=0` skips the pre-download data check, `?check=strict` refuses to boot a
build with a bad chunk, `?verify=full` hashes the whole data file instead of
sampling its first and last 4 MB.

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
| `There is not enough free storage` | Free space in *Settings ▸ General ▸ iPad Storage*; the cache needs about the size of the build. |
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

## 10. What is still a limit of the port

Unity still holds the data archive plus its own WebAssembly heap inside one tab.
The page can control pixels, frame rate, GPU flags, when assets are unloaded and
what is downloaded — it cannot shrink the game's own memory footprint, which is
why the graphics ladder and the crash ladder exist. Real reductions there mean a
rebuilt Unity project (smaller textures, streamed asset bundles,
`masterTextureLimit`), which is [BUILD.md](BUILD.md)'s territory.
