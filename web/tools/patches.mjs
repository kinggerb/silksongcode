/* ============================================================================
 * patches.mjs — the build-level fixes that keep an iPad tab alive
 * ----------------------------------------------------------------------------
 * Two families of patch live here, and both are *verified before they are
 * applied*, so a patch written for one game build can never silently corrupt
 * another one:
 *
 *   1. framework.js patches (implemented below). Unity's WebGL audio code keeps
 *      a room's music attached to an <audio> element after the room unloads, so
 *      WebKit never frees the decoder and memory creeps up with every room. The
 *      fix is to drop the element's `src` (and the framework's own bookkeeping)
 *      when a channel is disconnected.
 *
 *   2. wasm byte patches (data, in web/patches/*.json). The interesting one is
 *      `GameManager.IsUnloadAssetsRequired`, which compares memory use against
 *      desktop thresholds (2.5 GB) that a 32-bit wasm heap never reaches — so it
 *      always returns false and `Resources.UnloadUnusedAssets()` never runs on a
 *      room change. Making it return true keeps memory flat across rooms.
 *      The Hollow Knight port does exactly this at a byte offset; the offsets
 *      differ per build, so here they come from a JSON file and every patch
 *      carries the original bytes it expects to find.
 *
 * A patch file looks like:
 *
 *   {
 *     "for": "silksong 1.0.30000 · Unity 2022.3.62f1",
 *     "patches": [
 *       { "name": "unload-assets-always",
 *         "why": "room transitions must run Resources.UnloadUnusedAssets",
 *         "offset": 6527956,
 *         "expect":  "20 01 0b",
 *         "replace": "41 01 0b" },
 *       { "name": "gc-collect-always",
 *         "mode": "search",
 *         "expect":  "44 ... ",
 *         "replace": "..." }
 *     ]
 *   }
 *
 * `mode: "search"` finds the expected bytes anywhere in the module instead of at
 * a fixed offset — handy right after a game update, when everything shifted.
 * `web/tools/prepare-build.mjs --scan` shortlists candidate functions.
 * ==========================================================================*/

/* ---------------------------------------------------------------- *
 * framework.js patches
 * ---------------------------------------------------------------- */

const ORIGINAL_MEDIA_BLOCK =
  'if(this.source.mediaElement){this.source._pauseMediaElement();' +
  'if(this.source.playTimeout){clearTimeout(this.source.playTimeout);this.source.playTimeout=null}}';

const PATCHED_MEDIA_BLOCK =
  'if(this.source.mediaElement){this.source._pauseMediaElement();' +
  'if(this.source.playTimeout){clearTimeout(this.source.playTimeout);this.source.playTimeout=null}' +
  'var pending=WEBAudio.pendingAudioSources[this.source.mediaElement.src];' +
  'if(pending&&pending.sourceNode===this.source){delete WEBAudio.pendingAudioSources[this.source.mediaElement.src]}' +
  'this.source.mediaElement.src="";try{this.source.mediaElement.load()}catch(e){}}';

function replaceOnce(source, find, replace) {
  const at = source.indexOf(find);
  if (at < 0) return null;
  return source.slice(0, at) + replace + source.slice(at + find.length);
}

export function releaseAudioSourcePatch() {
  return {
    name: 'release audio source on disconnect',
    why: 'lets WebKit free a room\'s music decoder instead of holding every room ever visited',
    apply(buffer) {
      const text = buffer.toString('latin1');
      if (text.includes(PATCHED_MEDIA_BLOCK)) {
        return { applied: true, already: true, occurrences: 1, detail: 'already applied' };
      }
      const patched = replaceOnce(text, ORIGINAL_MEDIA_BLOCK, PATCHED_MEDIA_BLOCK);
      if (patched === null) {
        return {
          applied: false,
          detail: 'the framework does not contain Unity\'s unpatched channel.disconnectSource block',
        };
      }
      return { applied: true, occurrences: 1, bytes: Buffer.from(patched, 'latin1'), detail: '' };
    },
  };
}

export function undefinedErrorPatch() {
  // Unity has shipped, in some framework versions, a catch block that logs the
  // wrong variable -- `catch(e){ ... error ...}` -- so stopping a sound throws
  // `ReferenceError: error is not defined` and the unhandled error kills the
  // game. Renaming the variable is enough.
  const broken = 'catch(e){console.error("playSoundClip error. Exception: "+error)}';
  const fixed = 'catch(e){console.error("playSoundClip error. Exception: "+e)}';
  return {
    name: 'fix the undefined error in _JS_Sound_Play',
    why: 'a thrown ReferenceError there becomes an unhandled rejection that stops the game',
    apply(buffer) {
      const text = buffer.toString('latin1');
      if (!text.includes(broken)) {
        return { applied: text.includes(fixed), already: text.includes(fixed), occurrences: text.includes(fixed) ? 1 : 0, detail: text.includes(fixed) ? 'nothing to do' : 'pattern not present (this framework version is fine)' };
      }
      return { applied: true, occurrences: 1, bytes: Buffer.from(replaceOnce(text, broken, fixed), 'latin1'), detail: '' };
    },
  };
}

/**
 * Run every framework patch over the file. Returns the (possibly changed)
 * bytes and a report; patches that do not match are skipped, never guessed.
 */
export function patchFramework(buffer) {
  let current = buffer;
  const report = [];
  for (const patch of frameWorkPatches()) {
    const result = patch.apply(current);
    if (result.applied && result.bytes) current = result.bytes;
    report.push({ name: patch.name, why: patch.why, applied: !!result.applied, already: !!result.already, detail: result.detail || '' });
  }
  return { bytes: current, changed: current !== buffer, report };
}

export function frameWorkPatches() {
  return [releaseAudioSourcePatch(), undefinedErrorPatch()];
}

/* ---------------------------------------------------------------- *
 * Wasm patch helpers
 * ---------------------------------------------------------------- */

/** The documented shape of the memory patch, for BUILD.md and --scan output. */
export const WASM_PATCH_LIBRARY = [
  {
    name: 'unload-assets-always',
    target: 'GameManager.IsUnloadAssetsRequired',
    why: 'returns true on every room change so Resources.UnloadUnusedAssets() runs (memory stays flat)',
    shape: 'expect the tail of the function to be "20 xx 0b" (local.get N; end) and replace it with "41 01 0b" (i32.const 1; end)',
  },
  {
    name: 'gc-on-transition',
    target: 'Platform.get_MaximumSceneTransitionsWithoutNonCriticalGarbageCollection',
    why: 'a value of 0 means "never skip GC"; some builds ship a large number',
    shape: 'the constant is an i32 immediate in a small getter — confirm with --scan and patch by hand',
  },
];

export const PATCHES = { frameWorkPatches, patchFramework, WASM_PATCH_LIBRARY };
