/* Tests for the external community-build descriptor and lazy ZIP mount. */
import { section, test, eq, ok, rejects, done } from './testkit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { makePlaceholderVideo } from './unity-webdata.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const community = require('../js/community-build.js');
const stream = require('../js/stream.js');
const zip = require('../js/zip.min.js');
const source = JSON.parse(fs.readFileSync(path.join(WEB, 'community-build.json'), 'utf8'));

// The commit the art-preserving archive was published from, pinned by the
// descriptor instead of relying on the mutable `art-preserved-20261017` tag.
const PIN = 'a2c4553a3e40ee536672eabb39341856e0ba35ee';
const RAW_BASE = 'https://raw.githubusercontent.com/kinggerb/silksongcode/' + PIN + '/parts/';
const MIRROR_BASE = 'https://cdn.jsdelivr.net/gh/kinggerb/silksongcode@' + PIN + '/parts/';

/**
 * A fetch stub that answers per host and records every request. A verdict is
 * a status to answer with, `ok`, or `unreachable` to throw the way a host that
 * cannot be reached at all does.
 */
function stubFetch(verdicts) {
  const requests = [];
  const impl = async (url, init) => {
    const target = String(url);
    requests.push({ url: target, init });
    const verdict = verdicts[new URL(target).host] || 'ok';
    if (verdict === 'unreachable') throw new TypeError('Failed to fetch');
    if (verdict === 'ok') return new Response('part bytes', { status: 200 });
    return new Response('refused', { status: verdict });
  };
  return { impl, requests };
}

const urlsOf = (stub) => stub.requests.map((r) => r.url);

/**
 * A sink that keeps the download in memory but behaves like the disk one the
 * page uses: positional writes, resume, markers (see web/js/stream.js). The
 * end-to-end tests below drive the real streamer with it.
 */
function fakeDiskSink() {
  const files = new Map();
  let buffer = null;
  let size = 0;
  return {
    sequentialOnly: false,
    stat: (name) => (files.has(name) ? String(files.get(name)).length : -1),
    getText: (name) => (files.has(name) ? String(files.get(name)) : null),
    putText: (name, text) => files.set(name, text),
    remove: (name) => files.delete(name),
    open: () => Promise.resolve({ size: size, canResume: size > 0 }),
    write: (u8, at) => {
      if (!buffer || buffer.length < at + u8.byteLength) {
        const bigger = new Uint8Array(at + u8.byteLength);
        if (buffer) bigger.set(buffer);
        buffer = bigger;
      }
      buffer.set(u8, at);
      size = Math.max(size, at + u8.byteLength);
      return Promise.resolve();
    },
    finish: () => Promise.resolve({ size: size }),
    getFile: () => new Blob([buffer ? buffer.subarray(0, size) : new Uint8Array(0)]),
    abort: () => Promise.resolve(),
    destroy: () => {},
    bytes: () => (buffer ? buffer.subarray(0, size) : new Uint8Array(0)),
  };
}
const hostCount = (stub, host) => stub.requests.filter((r) => new URL(r.url).host === host).length;

section('source descriptor');

await test('the pinned community source has a consistent resumable archive plan', () => {
  eq(community.validate(source), source, 'valid configuration returned');
  eq(source.commit, 'bcbe014765f2f6ca4b1d82ac25755a0299a600ab', 'source commit pinned');
  eq(source.assetArchive.parts.length, 111, 'all remote archive shards listed');
  eq(source.assetArchive.total, 1847328572, 'total size matches shard sizes');
  eq(source.assetArchive.previousCacheKeys.join(), 'webgl-assets-bcbe014.zip', 'the old texture-stripped cache is scheduled for deletion');
  const parts = community.parts(source, 'https://assets.example/game/');
  eq(parts[0].url, 'https://assets.example/game/WebGL.zip.part1', 'first shard resolves at the override base');
  eq(parts.at(-1).bytes, 1834812, 'last shard size is exact');
  eq(community.parts(source)[0].url, source.assetArchive.base + 'WebGL.zip.part1', 'the slim archive names its own base');
  eq(source.assetArchive.total < 2083139638, true, 'the art-preserving archive is smaller than the 1986.6 MiB original');
});

await test('the archive parts come from GitHub raw, with jsDelivr as the mirror', () => {
  // jsDelivr refuses a GitHub package larger than its own limit (150 MB, and
  // this archive is 1.72 GiB) with `403 Package size exceeded the configured
  // limit` — but only for the parts it has not already cached, so a download
  // can get a few parts in and then die. raw.githubusercontent.com serves any
  // committed blob under 100 MB and a part is 16 MiB, so it leads now and
  // jsDelivr is the fallback. The same published bytes are served by both.
  eq(source.assetArchive.base, RAW_BASE, 'the archive leads with GitHub raw');
  eq(source.assetArchive.mirror, MIRROR_BASE, 'and keeps jsDelivr as its mirror');
  eq(new URL(source.assetArchive.base).host, 'raw.githubusercontent.com', 'base host');
  eq(new URL(source.assetArchive.mirror).host, 'cdn.jsdelivr.net', 'mirror host');
  ok(source.assetArchive.base.includes(PIN), 'the base is pinned to the publish commit');
  ok(source.assetArchive.mirror.includes(PIN), 'and so is the mirror');
  ok(!source.assetArchive.base.includes('art-preserved-20261017'), 'pinned to a commit, not to the moving publication tag');
  // The same relative path has to exist on both hosts, or the fallback would
  // ask for a file that is not there. Part 6 is the one that used to 403.
  eq(community.parts(source)[5].url, RAW_BASE + 'WebGL.zip.part6', 'part 6 resolves on GitHub raw');
  // …and everything else about the archive is exactly as it was published.
  eq(source.assetArchive.total, 1847328572, 'published total is pinned');
  eq(source.assetArchive.parts.length, 111, 'all 111 parts are pinned');
  eq(source.assetArchive.slim, true, 'the descriptor marks the edited archive as slim');
  eq(source.assetArchive.cacheKey, 'webgl-assets-bcbe014-art-preserved-20261017.zip', 'new cacheKey invalidates the bad archive');
  eq(source.assetArchive.mime, 'application/zip', 'mime unchanged');
  eq(
    source.base,
    'https://cdn.jsdelivr.net/gh/web-ports/hollow-knight-silksong@bcbe014765f2f6ca4b1d82ac25755a0299a600ab/',
    'the Unity build files stay on their own CDN — only the archive moved'
  );
});

await test('a descriptor with an unusable archive host is refused', () => {
  for (const bad of [42, '', {}, null]) {
    for (const field of ['base', 'mirror']) {
      const copy = JSON.parse(JSON.stringify(source));
      copy.assetArchive[field] = bad;
      let refused = false;
      try {
        community.validate(copy);
      } catch (error) {
        refused = new RegExp('invalid asset archive ' + field).test(error.message);
      }
      eq(refused, true, 'a ' + field + ' of ' + JSON.stringify(bad) + ' cannot be downloaded from');
    }
  }
  const optional = JSON.parse(JSON.stringify(source));
  delete optional.assetArchive.mirror;
  eq(community.validate(optional), optional, 'the mirror is optional: without one the descriptor is still valid');
});

await test('a descriptor with incorrect archive arithmetic is refused', () => {
  const bad = JSON.parse(JSON.stringify(source));
  bad.assetArchive.total++;
  let refused = false;
  try { community.validate(bad); } catch (error) { refused = /total does not match/.test(error.message); }
  eq(refused, true, 'mismatched total cannot be downloaded');
});

await test('the archive downloader always requires disk-backed storage', async () => {
  let seen;
  const removed = [];
  const fakeStream = {
    removeDatasetPrefix: async (key) => { removed.push(key); return 7; },
    ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; },
  };
  await community.ensureArchive(source, { stream: fakeStream, base: 'https://assets.example/game/' });
  eq(removed.join(), 'webgl-assets-bcbe014.zip', 'the obsolete art-stripped archive and its lazy parts are discarded');
  eq(seen.allowMemoryFallback, false, 'a 2 GB archive is never allowed to spill into RAM');
  eq(seen.preferDisk, true, 'OPFS is preferred');
  eq(seen.expectedSize, source.assetArchive.total, 'expected size carried through');
  eq(seen.parts.length, 111, 'all shards provided to the resumable streamer');
});

section('the mirrored archive hosts');

await test('a part the archive host refuses with 403 is asked for again from the mirror', async () => {
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 'ok' });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6', { cache: 'default' });
  eq(res.ok, true, 'the download still gets its bytes');
  eq(stub.requests.length, 2, 'exactly two requests: the refused one and the retry');
  eq(urlsOf(stub)[0], RAW_BASE + 'WebGL.zip.part6', 'the archive host is asked first');
  eq(urlsOf(stub)[1], MIRROR_BASE + 'WebGL.zip.part6', 'the mirror is asked for the very same path');
  eq(stub.requests[1].init, stub.requests[0].init, 'and with the very same request options');
});

await test('a part whose host cannot be reached at all is asked for from the mirror', async () => {
  // A host that is blocked, off the network or fails TLS throws instead of
  // answering, and there is no status to look at — the mirror is still the
  // only second opinion there is.
  const stub = stubFetch({ 'raw.githubusercontent.com': 'unreachable', 'cdn.jsdelivr.net': 'ok' });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.status, 200, 'the mirror answered');
  eq(urlsOf(stub).join(' | '), RAW_BASE + 'WebGL.zip.part6 | ' + MIRROR_BASE + 'WebGL.zip.part6', 'one retry, at the same path');
});

await test('a retry consults the mirror once and keeps its verdict', async () => {
  // Two hosts that both say no must not be given a third opinion each: the
  // download would ping-pong for ever instead of reporting the failure.
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.ok, false, 'the refusal reaches the downloader');
  eq(res.status, 403, 'as the mirror\'s own answer');
  eq(hostCount(stub, 'raw.githubusercontent.com'), 1, 'the archive host was asked once');
  eq(hostCount(stub, 'cdn.jsdelivr.net'), 1, 'and the mirror was asked once — no ping-pong');
});

await test('the retry covers refusals, missing parts, rate limits and server errors', async () => {
  for (const status of [403, 404, 408, 429, 500, 502, 503, 504]) {
    const stub = stubFetch({ 'raw.githubusercontent.com': status, 'cdn.jsdelivr.net': 'ok' });
    const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
    const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
    eq(res.status, 200, 'HTTP ' + status + ' fell back to the mirror');
    eq(stub.requests.length, 2, 'HTTP ' + status + ' retried exactly once');
  }
  // A 400 is about the request, not about the host: the mirror would answer it
  // the same way, so there is nothing to gain by asking.
  const stub = stubFetch({ 'raw.githubusercontent.com': 400, 'cdn.jsdelivr.net': 'ok' });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.status, 400, 'a 400 is handed back as it is');
  eq(stub.requests.length, 1, 'and not retried');
});

await test('a URL that is already on the mirror is never mirrored', async () => {
  // `?archiveBase=<the mirror>` puts the download on jsDelivr to begin with.
  // Falling back to the host that just refused would be pointless — and would
  // loop, since the "mirror" of a mirror URL is that same URL.
  const stub = stubFetch({ 'cdn.jsdelivr.net': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: MIRROR_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(MIRROR_BASE + 'WebGL.zip.part6');
  eq(res.status, 403, 'the refusal stands');
  eq(stub.requests.length, 1, 'the mirror was asked exactly once');
});

await test('a URL outside the archive\'s own root is left alone', async () => {
  // The Unity build files live on a different CDN. A 403 there is not
  // something the archive mirror can answer, and rewriting the host would ask
  // the mirror for a file it has never had.
  const stub = stubFetch({ 'cdn.jsdelivr.net': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE, mirror: MIRROR_BASE });
  const res = await mirrored(source.base + 'Build/w-pt.data.unityweb');
  eq(res.status, 403, 'passed through untouched');
  eq(stub.requests.length, 1, 'and not sent to the archive mirror');
  eq(urlsOf(stub)[0], source.base + 'Build/w-pt.data.unityweb', 'the URL was not rewritten');
});

await test('a descriptor without a mirror behaves exactly like the fetch it wraps', async () => {
  const stub = stubFetch({ 'raw.githubusercontent.com': 403 });
  const mirrored = community.mirrorFetch(stub.impl, { base: RAW_BASE });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part6');
  eq(res.status, 403, 'the answer is passed straight through');
  eq(stub.requests.length, 1, 'with nothing asked twice');
});

await test('the resumable streamer is handed the mirrored fetch, not the caller\'s own', async () => {
  let seen;
  const fakeStream = { ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; } };
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 'ok' });
  // No `base` override: the download runs from the descriptor's own host.
  await community.ensureArchive(source, { stream: fakeStream, fetchImpl: stub.impl });
  eq(typeof seen.fetchImpl, 'function', 'the streamer got a fetch to download with');
  ok(seen.fetchImpl !== stub.impl, 'and it is the wrapped one, not the caller\'s own');
  eq(seen.parts[5].url, RAW_BASE + 'WebGL.zip.part6', 'the parts it was given are on the archive host');
  const res = await seen.fetchImpl(RAW_BASE + 'WebGL.zip.part6', { cache: 'default' });
  eq(res.status, 200, 'so a refused part is answered from the mirror');
  eq(urlsOf(stub).join(' | '), RAW_BASE + 'WebGL.zip.part6 | ' + MIRROR_BASE + 'WebGL.zip.part6', 'base first, mirror second');
});

await test('the archive plan reads its index through the same mirrored fetch', async () => {
  // The pinned archive is already slim, so the plan step is skipped for it —
  // but a descriptor that still has to be planned reads the ZIP's index with
  // a few hundred range requests against the same hosts, and those are the
  // requests most likely to be refused first.
  const notSlim = JSON.parse(JSON.stringify(source));
  delete notSlim.assetArchive.slim;
  let readerFetch;
  const fakeZip = {
    createReader: (partList, opts) => { readerFetch = opts.fetchImpl; return { ranges: true }; },
    readIndex: async () => null, // nothing to plan here; the fetch is the point
  };
  let seen;
  const fakeStream = { ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; } };
  const stub = stubFetch({ 'raw.githubusercontent.com': 403, 'cdn.jsdelivr.net': 'ok' });
  await community.ensureArchive(notSlim, { stream: fakeStream, zip: fakeZip, fetchImpl: stub.impl });
  eq(typeof readerFetch, 'function', 'the ZIP reader got a fetch');
  ok(readerFetch !== stub.impl, 'the wrapped one');
  eq(readerFetch, seen.fetchImpl, 'and the plan and the download share a single wrapper');
  const lastPart = community.parts(source).at(-1).url;
  const res = await readerFetch(lastPart, { headers: { Range: 'bytes=0-15' } });
  eq(res.status, 200, 'a refused range request is answered from the mirror');
  eq(stub.requests[1].init.headers.Range, 'bytes=0-15', 'with the very same byte range');
});

section('waiting out a rate limit');

/**
 * A clock that only moves when the test says so. `sleep` can also be made to
 * block until the test releases it, which is how a pause is held open long
 * enough for a second part to walk into it.
 */
function fakeClock() {
  const state = { now: 0, waits: [] };
  let release = null;
  let holding = null;
  return {
    now: () => state.now,
    waits: state.waits,
    sleep: async (ms) => {
      // Two parts waiting out the same pause share the clock: whichever of
      // them finishes last cannot push time past the end of that pause.
      const started = state.now;
      state.waits.push(ms);
      if (holding) await holding;
      state.now = Math.max(state.now, started + ms);
    },
    advance: (ms) => {
      state.now += ms;
    },
    hold: () => {
      holding = new Promise((resolve) => { release = resolve; });
    },
    release: () => {
      if (release) release();
      holding = null;
    },
  };
}

/**
 * A fetch that answers each host from a script — one verdict per request, the
 * last one repeated — and records when (on the fake clock) it was asked.
 */
function scriptedFetch(script, seen, clock) {
  const taken = Object.create(null);
  return async (url) => {
    const target = String(url);
    const host = new URL(target).host;
    const at = taken[host] || 0;
    taken[host] = at + 1;
    if (seen) seen.push({ url: target, host, at: clock ? clock.now() : at });
    const list = script[host] || ['ok'];
    const verdict = list[Math.min(at, list.length - 1)];
    if (verdict === 'unreachable') throw new TypeError('Failed to fetch');
    if (verdict === 'ok') return new Response('part bytes', { status: 200 });
    // `{ status, headers }` — a refusal that also says how long it wants.
    if (verdict && typeof verdict === 'object') {
      return new Response('refused', { status: verdict.status || 403, headers: verdict.headers });
    }
    return new Response('refused', { status: verdict });
  };
}

await test('a 403 from GitHub raw is waited out instead of ending the download', async () => {
  // The failure that stopped a download a third of the way in: raw answers
  // 403 because the page has had its share of files for the hour, and the
  // page used to give up a few seconds later.
  const clock = fakeClock();
  const seen = [];
  const impl = scriptedFetch({ 'raw.githubusercontent.com': [403, 'ok'], 'cdn.jsdelivr.net': [403] }, seen, clock);
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });

  const res = await mirrored(RAW_BASE + 'WebGL.zip.part28');
  eq(res.status, 200, 'the part arrives as soon as GitHub lets us have it');
  eq(clock.waits.length, 1, 'one pause, not a give-up');
  eq(clock.waits[0], community.RATE_LIMIT_WAITS[0], 'and it starts with the shortest one');
  eq(seen.length, 3, 'raw, then the mirror, then raw again — three requests');
  eq(seen[2].host, 'raw.githubusercontent.com', 'the part itself was asked for again');
  eq(seen[2].at, clock.waits[0], 'after the pause, not during it');
});

await test('a pause is shared: a second part waits for it instead of spending a request', async () => {
  const clock = fakeClock();
  clock.hold(); // the pause stays open until the test lets it go
  const seen = [];
  const impl = scriptedFetch({ 'raw.githubusercontent.com': [403, 'ok', 'ok'], 'cdn.jsdelivr.net': [403] }, seen, clock);
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });

  const first = mirrored(RAW_BASE + 'WebGL.zip.part28');
  // Wait for the first part to have been refused by both hosts and to be
  // inside its pause.
  while (clock.waits.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = mirrored(RAW_BASE + 'WebGL.zip.part29');
  // …and let the second one get as far as it can.
  while (clock.waits.length < 2) await new Promise((resolve) => setImmediate(resolve));
  clock.release();
  const answers = await Promise.all([first, second]);

  eq(answers[0].status, 200, 'the refused part came back after the pause');
  eq(answers[1].status, 200, 'and the one that walked into the pause got its bytes too');
  eq(clock.waits.join(), '30000,30000', 'one pause, waited out by both parts');
  const secondAsks = seen.filter((r) => r.url.endsWith('part29'));
  eq(secondAsks.length, 1, 'the second part asked exactly once');
  eq(secondAsks[0].at, 30000, 'after the pause was over — it did not spend a request on it');
});

await test('refusals that arrive together are one round, not one escalation each', async () => {
  // Three parts refused in the same breath are one piece of news. Six parts
  // are on the wire at once, so without this the shared pause would jump to
  // the longest wait the moment the limit hit.
  const clock = fakeClock();
  clock.hold(); // keep the pause open until all three are inside it
  const impl = scriptedFetch({ 'raw.githubusercontent.com': [403, 403, 403, 'ok'], 'cdn.jsdelivr.net': [403] });
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });

  const running = [
    mirrored(RAW_BASE + 'WebGL.zip.part28'),
    mirrored(RAW_BASE + 'WebGL.zip.part29'),
    mirrored(RAW_BASE + 'WebGL.zip.part30'),
  ];
  for (let i = 0; i < 200 && clock.waits.length < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  clock.release();
  const answers = await Promise.all(running);

  eq(answers.map((a) => a.status).join(), '200,200,200', 'all three came back after the pause');
  eq(clock.waits.length, 3, 'one wait each');
  eq(
    clock.waits.join(),
    [community.RATE_LIMIT_WAITS[0], community.RATE_LIMIT_WAITS[0], community.RATE_LIMIT_WAITS[0]].join(),
    'and all three waited the same 30 s — not 30 s, then 1 min, then 2 min'
  );
  eq(limit.spentMs(), community.RATE_LIMIT_WAITS[0], 'the budget was charged once, not three times');
});

await test('the status line counts down instead of sitting on one sentence', async () => {
  // A quarter of an hour of "please wait" reads as a hung tab, so the page is
  // told how much of the pause is left, over and over.
  const clock = fakeClock();
  const statuses = [];
  const impl = scriptedFetch({ 'raw.githubusercontent.com': [403, 'ok'], 'cdn.jsdelivr.net': [403] });
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, {
    base: RAW_BASE,
    mirror: MIRROR_BASE,
    rateLimit: limit,
    onStatus: (message) => statuses.push(message),
  });

  eq((await mirrored(RAW_BASE + 'WebGL.zip.part28')).status, 200, 'the part arrived after the pause');
  ok(statuses.length >= 3, 'the page was told more than once: ' + statuses.length + ' updates');
  ok(/pausing 30 s/.test(statuses[0]), 'first why: ' + statuses[0]);
  ok(/to go/.test(statuses[1]), 'then how long is left: ' + statuses[1]);
  ok(/Nothing is lost/.test(statuses.join(' ')), 'and every time that nothing is lost');
});

await test("jsDelivr's own 403 is not waited out: it is about the package, not the hour", async () => {
  // `403 Package size exceeded the configured limit of 150 MB` will still be
  // true in an hour, so there is nothing to wait for — and the mirror is not
  // asked again for the rest of the download either.
  const clock = fakeClock();
  const seen = [];
  const impl = scriptedFetch({ 'cdn.jsdelivr.net': [403], 'raw.githubusercontent.com': [403] }, seen, clock);
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  // The mirror leads here (in the descriptor it is the other way round), so
  // the refusal the policy has to judge is jsDelivr's.
  const mirrored = community.mirrorFetch(impl, { base: MIRROR_BASE, mirror: RAW_BASE, rateLimit: limit });

  const res = await mirrored(MIRROR_BASE + 'WebGL.zip.part28');
  eq(res.status, 403, 'the refusal stands');
  eq(clock.waits.length, 0, 'nothing was waited out');
  eq(seen.length, 2, 'one request each, and then it stopped');
});

await test('the waiting stops when its budget is spent, and the log says why', async () => {
  const clock = fakeClock();
  const logs = [];
  const impl = scriptedFetch({ 'raw.githubusercontent.com': [403], 'cdn.jsdelivr.net': [403] });
  const limit = community.rateLimiter({
    now: clock.now,
    sleep: clock.sleep,
    budgetMs: 45000,
    waits: [30000, 60000],
    onLog: (line) => logs.push(line),
  });
  const mirrored = community.mirrorFetch(impl, {
    base: RAW_BASE,
    mirror: MIRROR_BASE,
    rateLimit: limit,
    onLog: (line) => logs.push(line),
  });

  const res = await mirrored(RAW_BASE + 'WebGL.zip.part28');
  eq(res.status, 403, 'the downloader is told what happened');
  eq(clock.waits.join(), '30000', 'one pause of 30 s: the next one would overrun the budget');
  ok(logs.some((line) => /giving up/.test(line)), 'and the log explains it: ' + logs.join(' | '));
  ok(logs.some((line) => /rate-limiting/.test(line)), 'after telling the user what it is waiting for: ' + logs.join(' | '));
});

await test('a part that gets through starts the escalation over', async () => {
  const clock = fakeClock();
  const impl = scriptedFetch({ 'raw.githubusercontent.com': [403, 'ok', 403, 'ok'], 'cdn.jsdelivr.net': [403] });
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });

  eq((await mirrored(RAW_BASE + 'WebGL.zip.part28')).status, 200, 'the first part needed one pause');
  eq((await mirrored(RAW_BASE + 'WebGL.zip.part29')).status, 200, 'the second one too');
  eq(clock.waits.join(), '30000,30000', 'the second pause is short again — the host was answering in between');
});

await test('a host that cannot be reached is not waited out: that is not a rate limit', async () => {
  // DNS, TLS, a reset connection: there is no status to read and no hour to
  // sit out. The mirror is still asked, and the downloader's own backoff
  // still covers a blip — waiting on the page would only add minutes.
  const clock = fakeClock();
  const seen = [];
  const impl = scriptedFetch({ 'raw.githubusercontent.com': ['unreachable'], 'cdn.jsdelivr.net': [403] }, seen, clock);
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });
  const res = await mirrored(RAW_BASE + 'WebGL.zip.part28');
  eq(res.status, 403, "the answer is the mirror's own");
  eq(clock.waits.length, 0, 'nothing was waited out');
  eq(seen.length, 2, 'the host was tried once and the mirror once');
  eq(
    community.archiveRetryAfter()(new Error('Failed to fetch')),
    null,
    'and the downloader keeps its own backoff for an unreachable host'
  );
});

await test("GitHub's own `retry-after` is what the page waits for", async () => {
  // When raw exposes the header — it usually does not, cross-origin — there is
  // nothing to guess: the host knows when its own window opens again.
  const clock = fakeClock();
  const impl = scriptedFetch({
    'raw.githubusercontent.com': [{ status: 403, headers: { 'retry-after': '45' } }, 'ok'],
    'cdn.jsdelivr.net': [403],
  });
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });
  eq((await mirrored(RAW_BASE + 'WebGL.zip.part28')).status, 200, 'the part came back when GitHub said it would');
  eq(clock.waits.join(), '45000', 'it waited the 45 s it was told to, not the 30 s it would have guessed');
});

await test('`x-ratelimit-reset` is read the same way', async () => {
  const clock = fakeClock();
  const impl = scriptedFetch({
    'raw.githubusercontent.com': [{ status: 403, headers: { 'x-ratelimit-reset': '120' } }, 'ok'],
    'cdn.jsdelivr.net': [403],
  });
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const mirrored = community.mirrorFetch(impl, { base: RAW_BASE, mirror: MIRROR_BASE, rateLimit: limit });
  eq((await mirrored(RAW_BASE + 'WebGL.zip.part28')).status, 200, 'the part came back');
  eq(clock.waits.join(), '120000', 'two minutes: the reset time minus the clock');
});

await test('a hint that has gone by costs seconds, not another round of guessing', async () => {
  // Six parts are refused together with `retry-after: 3600`. The first one
  // waits the hour; by the time the others act on their own copy of that
  // answer, the hour has gone by.
  const clock = fakeClock();
  const limit = community.rateLimiter({ now: clock.now, sleep: clock.sleep });
  const deadline = clock.now() + 3600000;
  eq(limit.pause(deadline), 3600000, 'a deadline in the future is what is left of it');
  clock.advance(3600000);
  eq(limit.pause(deadline), 5000, 'and one that has passed costs the floor — not another 15 min');
});

await test('the downloader does not spend its own retries on a rate limit', () => {
  const after = community.archiveRetryAfter();
  const limited = { status: 403, url: RAW_BASE + 'WebGL.zip.part28' };
  eq(after(limited), -1, 'a rate limit is not retried by the downloader — the fetch waited it out');
  eq(after({ status: 429, url: RAW_BASE + 'WebGL.zip.part28' }), -1, 'a 429 is the same thing said plainly');
  eq(after({ status: 500, url: RAW_BASE + 'WebGL.zip.part28' }), null, 'an ordinary failure keeps the built-in backoff');
  eq(after({ status: 403, url: MIRROR_BASE + 'WebGL.zip.part28' }), null, "and so does a refusal that is not GitHub's");
  eq(after(new Error('connection reset')), null, 'and so does a host that could not be reached at all');
});

await test('the downloader is handed that backoff, but only when waiting is possible', async () => {
  let seen;
  const fakeStream = { ensureDataset: async (options) => { seen = options; return { file: new Blob(['fake']) }; } };
  const okFetch = () => new Response('part bytes', { status: 200 });

  await community.ensureArchive(source, { stream: fakeStream, fetchImpl: okFetch });
  eq(typeof seen.retryAfter, 'function', 'the streamer was handed a backoff');
  eq(seen.retryAfter({ status: 403, url: RAW_BASE + 'WebGL.zip.part28' }), -1, 'that gives up on a rate limit');

  await community.ensureArchive(source, { stream: fakeStream, fetchImpl: okFetch, rateLimit: false });
  eq(seen.retryAfter, null, 'with the waiting turned off the streamer keeps its own backoff');
});

await test('a download that is rate limited a third of the way in finishes instead of dying', async () => {
  // The failure as it was reported: `HTTP 403 for …/parts/WebGL.zip.part28`,
  // a third of the way through seventy-five parts. Scaled down — six parts,
  // GitHub refusing from the fourth, the real streamer and the real fetch
  // wrapper — and run on a clock the test controls.
  const clock = fakeClock();
  const logs = [];
  const asked = { 'raw.githubusercontent.com': 0, 'cdn.jsdelivr.net': 0 };
  const small = JSON.parse(JSON.stringify(source));
  const PART = 1024;
  small.assetArchive.parts = [1, 2, 3, 4, 5, 6].map((n) => ({ path: 'WebGL.zip.part' + n, bytes: PART }));
  small.assetArchive.total = 6 * PART;
  small.assetArchive.slim = true; // nothing to plan, straight to the download

  const impl = async (url) => {
    const target = String(url);
    const host = new URL(target).host;
    const part = Number(target.match(/part(\d+)$/)[1]);
    asked[host]++;
    // GitHub answers the first three parts and then has had enough — for two
    // pauses' worth of asking, which is all the patience it takes here.
    if (host === 'raw.githubusercontent.com' && part > 3 && clock.waits.length < 2) {
      return new Response('refused', { status: 403 });
    }
    if (host === 'cdn.jsdelivr.net') return new Response('refused', { status: 403 });
    return new Response(new Uint8Array(PART).fill(part), { status: 200 });
  };

  const sink = fakeDiskSink();
  const set = await community.ensureArchive(small, {
    stream: stream,
    writerFactory: async () => sink,
    fetchImpl: impl,
    now: clock.now,
    sleep: clock.sleep,
    onLog: (line) => logs.push(line),
  });

  eq(set.size, 6 * PART, 'all six parts are on "disk"');
  const bytes = sink.bytes();
  let assembled = true;
  for (let n = 1; n <= 6; n++) {
    for (let i = 0; i < PART; i++) {
      if (bytes[(n - 1) * PART + i] !== n) assembled = false;
    }
  }
  ok(assembled, 'and every part landed at its own offset');
  ok(clock.waits.length >= 1, 'the refusal was waited out (' + clock.waits.join() + ' ms of pauses)');
  ok(asked['raw.githubusercontent.com'] > 6, 'the refused parts were asked for again (' + asked['raw.githubusercontent.com'] + ' requests)');
  ok(logs.some((line) => /rate-limiting/.test(line)), 'the user was told what the page is waiting for');
});

await test('the same refusal ends the download when the waiting is switched off', async () => {
  // What it did before, and what ?archiveWait=0-ish callers still get: four
  // quick retries that a rate limit does not care about, and then a dead
  // download a third of the way in.
  const logs = [];
  const small = JSON.parse(JSON.stringify(source));
  const PART = 512;
  small.assetArchive.parts = [1, 2, 3, 4].map((n) => ({ path: 'WebGL.zip.part' + n, bytes: PART }));
  small.assetArchive.total = 4 * PART;
  small.assetArchive.slim = true;
  const impl = async (url) => {
    const host = new URL(String(url)).host;
    if (host === 'cdn.jsdelivr.net') return new Response('refused', { status: 403 });
    return new Response('refused', { status: 403 });
  };
  const message = await rejects(
    community.ensureArchive(small, {
      stream: stream,
      writerFactory: async () => fakeDiskSink(),
      fetchImpl: impl,
      rateLimit: false,
      retryAttempts: 0,
      onLog: (line) => logs.push(line),
    }),
    /HTTP 403/,
    'a rate-limited download'
  );
  ok(/raw\.githubusercontent\.com/.test(message), 'and it names the host that refused it: ' + message);
  ok(!logs.some((line) => /rate-limiting/.test(line)), 'nothing was waited out');
});

section('ZIP-backed Addressables');

await test('it resolves one Unity bundle from the ZIP without expanding the archive', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/packed-test.bundle', new zip.TextReader('test bundle bytes'));
  const file = await writer.close();
  const mount = await community.openArchive(file, zip);
  eq(mount.entryCount, 1, 'the archive directory was read');
  const entry = mount.entryFor('https://game.example/StreamingAssets/aa/WebGL/packed-test.bundle');
  ok(entry, 'Unity StreamingAssets path matched the ZIP entry');
  const blob = await mount.blobFor(entry);
  eq(await blob.text(), 'test bundle bytes', 'only the requested bundle was extracted');
  await mount.close();
});

await test('the fetch adapter serves ZIP entries, supports byte ranges, and passes other URLs through', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('packed-demo.bundle', new zip.TextReader('0123456789'));
  const mount = await community.openArchive(await writer.close(), zip);
  const requests = [];
  const target = {
    fetch: async (url) => { requests.push(String(url)); return new Response('network fallback'); },
  };
  const restore = community.installFetchMount(target, mount);

  const full = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-demo.bundle');
  eq(full.status, 200, 'full bundle response');
  eq(await full.text(), '0123456789', 'bundle came from the ZIP');

  const ranged = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-demo.bundle', {
    headers: { Range: 'bytes=2-5' },
  });
  eq(ranged.status, 206, 'range response');
  eq(await ranged.text(), '2345', 'only the requested byte range was returned');
  eq(ranged.headers.get('content-range'), 'bytes 2-5/10', 'range metadata is correct');

  const fallback = await target.fetch('https://game.example/StreamingAssets/aa/catalog.bin');
  eq(await fallback.text(), 'network fallback', 'regular StreamingAssets still use the CDN');
  eq(requests.length, 1, 'only non-ZIP files reached the network');
  restore();
  await mount.close();
});

await test('lazy ZIP serves requested bundle data and surfaces a failed part', async () => {
  // Exercise the disk-backed part reader, the ZIP entry lookup and the fetch
  // mount together. The filler makes the ZIP larger than the central-directory
  // tail read, so opening the index does not also fetch the bundle at the front.
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  const expectedBundles = [
    { path: 'aa/WebGL/packed-lazy.bundle', body: 'Unity requests this Addressables bundle' },
    { path: 'aa/WebGL/packed-lazy-next.bundle', body: 'Next requested Addressables bundle' },
    { path: 'aa/WebGL/packed-lazy-scene.bundle', body: 'Scene dependency Addressables bundle' },
  ];
  for (const entry of expectedBundles) await writer.add(entry.path, new zip.TextReader(entry.body));
  await writer.add('unused-filler.bin', new zip.Uint8ArrayReader(randomBytes(96 * 1024)));
  const zipBlob = await writer.close();
  const bytes = new Uint8Array(await zipBlob.arrayBuffer());
  const partSize = 16 * 1024;
  const shards = [];
  for (let at = 0; at < bytes.length; at += partSize) shards.push(bytes.slice(at, at + partSize));

  const config = JSON.parse(JSON.stringify(source));
  config.assetArchive.base = 'https://assets.example/lazy/';
  config.assetArchive.cacheKey = 'lazy-integration-test.zip';
  config.assetArchive.total = bytes.length;
  config.assetArchive.parts = shards.map((shard, index) => ({
    path: 'WebGL.zip.part' + (index + 1), bytes: shard.length,
  }));
  const fakeStream = (failPart, requested) => ({
    ensureDataset: async (options) => {
      const url = options.parts[0].url;
      const part = Number(url.match(/part(\d+)$/)[1]);
      requested.push(part);
      if (part === failPart) throw new Error('HTTP 503 for ' + url);
      return { file: new Blob([shards[part - 1]]), kind: 'network', dispose() {} };
    },
  });

  const requested = [];
  const mount = await community.openLazyArchive(config, {
    stream: fakeStream(0, requested), zip, skipCompleteCache: true,
    bundleCacheBytes: 0, concurrency: 3,
  });
  const assets = [];
  const target = { fetch: async () => new Response('network fallback') };
  const restore = community.installFetchMount(target, mount, { onAsset: (name) => assets.push(name) });
  for (const entry of expectedBundles) {
    const response = await target.fetch('https://game.example/StreamingAssets/' + entry.path);
    eq(await response.text(), entry.body, 'Unity gets every requested bundle from its ZIP entry: ' + entry.path);
  }
  eq(assets.join('|'), expectedBundles.map((entry) => entry.path).join('|'), 'the local-ZIP log identifies each requested bundle');
  ok(requested.includes(1), 'the part containing the requested bundles was fetched');
  ok(new Set(requested).size < shards.length, 'unrequested ZIP parts were not downloaded');
  restore();
  await mount.close();

  const failedRequests = [];
  const failedMount = await community.openLazyArchive(config, {
    stream: fakeStream(1, failedRequests), zip, skipCompleteCache: true,
    bundleCacheBytes: 0, concurrency: 3,
  });
  const errors = [];
  const failedTarget = { fetch: async () => new Response('network fallback') };
  const restoreFailed = community.installFetchMount(failedTarget, failedMount, {
    onAssetError: (name, error) => errors.push({ name, message: error.message }),
  });
  const message = await rejects(
    failedTarget.fetch('https://game.example/StreamingAssets/aa/WebGL/packed-lazy.bundle'),
    /HTTP 503/,
    'a failed lazy ZIP part'
  );
  ok(/WebGL\.zip\.part1/.test(message), 'the error names the part that failed: ' + message);
  eq(errors.length, 1, 'the page callback was notified exactly once');
  eq(errors[0].name, 'aa/WebGL/packed-lazy.bundle', 'the error identifies the requested bundle');
  ok(/HTTP 503/.test(errors[0].message), 'the original part error is preserved');
  restoreFailed();
  await failedMount.close();
});

section('streamed bundle delivery (no in-RAM Blob between ZIP and Unity)');

function patternedBytes(length, seed) {
  let x = seed;
  return Uint8Array.from({ length }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x & 255; });
}

await test('a large bundle streams byte-for-byte, with ranges, suffix ranges and a 416', async () => {
  const payload = patternedBytes(700 * 1024, 1234567);
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/streamed-big.bundle', new zip.Uint8ArrayReader(payload), { level: 6 });
  const mount = await community.openArchive(await writer.close(), zip);
  const target = { fetch: async () => new Response('network fallback') };
  const restore = community.installFetchMount(target, mount);
  const url = 'https://game.example/StreamingAssets/aa/WebGL/streamed-big.bundle';

  const full = await target.fetch(url);
  eq(full.status, 200, 'full streamed response');
  eq(full.headers.get('content-length'), String(payload.length), 'length declared up front');
  ok(Buffer.from(await full.arrayBuffer()).equals(Buffer.from(payload)), 'every byte arrived, in order');

  const ranged = await target.fetch(url, { headers: { Range: 'bytes=100000-100099' } });
  eq(ranged.status, 206, 'ranged streamed response');
  eq(ranged.headers.get('content-range'), 'bytes 100000-100099/' + payload.length, 'range metadata');
  ok(Buffer.from(await ranged.arrayBuffer()).equals(Buffer.from(payload.subarray(100000, 100100))), 'exactly the middle slice');

  const suffix = await target.fetch(url, { headers: { Range: 'bytes=-50' } });
  eq(suffix.status, 206, 'suffix range');
  ok(Buffer.from(await suffix.arrayBuffer()).equals(Buffer.from(payload.subarray(payload.length - 50))), 'exactly the last 50 bytes');

  const open = await target.fetch(url, { headers: { Range: 'bytes=' + (payload.length - 4) + '-' } });
  eq(open.status, 206, 'open-ended range');
  eq((await open.arrayBuffer()).byteLength, 4, 'to the end of the entry');

  const hopeless = await target.fetch(url, { headers: { Range: 'bytes=' + payload.length + '-' } });
  eq(hopeless.status, 416, 'a range past the end is refused without inflating anything');
  eq(hopeless.headers.get('content-range'), 'bytes */' + payload.length, 'with the real size named');

  const head = await target.fetch(url, { method: 'HEAD' });
  eq(head.status, 200, 'HEAD still answered from the directory alone');
  eq(head.headers.get('content-length'), String(payload.length), 'with the entry size');
  restore();

  // The opt-out serves the same bytes through the old Blob path.
  const blobTarget = { fetch: async () => new Response('network fallback') };
  const restoreBlob = community.installFetchMount(blobTarget, mount, { streamBundles: false });
  const viaBlob = await blobTarget.fetch(url, { headers: { Range: 'bytes=2-5' } });
  eq(viaBlob.status, 206, 'the Blob fallback still ranges');
  ok(Buffer.from(await viaBlob.arrayBuffer()).equals(Buffer.from(payload.subarray(2, 6))), 'with the same bytes');
  restoreBlob();
  await mount.close();
});

/** A fake ZIP entry whose inflation the test controls chunk by chunk. */
function fakeEntry({ chunkCount = 64, chunkSize = 16 * 1024, failAtChunk = -1, failure = null } = {}) {
  const written = { chunks: 0 };
  const entry = {
    filename: 'aa/WebGL/fake-stream.bundle',
    uncompressedSize: chunkCount * chunkSize,
    compressedSize: chunkCount * chunkSize,
    signature: 0,
    directory: false,
    async getData(writer) {
      for (let i = 0; i < chunkCount; i++) {
        if (i === failAtChunk) throw failure || new Error('CRC mismatch (fake)');
        await writer.writeUint8Array(new Uint8Array(chunkSize).fill(i & 255));
        written.chunks++;
      }
      return writer.getData ? writer.getData() : null;
    },
  };
  return { entry, written };
}

async function fakeMount(entry, options = {}) {
  return community.openArchive(new Blob([]), zip, { entries: [entry], ...options });
}

await test('backpressure reaches the inflater: a slow reader does not let chunks pile up', async () => {
  const { entry, written } = fakeEntry();
  const mount = await fakeMount(entry);
  const response = await mount.responseFor(entry, null, {});
  eq(response.status, 200, 'the response starts once the first chunk exists');
  // Nobody is reading the body. If delivery were still Blob-shaped, all
  // 64 chunks would already be written (that accumulation is exactly the
  // RAM this path exists not to spend).
  await new Promise((resolve) => setTimeout(resolve, 50));
  ok(written.chunks <= 4, 'inflation is parked waiting for the reader (' + written.chunks + ' of 64 chunks written)');
  const bytes = new Uint8Array(await response.arrayBuffer());
  eq(bytes.length, entry.uncompressedSize, 'reading drains the whole entry');
  eq(written.chunks, 64, 'every chunk written by the end');
  eq(bytes[0], 0, 'first chunk value');
  eq(bytes[bytes.length - 1], 63, 'last chunk value');
  await mount.close();
});

await test('cancelling a bundle read aborts the inflation and is not an error', async () => {
  const { entry, written } = fakeEntry();
  const mount = await fakeMount(entry);
  const errors = [];
  const streamed = mount.streamFor(entry, null, { onError: (e) => errors.push(e) });
  const reader = streamed.stream.getReader();
  const first = await reader.read();
  eq(first.done, false, 'a first chunk arrived');
  await reader.cancel();
  const settled = await Promise.race([
    streamed.done,
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 2000)),
  ]);
  ok(settled !== 'timed out', 'the pump settled after the cancel instead of hanging');
  eq(settled.cancelled, true, 'reported as a cancel');
  eq(errors.length, 0, 'a consumer cancel never reaches the bundle-error callback');
  ok(written.chunks < 64, 'inflation stopped (' + written.chunks + ' of 64 chunks)');
  await mount.close();
});

await test('a failure mid-stream errors the body and notifies once; before the first byte it rejects the fetch', async () => {
  const mid = fakeEntry({ failAtChunk: 3 });
  const midMount = await fakeMount(mid.entry);
  const midErrors = [];
  const midTarget = { fetch: async () => new Response('network fallback') };
  const restoreMid = community.installFetchMount(midTarget, midMount, {
    onAssetError: (name, error) => midErrors.push({ name, message: error.message }),
  });
  const partial = await midTarget.fetch('https://game.example/StreamingAssets/aa/WebGL/fake-stream.bundle');
  eq(partial.status, 200, 'headers were already earned by the first chunks');
  await rejects(partial.arrayBuffer(), /CRC mismatch/, 'reading the damaged body');
  eq(midErrors.length, 1, 'the page was told exactly once');
  eq(midErrors[0].name, 'aa/WebGL/fake-stream.bundle', 'and which bundle died');
  restoreMid();
  await midMount.close();

  const early = fakeEntry({ failAtChunk: 0, failure: new Error('HTTP 503 for WebGL.zip.part9') });
  const earlyMount = await fakeMount(early.entry);
  const earlyErrors = [];
  const earlyTarget = { fetch: async () => new Response('network fallback') };
  const restoreEarly = community.installFetchMount(earlyTarget, earlyMount, {
    onAssetError: (name, error) => earlyErrors.push({ name, message: error.message }),
  });
  const message = await rejects(
    earlyTarget.fetch('https://game.example/StreamingAssets/aa/WebGL/fake-stream.bundle'),
    /HTTP 503/,
    'a part that fails before the first byte'
  );
  ok(message.includes('part9'), 'the fetch rejection keeps the part error');
  eq(earlyErrors.length, 1, 'and the page callback fired once, not twice');
  restoreEarly();
  await earlyMount.close();
});

await test('range parsing is shared by both delivery paths', () => {
  eq(community.parseRangeHeader(null, 100), null, 'no header, no range');
  eq(community.parseRangeHeader('bytes=-', 100), null, 'an empty range is ignored, not ranged');
  eq(JSON.stringify(community.parseRangeHeader('bytes=10-19', 100)), JSON.stringify({ start: 10, end: 19 }), 'closed range');
  eq(JSON.stringify(community.parseRangeHeader('bytes=90-999', 100)), JSON.stringify({ start: 90, end: 99 }), 'clamped to the entry');
  eq(JSON.stringify(community.parseRangeHeader('bytes=-10', 100)), JSON.stringify({ start: 90, end: 99 }), 'suffix range');
  eq(community.parseRangeHeader('bytes=100-', 100).unsatisfiable, true, 'starting at the end cannot be served');
  eq(community.parseRangeHeader('bytes=50-40', 100).unsatisfiable, true, 'backwards cannot be served');
});

section('the cutscene bypass');

await test('a cutscene is answered with a placeholder container, never with the real video', async () => {
  // The community archive still holds the high-definition cutscenes. Reading
  // one out of the ZIP means inflating hundreds of megabytes into memory,
  // which is what empties a phone — so the mount answers with a blank
  // container instead.
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/intro_01.mp4', new zip.TextReader('x'.repeat(4096)));
  const mount = await community.openArchive(await writer.close(), zip);
  const requests = [];
  const target = {
    fetch: async (url) => { requests.push(String(url)); return new Response('network fallback'); },
  };
  const restore = community.installFetchMount(target, mount);

  const res = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/intro_01.mp4');
  eq(res.status, 200, 'the cutscene is answered');
  eq(res.headers.get('content-type'), 'video/mp4', 'with a video content type');
  const bytes = new Uint8Array(await res.arrayBuffer());
  ok(bytes.length < 2048, 'with a tiny body (' + bytes.length + ' bytes)');
  eq(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]), 'ftyp', 'and a real MP4 header');
  eq(requests.length, 0, 'the real video never reached the network');

  // …and it is never inflated out of the ZIP either.
  const ranged = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/intro_01.mp4', {
    headers: { Range: 'bytes=0-15' },
  });
  eq(ranged.status, 206, 'a range request is answered too');
  eq((await ranged.arrayBuffer()).byteLength, 16, 'with the requested bytes');
  restore();
  await mount.close();
});

await test('a WebM cutscene gets a WebM placeholder', async () => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('aa/WebGL/cutscene.webm', new zip.TextReader('x'.repeat(1024)));
  const mount = await community.openArchive(await writer.close(), zip);
  const target = { fetch: async () => new Response('network fallback') };
  const restore = community.installFetchMount(target, mount);
  const res = await target.fetch('https://game.example/StreamingAssets/aa/WebGL/cutscene.webm');
  eq(res.headers.get('content-type'), 'video/webm', 'the content type follows the extension');
  const bytes = new Uint8Array(await res.arrayBuffer());
  eq([bytes[0], bytes[1], bytes[2], bytes[3]].join(','), '26,69,223,163', 'and it is an EBML header');
  restore();
  await mount.close();
});

await test('an ordinary asset bundle is not mistaken for a cutscene', async () => {
  // "video_..." is a perfectly normal name for an Addressables bundle, and
  // serving it a blank video would break the game.
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/packed-test.bundle'), false, 'a bundle is not a video');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/video_intro.bundle'), false, 'not even one called "video_*"');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/intro_scene.bundle'), false, 'nor one called "intro_*"');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/intro_01.mp4'), true, 'but a cutscene is');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/movie.webm'), true, 'a movie is');
  eq(community.isVideoPath('/StreamingAssets/Videos/clip.mp4'), true, 'a file in a Videos folder is');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/intro_cutscene'), true, 'a name that starts with "intro" is');
  eq(community.isVideoPath('/StreamingAssets/aa/WebGL/catalogue.json'), false, 'a catalogue is not a video');
});

await test('the placeholder is the same container the build pipeline writes', async () => {
  // The prepared build replaces the cutscenes with makePlaceholderVideo()
  // (tools/unity-webdata.mjs). The browser-side bypass has to produce the
  // very same bytes, or the two builds would behave differently.
  const mp4 = community.makePlaceholderVideo('mp4');
  const webm = community.makePlaceholderVideo('webm');
  eq(Buffer.from(mp4).equals(makePlaceholderVideo('mp4')), true, 'the MP4 is byte for byte the same');
  eq(Buffer.from(webm).equals(makePlaceholderVideo('webm')), true, 'and so is the WebM');
  ok(mp4.length < 2048, 'the MP4 placeholder is a few hundred bytes (' + mp4.length + ')');
  ok(webm.length < 2048, 'and so is the WebM one (' + webm.length + ')');
});

await done('community build tests');
