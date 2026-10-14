# Wasm patch files

`prepare-build.mjs` applies every `*.json` in this folder to the wasm module
*after verifying the original bytes*. A patch that does not match the build in
front of it is skipped and reported — it can never quietly corrupt a module.

Nothing ships here by default, because the offsets depend on the exact game and
Unity build. To add one:

```bash
node tools/prepare-build.mjs --scan "/path/to/silksong.wasm"
node tools/prepare-build.mjs --scan "/path/to/silksong.wasm" --json > candidates.json
```

`--scan` lists functions of the shape Unity's desktop memory-limit checks
compile to (a body ending in `local.get N; end` that compares floating-point
constants, e.g. `IsUnloadAssetsRequired()`). Confirm the one you want — usually
by checking that patching it makes room transitions unload assets — then write:

```json
{
  "for": "Silksong 1.0.30000 · Unity 2022.3.62f1",
  "patches": [
    {
      "name": "unload-assets-always",
      "why": "make IsUnloadAssetsRequired() return true so every room change runs Resources.UnloadUnusedAssets()",
      "offset": 6527956,
      "expect": "20 01 0b",
      "replace": "41 01 0b"
    }
  ]
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `name` | shown in the report and in `build-manifest.json` |
| `why` | free text, also recorded |
| `offset` | byte offset in the wasm module |
| `mode` | `"search"` finds `expect` anywhere instead of at `offset` (use right after a game update, when everything moved) |
| `expect` | the bytes that must be there (hex, spaces optional) |
| `replace` | the bytes to write — **same length** as `expect` |

The tails you are looking for in a compiled `bool IsXRequired()` are
`20 xx 0b` (`local.get xx; end`) → `41 01 0b` (`i32.const 1; end`) to force
`true`, or `41 00 0b` to force `false`.

Reverting a patch means rebuilding without the file, or `git checkout`-ing the
prepared output — the source build is never modified.

See [../BUILD.md §4](../BUILD.md#4-patching-the-build-the-memory-work) for the
full context and for the framework-level patches that *are* shipped.
