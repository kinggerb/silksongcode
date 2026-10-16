/* ============================================================================
 * community-build.js — stream and mount the permitted community WebGL build
 * ----------------------------------------------------------------------------
 * The pinned community archive stores its Addressables in one 1.17 GiB ZIP
 * split into 75 files (the upstream it was rebuilt from was 2.08 GB in 100).
 * Keep that archive on OPFS and read individual bundles from it with zip.js;
 * do not concatenate the pieces in RAM or unpack the whole archive.
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SKCommunityBuild = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fail(message) {
    var error = new Error(message);
    error.name = 'CommunityBuildError';
    return error;
  }

  function validate(config) {
    if (!config || typeof config !== 'object') throw fail('community build configuration is not an object');
    if (config.schema !== 1) throw fail('unsupported community build configuration schema');
    if (!config.buildId || !config.source || !config.base) throw fail('community build configuration is missing its source or build id');
    if (!config.unity || !config.unity.loader || !config.unity.framework || !config.unity.data || !config.unity.wasm || !config.unity.streamingAssets) {
      throw fail('community build configuration is missing Unity entry points');
    }
    if (!config.fileBytes || ['loader', 'framework', 'data', 'wasm'].some(function (key) {
      return !Number.isSafeInteger(config.fileBytes[key]) || config.fileBytes[key] <= 0;
    })) throw fail('community build configuration has invalid Unity file sizes');
    var archive = config.assetArchive;
    if (!archive || !archive.cacheKey || !Array.isArray(archive.parts) || !archive.parts.length) {
      throw fail('community build configuration is missing the StreamingAssets archive parts');
    }
    // The archive may live somewhere else than the rest of the build (the
    // slimmer re-published archive does), so it can name its own root.
    if (archive.base !== undefined && (typeof archive.base !== 'string' || !archive.base)) {
      throw fail('community build configuration has an invalid asset archive base');
    }
    // …and a second host to ask when the first one refuses a part.
    if (archive.mirror !== undefined && (typeof archive.mirror !== 'string' || !archive.mirror)) {
      throw fail('community build configuration has an invalid asset archive mirror');
    }

    ['bundleBase', 'index'].forEach(function (field) {
      if (archive[field] !== undefined && (typeof archive[field] !== 'string' || !archive[field])) throw fail('invalid asset archive ' + field);
    });
    var total = 0;
    var names = Object.create(null);
    archive.parts.forEach(function (part, index) {
      if (!part || typeof part.path !== 'string' || !part.path || !Number.isSafeInteger(part.bytes) || part.bytes <= 0) {
        throw fail('invalid asset archive part ' + (index + 1));
      }
      if (part.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(part.sha256)) throw fail('invalid asset archive part digest');
      if (names[part.path]) throw fail('duplicate asset archive part: ' + part.path);
      names[part.path] = true;
      total += part.bytes;
      if (!Number.isSafeInteger(total)) throw fail('asset archive size is too large');
    });
    if (archive.total !== total) throw fail('asset archive total does not match the part sizes');
    return config;
  }

  function join(base, path) {
    return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
  }

  /** A human readable size, in megabytes. */
  function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Where a part of the archive is. An archive that names its own root wins
   * over the build's, because the slimmer archive is published on its own.
   */
  function archiveBase(config, base) {
    return base || (config.assetArchive && config.assetArchive.base) || config.base;
  }

  /* ---------------------------------------------------------------- *
   * Two hosts for the archive, and one of them says "later"
   *
   * The parts are published from this repository, and two hosts serve
   * them — but they do not serve them equally. jsDelivr refuses a
   * GitHub package larger than its limit (150 MB, and this one is
   * ~1.19 GB) with `403 Package size exceeded the configured limit`,
   * while raw.githubusercontent.com serves every committed blob under
   * 100 MB and each part is 16 MiB.
   *
   * The jsDelivr refusal is per request, not per package: a part it
   * has already cached keeps serving, so a download gets some way in
   * and then dies on the first part that was not — `HTTP 403 for
   * …/parts/WebGL.zip.part6`, six parts into seventy-five. That is
   * also why the descriptor names raw as `base` and keeps jsDelivr as
   * the `mirror`: the host that always answers leads, and the CDN that
   * is faster when it does answer is the fallback.
   *
   * GitHub raw answers the same way for a different reason. It rate
   * limits unauthenticated downloads — 60 requests an hour per IP
   * since May 2025 — and a part is one request, so this archive, 75
   * parts strong, can outrun the budget on its own. The answer is
   * `403` (or `429`) in the middle of a perfectly good download:
   *
   *     HTTP 403 for …/parts/WebGL.zip.part28
   *
   * a third of the way in, with jsDelivr equally unwilling and four
   * retries' worth of a few seconds each spent before the page gave
   * up. The bytes already on the device were fine — the download
   * resumes from them — but nothing was going to finish.
   *
   * So the fetch the downloader uses is wrapped twice over:
   *
   *   - a part that is refused — or a host that cannot be reached at
   *     all — is asked for once more from the other host, at the same
   *     path;
   *   - a refusal that is GitHub asking us to slow down is *waited
   *     out* instead of answered with a shrug (see the rate limit
   *     below), because the limit is measured in minutes and the
   *     download is measured in parts.
   * ---------------------------------------------------------------- */

  /**
   * Statuses worth asking the other host about. A refusal (403), a part
   * that is not where the descriptor says it is (404), a server that gave
   * up (408), one that asked us to slow down (429) and anything on the
   * server's own side (5xx) are all about the *host*, not about the bytes.
   * A 4xx that is not in this list is about the request itself, and the
   * mirror would answer it the same way.
   */
  function retryableStatus(status) {
    return status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
  }

  /** Is `url` inside `root`? Compared as plain strings, after the root's trailing slashes. */
  function underRoot(url, root) {
    if (!root || !url) return false;
    var prefix = String(root).replace(/\/+$/, '');
    var target = String(url);
    return target === prefix || target.indexOf(prefix + '/') === 0;
  }

  /**
   * The same part on the mirror, or null when this URL must not be
   * mirrored: it is not one of the archive's own (a Unity build file on
   * another host has no business being asked for here), or it is already
   * on the mirror — asking the host that just refused it again would be
   * pointless, and could loop.
   */
  function mirrorUrlFor(url, base, mirror) {
    if (!mirror || !underRoot(url, base)) return null;
    if (underRoot(url, mirror)) return null;
    var root = String(base).replace(/\/+$/, '');
    return join(mirror, String(url).slice(root.length).replace(/^\/+/, ''));
  }

  /* ---------------------------------------------------------------- *
   * Waiting out a rate limit
   *
   * A `403` from raw.githubusercontent.com usually is not about the
   * part: it is GitHub telling an unauthenticated page that it has
   * had its share of files for this hour. Nothing about the bytes is
   * wrong, and waiting — minutes, not seconds — is all it takes.
   *
   * Two refusals look alike and are not. jsDelivr's `403` carries
   * `Package size exceeded the configured limit of 150 MB`, which is
   * about the *package*, is true for every part it has not already
   * cached, and will still be true in an hour. GitHub's is about the
   * *hour*. So only a refusal from a GitHub host is waited out, and a
   * mirror that has refused once is not asked again for the rest of
   * the download.
   *
   * Waiting is not free — the tab has to stay open — so it is
   * bounded: escalating pauses (30 s, 1 min, 2 min, 5 min, then
   * 15 min) until a budget (an hour) is spent, and every pause is
   * shared by all the parts on the wire at once, so six in-flight
   * parts do not each spend a request to be told the same thing.
   * ---------------------------------------------------------------- */

  var RATE_LIMIT_WAITS = [30000, 60000, 120000, 300000, 900000];
  // GitHub's budget is an hour, and the pauses below reach 53 minutes in seven
  // rounds — giving up at 60 would stop a handful of minutes short of the very
  // window it is waiting for. Ninety minutes covers an hour with room to spare.
  var RATE_LIMIT_BUDGET = 90 * 60 * 1000;
  // The floor and the ceiling of a wait the host asked for itself: never a
  // request in the same breath (a host whose clock is wrong must not be
  // hammered), and never an afternoon.
  var RATE_LIMIT_MIN_WAIT = 5000;
  var RATE_LIMIT_MAX_WAIT = 2 * 60 * 60 * 1000;
  // How often the status line is refreshed while a pause runs. A quarter of an
  // hour of the same sentence otherwise reads as a hung tab.
  var RATE_LIMIT_TICK = 15000;

  /** The statuses a host answers with when it wants us to slow down. */
  function isRateLimitStatus(status) {
    return status === 403 || status === 429;
  }

  /** Does `url` live on a host whose refusals are rate limits? */
  function isGitHubHost(url) {
    try {
      var host = new URL(String(url)).hostname.toLowerCase();
      return /(^|\.)githubusercontent\.com$/.test(host) || /(^|\.)github\.com$/.test(host);
    } catch (e) {
      return false;
    }
  }

  /**
   * How long the host itself says to wait, in ms — 0 when it says nothing a
   * page is allowed to read.
   *
   * GitHub answers a rate limit with `x-ratelimit-reset` (a UTC epoch second)
   * and often `retry-after`. Neither is a CORS-safelisted header, so a page on
   * another origin usually gets `null` for both and has to guess; when the
   * host does expose them, that is the whole wait.
   */
  function rateLimitHint(response, now) {
    if (!response || !response.headers || typeof response.headers.get !== 'function') return 0;
    try {
      var retryAfter = Number(response.headers.get('retry-after') || 0);
      if (retryAfter > 0) return Math.round(retryAfter * 1000);
      var reset = Number(response.headers.get('x-ratelimit-reset') || 0);
      if (reset > 0) {
        var ms = reset * 1000 - now();
        if (ms > 0) return ms;
      }
    } catch (e) {
      /* a header the browser will not hand over: fall back to guessing */
    }
    return 0;
  }

  /** "90 s", "15 min". */
  function describeWait(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + ' s';
    return Math.round(ms / 60000) + ' min';
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      var timer = setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(abortError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function abortError() {
    var error = new Error('aborted');
    error.name = 'AbortError';
    return error;
  }

  /**
   * The book-keeping for waiting out a rate limit, shared by every part of
   * one download. Without a `sleep` there is no waiting at all, which is what
   * keeps this out of the way of tests and of callers that want the plain
   * one-retry behaviour.
   */
  function rateLimiter(options) {
    options = options || {};
    var waits = options.waits && options.waits.length ? options.waits : RATE_LIMIT_WAITS;
    var budget = options.budgetMs === undefined ? RATE_LIMIT_BUDGET : options.budgetMs;
    var now = options.now || function () { return Date.now(); };
    var sleepImpl = options.sleep || null;
    var round = 0;
    var spent = 0;
    var until = 0;

    return {
      /** Waiting is possible at all: only a caller that can sleep can wait. */
      canWait: function () {
        return Boolean(sleepImpl);
      },
      /** Is a refusal of `url` with `status` one that waiting can fix? */
      worthWaitingFor: function (url, status) {
        return Boolean(sleepImpl) && isRateLimitStatus(status) && isGitHubHost(url);
      },
      /**
       * Sleep out a pause — one another part started, usually. `onTick`, when
       * the caller passes one, is called with what is left of it so the page
       * can count down instead of sitting on one sentence for a quarter of an
       * hour; without one the whole pause is slept in one go.
       */
      wait: async function (signal, onTick) {
        if (!sleepImpl) return 0;
        var total = until - now();
        if (total <= 0) return 0;
        if (!onTick) {
          await sleepImpl(total, signal);
          return total;
        }
        for (;;) {
          var left = until - now();
          if (left <= 0) break;
          onTick(left, total);
          await sleepImpl(Math.min(left, RATE_LIMIT_TICK), signal);
        }
        return total;
      },
      /**
       * The moment the host itself says to come back, as an absolute time on
       * this limiter's clock — 0 when it says nothing.
       *
       * Absolute, because a part can sit behind a pause another part started
       * before it gets to act on the answer: a `retry-after: 3600` read at
       * 09:00 is not an hour from 09:15.
       */
      deadlineFrom: function (response) {
        var hint = rateLimitHint(response, now);
        return hint > 0 ? now() + hint : 0;
      },
      /**
       * Start the next pause, or join the one that is already running: ms to
       * wait, or -1 when the budget is spent.
       *
       * Six parts refused together are one piece of news, not six, so a
       * refusal that arrives while a pause is still running joins it instead
       * of making the wait six times longer — and it does not spend the
       * budget twice, because the parts sit out the same minutes.
       *
       * `deadline` is the moment the host asked us to come back (see
       * `deadlineFrom`), and what is left of it wins over guessing. A
       * deadline that has already gone by — the part waited it out behind a
       * pause another part started — is ignored rather than waited for again.
       */
      pause: function (deadline) {
        if (now() < until) return Math.max(0, until - now());
        round++;
        var wait = waits[Math.min(round - 1, waits.length - 1)];
        if (deadline > 0) {
          // What is left of what the host asked for — floored, so a deadline
          // that has already gone by (the part waited it out behind another
          // part's pause) costs a few seconds instead of a wasted round.
          var asked = Math.max(deadline - now(), 0);
          wait = Math.min(Math.max(asked, RATE_LIMIT_MIN_WAIT), RATE_LIMIT_MAX_WAIT);
        }
        if (spent + wait > budget) {
          until = 0; // out of patience: nothing to join any more
          return -1;
        }
        spent += wait;
        until = now() + wait;
        return wait;
      },
      /** A request got through: the host is answering again, start over. */
      reset: function () {
        round = 0;
        until = 0;
      },
      spentMs: function () {
        return spent;
      },
    };
  }

  /**
   * Wrap a fetch so a part the archive's own host refuses is retried once
   * against the mirror — and so a refusal that is only a rate limit is waited
   * out and asked for again.
   *
   * Both are bounded: the mirror is asked exactly once per attempt, and the
   * waiting stops when the rate limit's budget is spent, so two hosts that are
   * both saying no cannot keep a download dangling for ever.
   *
   * Anything that is not a URL under `base` passes straight through, so the
   * wrapper is safe to hand to a downloader that also fetches other files.
   */
  function mirrorFetch(fetchImpl, options) {
    options = options || {};
    var base = options.base;
    var mirror = options.mirror;
    var onLog = typeof options.onLog === 'function' ? options.onLog : function () {};
    var onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    var limit = options.rateLimit || null;
    var inner = typeof fetchImpl === 'function' ? fetchImpl : function (input, init) { return fetch(input, init); };

    function urlOf(input) {
      if (typeof input === 'string') return input;
      if (typeof URL !== 'undefined' && input instanceof URL) return String(input);
      if (input && typeof input.url === 'string') return input.url;
      return '';
    }

    /** One request. A host that cannot be reached at all comes back as `{error}`. */
    async function attempt(target, init) {
      try {
        return { response: await inner(target, init) };
      } catch (error) {
        // An abort is the caller's own doing and is never retried somewhere else.
        if (init && init.signal && init.signal.aborted) throw error;
        return { error: error };
      }
    }

    /**
     * A response the caller can have as it is: a good one, or one the mirror
     * cannot improve on. A host that could not be reached at all has no
     * response, and that is exactly when the mirror is worth asking.
     */
    function settled(response) {
      return !response || response.ok || !retryableStatus(response.status);
    }

    var mirrorRefused = false;
    return async function mirroredFetch(input, init) {
      var url = urlOf(input);
      var fallback = mirrorUrlFor(url, base, mirror);
      // Without a mirror there is nothing to fall back to: behave exactly
      // like the fetch that was handed in.
      if (!fallback) return inner(input, init);

      // jsDelivr refuses this package outright, for every part it has not
      // already cached, and no amount of waiting changes that. Once it has
      // said no, it is not asked again for the rest of the download.

      /** What the page shows while a pause runs (a countdown, so it reads as waiting rather than hanging). */
      function ticking(left) {
        if (!onStatus) return;
        onStatus(
          'GitHub is rate-limiting the download — ' + describeWait(left) +
            ' to go. Nothing is lost, it carries on where it stopped.'
        );
      }

      for (;;) {
        // A pause another part started: wait it out instead of spending a
        // request on a host that has already said "later".
        if (limit) await limit.wait(init && init.signal, onStatus ? ticking : null);

        var first = await attempt(input, init);
        if (!first.error && settled(first.response)) {
          if (limit) limit.reset();
          return first.response;
        }
        // The moment the host asked us to come back, read now: a part that
        // waits behind another part's pause before acting on it has already
        // served part of that wait.
        var deadline = limit && first.response ? limit.deadlineFrom(first.response) : 0;

        // The mirror is the only second opinion there is — unless it has
        // already refused this package, which for jsDelivr means it will
        // refuse every part of it.
        var refused = null;
        if (!mirrorRefused) {
          if (first.error) {
            onLog('could not reach ' + url + ' (' + ((first.error && first.error.message) || first.error) + ') — asking the mirror');
          } else {
            onLog('HTTP ' + first.response.status + ' for ' + url + ' — asking the mirror');
          }
          var second = await attempt(fallback, init);
          if (second.error) throw second.error;
          if (settled(second.response)) {
            if (limit) limit.reset();
            return second.response;
          }
          refused = second.response;
          // jsDelivr's 403 is about the package, not about the hour, so it is
          // not going to change: the mirror is not asked again.
          if (refused && refused.status === 403) mirrorRefused = true;
        }

        // Only the host that leads can be worth waiting for: a status is
        // GitHub telling us to slow down, a network error is not, and the
        // mirror's own refusal is answered by leaving it alone.
        if (!limit || !first.response || !limit.worthWaitingFor(url, first.response.status)) {
          if (refused) return refused;
          if (first.error) throw first.error;
          return first.response;
        }

        var wait = limit.pause(deadline);
        if (wait < 0) {
          onLog(
            'GitHub kept refusing the archive with HTTP ' + first.response.status + ' for ' +
              Math.round(limit.spentMs() / 60000) + ' minutes — giving up. Nothing is lost: the ' +
              'parts already saved are kept, and starting again carries on from there.'
          );
          return refused || first.response;
        }
        var message =
          'GitHub is rate-limiting the download (HTTP ' + first.response.status +
          ') — pausing ' + describeWait(wait) + '. Nothing is lost, it carries on where it stopped.';
        onLog(message);
        if (onStatus) onStatus(message);
      }
    };
  }

  /**
   * The fetch the archive should be downloaded with: the caller's own,
   * wrapped so a refused or unreachable part is asked for again from the
   * mirror named in the descriptor, and so a rate limit is waited out.
   */
  function timedFetch(fetchImpl, timeoutMs) {
    return async function (url, init) {
      init = init || {};
      if (typeof AbortController === 'undefined') return fetchImpl(url, init);
      var controller = new AbortController(), expired = false;
      var abort = function () { controller.abort(); };
      if (init.signal && init.signal.aborted) abort();
      if (init.signal) init.signal.addEventListener('abort', abort, { once: true });
      var timer = setTimeout(function () { expired = true; controller.abort(); }, timeoutMs || 30000);
      try { return await fetchImpl(url, Object.assign({}, init, { signal: controller.signal })); }
      catch (error) { if (expired) throw new Error('connection stalled before response headers'); throw error; }
      finally { clearTimeout(timer); if (init.signal) init.signal.removeEventListener('abort', abort); }
    };
  }

  function archiveFetch(config, options, base, limit) {
    var archive = config.assetArchive || {};
    return mirrorFetch(timedFetch(options.fetchImpl || function (url, init) { return fetch(url, init); }, options.headerTimeoutMs), {
      base: base,
      mirror: archive.mirror,
      onLog: options.onLog,
      onStatus: options.onStatus,
      rateLimit: limit === undefined ? archiveRateLimit(options) : limit,
    });
  }

  /**
   * The rate limiter for one download: shared by the fetch and by the
   * downloader's own backoff, so every part waits on the same clock.
   * `options.rateLimit: false` turns the waiting off (a caller that wants the
   * plain one-retry behaviour), and a limiter can be handed in instead.
   */
  function archiveRateLimit(options) {
    if (options.rateLimit === false) return null;
    if (options.rateLimit) return options.rateLimit;
    return rateLimiter({
      waits: options.rateLimitWaits,
      budgetMs: options.rateLimitBudgetMs,
      now: options.now,
      sleep: options.sleep || sleep,
    });
  }

  /**
   * The backoff the downloader should use for a part that failed.
   *
   * A rate limit has already been waited out by the fetch above — an hour of
   * it, if that is what it took — so once it gives up, spending four more
   * attempts on the same refusal would only take ten more requests from the
   * host that is short of them. Everything else keeps the downloader's own
   * backoff (null: "you decide").
   */
  function archiveRetryAfter() {
    return function (err) {
      return err && err.url && isRateLimitStatus(err.status) && isGitHubHost(err.url) ? -1 : null;
    };
  }

  function parts(config, base) {
    validate(config);
    var root = archiveBase(config, base);
    return config.assetArchive.parts.map(function (part) {
      return { url: join(root, part.path), bytes: part.bytes, sha256: part.sha256 || null };
    });
  }

  /* ---------------------------------------------------------------- *
   * A smaller archive
   *
   * The upstream archive is one 1.94 GiB ZIP, and a good part of it is
   * the high-definition cutscenes — the very files the page answers with
   * a placeholder instead of the real bytes. Downloading them is a waste
   * of an hour on a phone and a gigabyte of storage nobody can use. (The
   * pinned archive has already been slimmed, so what is left of this is
   * the placeholder itself, plus the path for archives that have not.)
   *
   * So before the download starts, the archive is asked for its index:
   * two small range requests read the ZIP's central directory, which
   * says where every file lives inside the archive. With that in hand
   * the download can skip the files nobody is ever going to read, and
   * the archive is written out again in a smaller, perfectly ordinary
   * ZIP (the entries are copied byte for byte — nothing is recompressed).
   *
   * If the server does not honour byte ranges, or the archive is not
   * shaped the way we expect, the whole archive is downloaded as before.
   * ---------------------------------------------------------------- */

  // Below this there is no point: the plan costs a couple of requests.
  var MIN_SAVING = 1024 * 1024;

  /* ---------------------------------------------------------------- *
   * Remembering the cutscenes
   *
   * Telling a game bundle from a cutscene by looking at its bytes
   * takes a few hundred small requests, and the answer is the same for
   * every launch of the same build. So it is looked at once and the
   * names are remembered in local storage — the next launch only has to
   * read the archive's own index.
   * ---------------------------------------------------------------- */

  function sniffKey(options) {
    return 'silksong.archive.cutscenes.' + (options.key || 'default');
  }

  function storageFor(options) {
    if (options.storage) return options.storage;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* no storage (private mode, or a sandboxed frame) */ }
    return null;
  }

  function loadRemembered(options) {
    try {
      var store = storageFor(options);
      if (!store) return null;
      var text = store.getItem(sniffKey(options));
      if (!text) return null;
      var names = JSON.parse(text);
      return Array.isArray(names) ? names : null;
    } catch (e) {
      return null;
    }
  }

  function remember(options, names) {
    try {
      var store = storageFor(options);
      if (!store) return;
      store.setItem(sniffKey(options), JSON.stringify(names || []));
    } catch (e) { /* no room, or no storage */ }
  }

  function zipLibrary(options) {
    if (options && options.zip) return options.zip;
    if (typeof SKZipPlan !== 'undefined') return SKZipPlan;
    // Node (the test suite) has no globals: the module sits next to this one.
    try {
      if (typeof require === 'function') return require('./zip-plan.js');
    } catch (e) { /* not a CommonJS host */ }
    return null;
  }

  /**
   * Read the archive's index and work out what can be left out.
   *
   * Returns null when the archive cannot be pruned — the caller then
   * downloads it whole, exactly as before.
   */
  async function planArchive(partList, options) {
    options = options || {};
    var zip = zipLibrary(options);
    if (!zip || typeof zip.readIndex !== 'function') return null;

    var reader = zip.createReader(partList, {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    var index = await zip.readIndex(reader);
    if (!index) return null;
    // A server that ignores the Range header sends whole files, and then
    // there is nothing to save.
    if (!reader.ranges) return null;

    var plan = zip.planEntries(index, {
      skip: options.skip || function (name) {
        // The very same rule the mount uses to answer a cutscene with a
        // placeholder: a file that is left out of the archive has to be one
        // the page never asks the archive for.
        if (isVideoPath('/StreamingAssets/' + String(name).replace(/^\/+/, ''))) return 'video';
        if (zip.isOtherPlatformEntry(name)) return 'other';
        return '';
      },
    });

    // A name is only a hint: the big entries are looked at as well, because
    // a cutscene that is called "packed-something.bundle" is still a
    // cutscene, and leaving it out is the whole point. The answer is the
    // same for every launch, so it is remembered.
    var remembered = loadRemembered(options);
    if (remembered) {
      if (typeof zip.applySniffed === 'function') plan = zip.applySniffed(plan, index, remembered);
    } else if (typeof zip.planEntriesAsync === 'function') {
      plan = await zip.planEntriesAsync(index, reader, {
        skip: options.skip,
        minBytes: options.minSniffBytes,
        maxSniffs: options.maxSniffs,
      });
      remember(options, plan.sniffedNames);
    }

    if (!plan.skipped.length || plan.skippedBytes < MIN_SAVING) return null;

    var layout = zip.buildLayout(plan, index);
    if (!layout) return null;

    var segments = zip.buildSegments(layout, partList);
    var videoNames = plan.skipped
      .filter(function (entry) { return entry.skipReason === 'video'; })
      .map(function (entry) { return basename(entry.name).toLowerCase(); })
      .filter(function (name, at, all) { return name && all.indexOf(name) === at; });
    return {
      segments: segments,
      // What the file on the device will be.
      outputSize: layout.outputSize,
      // What the network has to send.
      downloadBytes: layout.downloadBytes,
      keptBytes: plan.keptBytes,
      skippedBytes: plan.skippedBytes,
      skippedCount: plan.skipped.length,
      skippedNames: plan.skipped.map(function (entry) { return entry.name; }),
      // The cutscenes that are left out, so the mount can answer a request
      // for one of them with a placeholder instead of a missing file.
      videoNames: videoNames,
      entryCount: index.entries.length,
      sniffed: plan.sniffed || 0,
    };
  }

  async function ensureArchive(config, options) {
    options = options || {};
    validate(config);
    var stream = options.stream || (typeof SKStream !== 'undefined' ? SKStream : null);
    if (!stream || typeof stream.ensureDataset !== 'function') throw fail('the low-memory storage loader did not load');
    var base = archiveBase(config, options.base);
    var archive = config.assetArchive;
    var partList = parts(config, base);
    // Every request for a part goes through this fetch — the plan's range
    // requests as well as the download — so a host that refuses a part is
    // asked for again from the mirror named in the descriptor, and a host
    // that is rate limiting us is waited out, instead of failing a 1.19 GB
    // download a third of the way in.
    var limit = archiveRateLimit(options);
    var fetchImpl = archiveFetch(config, options, base, limit);
    // Waiting out a rate limit is the fetch's job, so the downloader must not
    // spend its own retry budget on the same refusal — see archiveRetryAfter.
    // With no waiting (no way to sleep) the downloader keeps its backoff.
    var retryAfter = limit && limit.canWait() ? archiveRetryAfter() : null;

    // Work out whether the archive can be made smaller before a single
    // byte of it is downloaded. An archive that says it is already slim has
    // nothing to leave out, and the plan costs a couple of hundred range
    // requests, so it is skipped.
    var plan = null;
    if (options.prune !== false && !archive.slim) {
      try {
        plan = await planArchive(partList, Object.assign({}, options, {
          key: config.buildId + ':' + archive.total,
          fetchImpl: fetchImpl,
        }));
      } catch (error) {
        if (options.onLog) {
          options.onLog('could not plan a smaller archive (' + ((error && error.message) || error) + ') — downloading the whole thing');
        }
        plan = null;
      }
    }

    if (plan) {
      if (options.onLog) {
        options.onLog(
          'leaving out ' + plan.skippedCount + ' of ' + plan.entryCount + ' archive files (' +
            mb(plan.skippedBytes) + ' of cutscenes and other platforms) — ' +
            mb(plan.downloadBytes) + ' instead of ' + mb(archive.total)
        );
      }
      if (options.onPlan) options.onPlan(plan);
      var pruned = await stream.ensureDataset({
        segments: plan.segments,
        expectedSize: plan.outputSize,
        // The same cache file as the whole archive: the pruned one replaces
        // it, so the device is not left with both. The build id says which
        // of the two it is, so a half-downloaded one is never continued as
        // the other.
        cacheKey: archive.cacheKey,
        buildId: 'pruned-' + config.buildId,
        mime: archive.mime || 'application/zip',
        verify: 'size',
        workerUrl: options.workerUrl || 'js/writer.js',
        writerFactory: options.writerFactory,
        preferDisk: true,
        allowMemoryFallback: false,
        concurrency: options.concurrency || 6,
        fetchImpl: fetchImpl,
        retryAfter: retryAfter,
        retryAttempts: options.retryAttempts,
        onProgress: options.onProgress,
        onStatus: options.onStatus,
        onLog: options.onLog,
        signal: options.signal,
      });
      pruned.plan = plan;
      return pruned;
    }

    return stream.ensureDataset({
      parts: partList,
      expectedSize: archive.total,
      // The same cache file as the pruned one, but a build id of its own: the
      // loader has to be able to tell the two apart, or a half-downloaded
      // archive would be continued as the other one.
      cacheKey: archive.cacheKey,
      buildId: config.buildId,
      mime: archive.mime || 'application/zip',
      verify: 'size',
      cacheOnly: options.cacheOnly,
      stallTimeoutMs: options.stallTimeoutMs,
      workerUrl: options.workerUrl || 'js/writer.js',
      writerFactory: options.writerFactory,
      preferDisk: true,
      allowMemoryFallback: false,
      // The archive is 75 parts: one at a time is minutes of round trips.
      concurrency: options.concurrency || 6,
      fetchImpl: fetchImpl,
      retryAfter: retryAfter,
      retryAttempts: options.retryAttempts,
      onProgress: options.onProgress,
      onStatus: options.onStatus,
      onLog: options.onLog,
      signal: options.signal,
    });
  }

  function basename(path) {
    var clean = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return clean.slice(clean.lastIndexOf('/') + 1);
  }

  function decodePath(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  /* ---------------------------------------------------------------- *
   * Cutscenes: a placeholder instead of the real thing
   *
   * The community archive is the upstream one, so it still contains the
   * high-definition cutscenes — some of them hundreds of megabytes. When
   * Unity asks for one, the ZIP reader has to inflate it into a Blob
   * first, and *that* is what empties a phone's memory: a single video
   * can be bigger than the whole tab is allowed to be.
   *
   * So the mount never hands the real bytes over. A cutscene request is
   * answered with a tiny, structurally valid container (an MP4 with a
   * 2×2 track and no samples, or a WebM with a header and no clusters),
   * which costs a few hundred bytes and plays as a black frame. The
   * bytes are the same ones `makePlaceholderVideo()` in
   * tools/unity-webdata.mjs builds for the prepared build — the two are
   * compared byte for byte by the test suite.
   * ---------------------------------------------------------------- */

  function u32(value) {
    var b = new Uint8Array(4);
    b[0] = (value >>> 24) & 0xff;
    b[1] = (value >>> 16) & 0xff;
    b[2] = (value >>> 8) & 0xff;
    b[3] = value & 0xff;
    return b;
  }

  function u16(value) {
    var b = new Uint8Array(2);
    b[0] = (value >>> 8) & 0xff;
    b[1] = value & 0xff;
    return b;
  }

  function asciiBytes(text) {
    var b = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    return b;
  }

  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], at);
      at += parts[i].length;
    }
    return out;
  }

  function box(type, parts) {
    var payload = concatBytes(parts);
    return concatBytes([u32(payload.length + 8), asciiBytes(type), payload]);
  }

  function fullBox(version, flags, parts) {
    var head = new Uint8Array([
      version & 0xff,
      (flags >>> 16) & 0xff,
      (flags >>> 8) & 0xff,
      flags & 0xff,
    ]);
    return concatBytes([head].concat(parts || []));
  }

  /** A minimal but structurally complete MP4 with a video track that has no samples. */
  function makeMp4Placeholder(width, height, timescale, duration) {
    width = width || 2;
    height = height || 2;
    timescale = timescale || 30;
    duration = duration || 1;

    var ftyp = box('ftyp', [asciiBytes('isom'), u32(0x200), asciiBytes('isomiso2mp41')]);
    var mvhd = box('mvhd', [fullBox(0, 0, [
      u32(0), u32(0),
      u32(timescale), u32(duration * timescale),
      u32(0x00010000), u16(0x0100), u16(0),
      u32(0), u32(0),
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
      u32(2),
    ])]);
    var tkhd = box('tkhd', [fullBox(0, 7, [
      u32(0), u32(0), u32(1), u32(0),
      u32(duration * timescale),
      u32(0), u32(0),
      u16(0), u16(0), u16(0), u16(0),
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(width << 16), u32(height << 16),
    ])]);
    var mdhd = box('mdhd', [fullBox(0, 0, [
      u32(0), u32(0), u32(timescale), u32(duration * timescale), u16(0x55c4), u16(0),
    ])]);
    var hdlr = box('hdlr', [fullBox(0, 0, [
      u32(0), asciiBytes('vide'), u32(0), u32(0), u32(0), asciiBytes('VideoHandler\0'),
    ])]);
    var esds = box('esds', [fullBox(0, 0, [
      new Uint8Array([0x03, 0x19, 0x00, 0x01, 0x00]),
      new Uint8Array([0x04, 0x11, 0x40, 0x15]),
      new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      new Uint8Array([0x05, 0x02, 0x12, 0x10]),
      new Uint8Array([0x06, 0x01, 0x02]),
    ])]);
    var mp4v = box('mp4v', [
      new Uint8Array(6),
      u16(1),
      u16(0), u16(0), u16(0),
      u32(0), u32(0), u32(0),
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000),
      u32(0), u16(1),
      new Uint8Array(32),
      u16(0x0018),
      u16(0xffff),
      esds,
    ]);
    var stsd = box('stsd', [fullBox(0, 0, [u32(1), mp4v])]);
    var stbl = box('stbl', [
      stsd,
      box('stts', [fullBox(0, 0, [u32(0)])]),
      box('stsc', [fullBox(0, 0, [u32(0)])]),
      box('stsz', [fullBox(0, 0, [u32(0), u32(0)])]),
      box('stco', [fullBox(0, 0, [u32(0)])]),
    ]);
    var vmhd = box('vmhd', [fullBox(0, 1, [u16(0), u16(0), u16(0), u16(0)])]);
    var dref = box('dref', [fullBox(0, 0, [u32(1), box('url ', [fullBox(0, 1)])])]);
    var dinf = box('dinf', [dref]);
    var minf = box('minf', [vmhd, dinf, stbl]);
    var mdia = box('mdia', [mdhd, hdlr, minf]);
    var trak = box('trak', [tkhd, mdia]);
    var moov = box('moov', [mvhd, trak]);
    var mdat = box('mdat', []);
    return concatBytes([ftyp, moov, mdat]);
  }

  /** EBML/WebM: header + Segment(Info, Tracks) with a 2×2 V_VP8 track, no clusters. */
  function makeWebmPlaceholder(width, height) {
    width = width || 2;
    height = height || 2;

    function vint(value, length) {
      var out = new Uint8Array(length);
      for (var i = length - 1; i >= 0; i--) {
        out[i] = value & 0xff;
        value = Math.floor(value / 256);
      }
      out[0] |= 1 << (8 - length);
      return out;
    }
    function ebmlId(id) {
      var bytes = [];
      var v = id;
      while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      }
      return new Uint8Array(bytes);
    }
    function el(id, payload) {
      return concatBytes([ebmlId(id), vint(payload.length, 4), payload]);
    }
    function uintEl(id, value) {
      var bytes = [];
      var v = value;
      do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      } while (v > 0);
      return el(id, new Uint8Array(bytes));
    }
    function floatEl(id, value) {
      var b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, value, false);
      return el(id, b);
    }
    function stringEl(id, text) {
      return el(id, asciiBytes(text));
    }

    var ebml = el(0x1a45dfa3, concatBytes([
      uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8),
      stringEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2),
    ]));
    var info = el(0x1549a966, concatBytes([
      uintEl(0x2ad7b1, 1000000), floatEl(0x4489, 0.0), stringEl(0x7ba9, 'silksong-placeholder'),
    ]));
    var video = el(0xe0, concatBytes([uintEl(0xb0, width), uintEl(0xba, height)]));
    var trackEntry = el(0xae, concatBytes([
      uintEl(0xd7, 1),
      uintEl(0x73c5, 1),
      uintEl(0x83, 1),
      stringEl(0x86, 'V_VP8'),
      uintEl(0x23e383, 1000000000),
      video,
    ]));
    var tracks = el(0x1654ae6b, trackEntry);
    var segment = el(0x18538067, concatBytes([info, tracks]));
    return concatBytes([ebml, segment]);
  }

  var placeholderCache = {};

  /** The placeholder container for a kind of video, built once and kept. */
  function placeholderVideoBytes(kind) {
    var key = kind === 'webm' ? 'webm' : 'mp4';
    if (!placeholderCache[key]) {
      placeholderCache[key] = key === 'webm' ? makeWebmPlaceholder() : makeMp4Placeholder();
    }
    return placeholderCache[key];
  }

  // The same extensions and names the build pipeline uses to spot a video
  // inside the data archive (tools/unity-webdata.mjs → looksLikeVideo).
  var VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|avi|ogv|mpg|mpeg)$/;
  var VIDEO_NAME = /^(movie|cinematic|cutscene|video|intro)[_/-]/i;
  var VIDEO_SEGMENTS = [
    'video', 'videos', 'cutscene', 'cutscenes', 'intro', 'intros',
    'cinematic', 'cinematics', 'movie', 'movies',
  ];
  // …but never a Unity asset bundle that happens to be called "video_*".
  // A false positive here is not a black cutscene, it is a missing game
  // asset, so the name rule below only fires for a file that has no
  // extension at all.
  var NOT_VIDEO_EXTENSIONS = [
    '.bundle', '.bin', '.resource', '.assets', '.dat', '.json', '.bytes',
    '.hash', '.xml', '.txt', '.config', '.manifest', '.unity3d', '.resS',
    '.scene', '.prefab', '.shader', '.png', '.jpg', '.jpeg', '.wav', '.ogg',
  ];

  function extensionOf(name) {
    var at = String(name || '').lastIndexOf('.');
    return at < 0 ? '' : String(name).slice(at).toLowerCase();
  }

  /** Is this URL path a cutscene rather than an ordinary asset? */
  function isVideoPath(pathname) {
    var lower = decodePath(String(pathname || '')).toLowerCase();
    var segments = lower.split('/');
    var last = segments.length - 1;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (!segment) continue;
      if (i === last) {
        if (VIDEO_EXTENSIONS.test(segment)) return true;
        var extension = extensionOf(segment);
        if (extension) continue;                 // a named asset is not a video
        if (VIDEO_NAME.test(segment)) return true;
      } else if (VIDEO_SEGMENTS.indexOf(segment) >= 0) {
        return true;
      }
    }
    return false;
  }

  /** The kind of container to answer a video request with. */
  function videoKindFor(pathname) {
    var lower = decodePath(String(pathname || '')).toLowerCase();
    if (/\.(webm|ogv|ogg)$/.test(lower)) return 'webm';
    if (/\.(mp4|mov|m4v|avi|mpg|mpeg)$/.test(lower)) return 'mp4';
    return 'mp4';
  }

  async function openArchive(file, zipLib, options) {
    options = options || {};
    if (!file || (typeof file.slice !== 'function' && typeof file.readUint8Array !== 'function')) throw fail('the cached asset archive is not readable');
    zipLib = zipLib || (typeof zip !== 'undefined' ? zip : null);
    if (!zipLib || !zipLib.ZipReader || !zipLib.BlobReader || !zipLib.BlobWriter) {
      throw fail('the ZIP reader did not load');
    }
    if (typeof zipLib.configure === 'function') {
      // Safari has native compression streams on supported iPadOS versions;
      // avoid starting a separate codec worker for every requested bundle.
      zipLib.configure({ useWebWorkers: false, useCompressionStream: true });
    }

    // BlobReader uses slices of the file, so only the ZIP directory and the
    // requested bundle are read. The multi-gigabyte archive is never converted
    // into one ArrayBuffer.
    var input;
    if (typeof file.readUint8Array === 'function') {
      input = new zipLib.Reader();
      input.size = file.size; input.initialized = true;
      input.readUint8Array = file.readUint8Array.bind(file);
    } else input = new zipLib.BlobReader(file);
    var reader = options.entries ? { close: function () { return Promise.resolve(); } } : new zipLib.ZipReader(input, { useWebWorkers: false });
    var entries;
    try {
      entries = options.entries || await reader.getEntries();
    } catch (error) {
      try { await reader.close(); } catch (e) {}
      throw fail('could not read the cached StreamingAssets ZIP: ' + ((error && error.message) || error));
    }

    var byPath = Object.create(null);
    var byName = Object.create(null);
    entries.forEach(function (entry) {
      if (entry.directory) return;
      var path = decodePath(String(entry.filename || '')).replace(/^\/+/, '').replace(/\\/g, '/');
      var lowerPath = path.toLowerCase();
      var name = basename(path).toLowerCase();
      if (!name) return;
      if (!byPath[lowerPath]) byPath[lowerPath] = entry;
      // The upstream player resolves cached Addressables by basename. Keep the
      // same fallback while preferring a full path match when one is available.
      if (!byName[name]) byName[name] = entry;
    });

    var inFlight = Object.create(null);

    function entryFor(url) {
      var parsed;
      try { parsed = new URL(String(url), (typeof location !== 'undefined' && location.href) || 'https://silksong.invalid/'); }
      catch (e) { return null; }
      var pathname = decodePath(parsed.pathname).replace(/\\/g, '/');
      var marker = pathname.toLowerCase().lastIndexOf('/streamingassets/');
      if (marker < 0) return null;
      var relative = pathname.slice(marker + '/streamingassets/'.length).replace(/^\/+/, '').toLowerCase();
      var fullMatch = byPath[relative];
      if (fullMatch) return fullMatch;
      // The source archive can contain only the Addressables file name, while
      // Unity requests it under StreamingAssets/aa/WebGL/.
      var stripped = relative.replace(/^aa\//, '');
      if (byPath[stripped]) return byPath[stripped];
      return byName[basename(relative).toLowerCase()] || null;
    }

    async function blobFor(entry) {
      var key = String(entry.filename || '');
      if (inFlight[key]) return inFlight[key];
      var promise = (async function () {
        var start = Date.now();
        if (options.onStatus) options.onStatus('Loading ' + basename(key).replace(/_[a-f0-9]{20,}/g, '') + '…');
        var cached = options.bundleCache ? await options.bundleCache.get(entry) : null;
        if (cached) return cached;
        if (options.bundleBase) {
          var direct = await options.stream.ensureDataset({
            parts: [{ url: join(options.bundleBase, entry.filename.split('/').map(encodeURIComponent).join('/')), bytes: entry.uncompressedSize }],
            expectedSize: entry.uncompressedSize,
            cacheKey: 'direct-' + options.buildId + '-' + encodeURIComponent(entry.filename),
            buildId: options.buildId, mime: 'application/octet-stream',
            workerUrl: options.workerUrl || 'js/writer.js', preferDisk: true, allowMemoryFallback: false,
            fetchImpl: options.fetchImpl, onLog: options.onLog, signal: options.signal,
            stallTimeoutMs: options.stallTimeoutMs,
          });
          try {
            if (await crc32File(direct.file) !== entry.signature) {
              direct.dispose();
              await options.stream.removeDataset('direct-' + options.buildId + '-' + encodeURIComponent(entry.filename));
              throw fail('direct bundle CRC mismatch: ' + entry.filename);
            }
            return direct.file;
          } finally { direct.dispose(); }
        }
        // Prefetch only the compressed extent of the bundle Unity requested.
        // Reader slices remain small, while network parts fill the connection.
        var prefetch = file.prefetchEntry ? file.prefetchEntry(entry) : null;
        if (prefetch) prefetch.catch(function () {});
        var blob;
        if (options.bundleCache) blob = await options.bundleCache.extract(entry, zipLib);
        if (!blob) blob = await entry.getData(new zipLib.BlobWriter('application/octet-stream'), {
          useWebWorkers: false, checkSignature: true,
        });
        if (prefetch) await prefetch;
        if (options.onLog) options.onLog('bundle ready: ' + key + ' (' + blob.size + ' bytes, ' + (Date.now() - start) + ' ms)');
        return blob;
      })();
      inFlight[key] = promise;
      try { return await promise; } finally { delete inFlight[key]; }
    }

    return {
      entryFor: entryFor,
      blobFor: blobFor,
      entryCount: entries.length,
      entries: entries,
      stats: file.stats || null,
      close: async function () { try { await reader.close(); } finally { if (options.bundleCache) options.bundleCache.dispose(); } },
    };
  }

  var crcTable = null;
  async function crc32File(file) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[i] = c;
      }
    }
    var crc = 0xffffffff, reader = file.stream().getReader();
    try {
      for (;;) {
        var item = await reader.read(); if (item.done) break;
        for (var k = 0; k < item.value.length; k++) crc = crcTable[(crc ^ item.value[k]) & 255] ^ (crc >>> 8);
      }
    } finally { await reader.cancel(); }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function validateBundleIndex(index, total) {
    if (!index || index.schema !== 1 || index.bytes !== total || !Array.isArray(index.entries) || !index.entries.length || index.entries.length > 100000) throw fail('invalid bundle index');
    var names = new Set();
    index.entries.forEach(function (entry) {
      if (!entry || typeof entry.filename !== 'string' || !entry.filename || entry.filename[0] === '/' ||
          entry.filename.indexOf('\\') >= 0 || entry.filename.split('/').indexOf('..') >= 0 || names.has(entry.filename) ||
          !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
          !Number.isSafeInteger(entry.signature) || entry.signature < 0 || entry.signature > 0xffffffff) throw fail('invalid bundle index entry');
      names.add(entry.filename);
    });
    return index.entries;
  }

  async function openLazyArchive(config, options) {
    options = options || {};
    validate(config);
    var stream = options.stream || (typeof SKStream !== 'undefined' ? SKStream : null);
    var cache = options.cache || (typeof SKAssetCache !== 'undefined' ? SKAssetCache : null);
    if (!cache && typeof require === 'function') cache = require('./asset-cache.js');
    if (!stream || !cache) throw fail('the disk-backed lazy asset loader did not load');
    var bundleCache = cache.createBundleCache({ stream: stream, buildId: config.buildId + ':' + config.assetArchive.cacheKey,
      workerUrl: options.workerUrl, budgetBytes: options.bundleCacheBytes, onLog: options.onLog });
    var archiveOptions = Object.assign({}, options, { stream: stream, buildId: config.buildId, bundleCache: bundleCache });
    if (options.bundleBase && config.assetArchive.index) {
      var indexUrl = new URL(config.assetArchive.index, archiveBase(config, options.base)).href;
      var fetchIndex = timedFetch(options.fetchImpl || function (url, init) { return fetch(url, init); }, options.headerTimeoutMs);
      var indexResponse = await fetchIndex(indexUrl, { cache: 'force-cache', signal: options.signal });
      if (!indexResponse.ok) throw fail('bundle index HTTP ' + indexResponse.status);
      archiveOptions.entries = validateBundleIndex(await indexResponse.json(), config.assetArchive.total);
      return openArchive(new Blob([]), options.zip, archiveOptions);
    }
    // Reuse an existing complete monolithic download without copying it into
    // parts. A cache miss never downloads the whole archive in lazy mode.
    var existing = !options.skipCompleteCache && stream.getCachedDataset ? await stream.getCachedDataset({
      cacheKey: config.assetArchive.cacheKey, buildId: config.buildId,
      expectedSize: config.assetArchive.total, mime: 'application/zip', onLog: options.onLog,
    }) : null;
    if (existing) {
      try {
        var mounted = await openArchive(existing.file, options.zip, archiveOptions);
        if (!options.bundleBase) {
          var originalBlobFor = mounted.blobFor, recovered = null;
          mounted.blobFor = async function (entry) {
            try { if (!recovered) return await originalBlobFor(entry); }
            catch (error) {
              if (options.signal && options.signal.aborted) throw error;
              if (options.onLog) options.onLog('old complete ZIP failed validation; recovering from immutable parts: ' + error.message);
              if (!recovered) recovered = (async function () {
                await stream.removeDataset(config.assetArchive.cacheKey);
                return openLazyArchive(config, Object.assign({}, options, { skipCompleteCache: true }));
              })();
            }
            var replacement = await recovered;
            var match = replacement.entryFor('https://cache.invalid/StreamingAssets/' + entry.filename);
            if (!match) throw fail('recovered archive is missing ' + entry.filename);
            return replacement.blobFor(match);
          };
          var closeOriginal = mounted.close;
          mounted.close = async function () {
            await closeOriginal();
            if (recovered) { var replacement = await recovered; await replacement.close(); }
          };
        }
        return mounted;
      } catch (error) {
        if (options.onLog) options.onLog('old complete ZIP index is invalid; using lazy parts: ' + error.message);
        await stream.removeDataset(config.assetArchive.cacheKey);
      } finally { existing.dispose(); }
    }
    var base = archiveBase(config, options.base);
    var limit = archiveRateLimit(options);
    var input = cache.createPartReader(parts(config, base), Object.assign({}, options, {
      stream: stream, buildId: config.buildId, cacheKey: config.assetArchive.cacheKey,
      fetchImpl: archiveFetch(config, options, base, limit),
      retryAfter: limit && limit.canWait() ? archiveRetryAfter() : null,
    }));
    return openArchive(input, options.zip, archiveOptions);
  }

  function rangeResponse(blob, rangeHeader, contentType) {
    var headers = new Headers({
      'Content-Type': contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    });
    var range = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || ''));
    if (!range) {
      headers.set('Content-Length', String(blob.size));
      return new Response(blob, { status: 200, headers: headers });
    }
    var start, end;
    if (!range[1] && range[2]) {
      var suffixBytes = Number(range[2]);
      start = Number.isSafeInteger(suffixBytes) && suffixBytes > 0 ? Math.max(0, blob.size - suffixBytes) : blob.size;
      end = blob.size - 1;
    } else {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Number(range[2]) : blob.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= blob.size) {
      headers.set('Content-Range', 'bytes */' + blob.size);
      return new Response(null, { status: 416, headers: headers });
    }
    end = Math.min(end, blob.size - 1);
    headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + blob.size);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(blob.slice(start, end + 1), { status: 206, headers: headers });
  }

  function installFetchMount(target, archive, options) {
    options = options || {};
    if (!target || typeof target.fetch !== 'function') throw fail('fetch is not available for the asset mount');
    var previous = target.fetch.bind(target);
    var onAsset = options.onAsset || function () {};
    var onVideo = options.onVideo || function () {};
    // Optional: hand the placeholder bytes to the page so it can stage them
    // in Unity's own heap (see play.html → stageInWasmHeap).
    var stageBytes = typeof options.stageBytes === 'function' ? options.stageBytes : null;
    var bypassVideos = options.bypassVideos !== false;
    // The cutscenes that were left out of the archive. A video that is
    // called something else than a video is only known by its name here.
    var videoNames = Object.create(null);
    (options.videoNames || []).forEach(function (name) {
      if (name) videoNames[String(name).toLowerCase()] = true;
    });

    target.fetch = function (input, init) {
      var rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
      if (!rawUrl) return previous(input, init);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var pathname = rawUrl;
      try {
        pathname = new URL(rawUrl, (typeof location !== 'undefined' && location.href) || 'https://silksong.invalid/').pathname;
      } catch (e) {
        pathname = String(rawUrl).split('?')[0].split('#')[0];
      }

      // Cutscenes never reach the network and never reach the ZIP: the
      // placeholder container is answered straight away, so a phone never
      // has to hold a high-definition video in memory.
      var isCutscene = isVideoPath(pathname) || videoNames[basename(decodePath(pathname)).toLowerCase()];
      if (bypassVideos && (method === 'GET' || method === 'HEAD') && isCutscene) {
        var kind = videoKindFor(pathname);
        var bytes = placeholderVideoBytes(kind);
        var contentType = kind === 'webm' ? 'video/webm' : 'video/mp4';
        onVideo(pathname, bytes.length);
        if (method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 200,
            headers: new Headers({
              'Content-Type': contentType,
              'Content-Length': String(bytes.length),
              'Accept-Ranges': 'bytes',
            }),
          }));
        }
        var videoRange = null;
        try {
          var videoHeaders = new Headers((init && init.headers) || (input && input.headers) || undefined);
          videoRange = videoHeaders.get('range');
        } catch (e) {}
        var body = bytes;
        if (stageBytes) {
          var staged = stageBytes(bytes);
          if (staged && staged.length === bytes.length) body = staged;
        }
        return Promise.resolve(rangeResponse(new Blob([body], { type: contentType }), videoRange, contentType));
      }

      var entry = archive.entryFor(rawUrl);
      if (!entry || (method !== 'GET' && method !== 'HEAD')) return previous(input, init);
      if (method === 'HEAD') {
        var entrySize = Number(entry.uncompressedSize || 0);
        return Promise.resolve(new Response(null, {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(entrySize),
            'Accept-Ranges': 'bytes',
          }),
        }));
      }

      var rangeHeader = null;
      try {
        var requestHeaders = new Headers((init && init.headers) || (input && input.headers) || undefined);
        rangeHeader = requestHeaders.get('range');
      } catch (e) {}

      onAsset(entry.filename);
      return archive.blobFor(entry).then(function (blob) {
        return rangeResponse(blob, rangeHeader);
      });
    };

    return function restore() { target.fetch = previous; };
  }

  return {
    validate: validate,
    parts: parts,
    ensureArchive: ensureArchive,
    planArchive: planArchive,
    openArchive: openArchive,
    openLazyArchive: openLazyArchive,
    timedFetch: timedFetch,
    crc32File: crc32File,
    validateBundleIndex: validateBundleIndex,
    installFetchMount: installFetchMount,
    // Exported for the test suite: the fetch `ensureArchive` downloads with,
    // which asks the descriptor's mirror once when the archive's own host
    // refuses a part (or cannot be reached at all).
    mirrorFetch: mirrorFetch,
    rateLimiter: rateLimiter,
    archiveRateLimit: archiveRateLimit,
    archiveRetryAfter: archiveRetryAfter,
    isRateLimitStatus: isRateLimitStatus,
    isGitHubHost: isGitHubHost,
    RATE_LIMIT_WAITS: RATE_LIMIT_WAITS,
    RATE_LIMIT_BUDGET: RATE_LIMIT_BUDGET,
    // Exported for the test suite and for anything that wants to build the
    // same placeholder container the build pipeline writes.
    makePlaceholderVideo: function (kind) {
      return kind === 'webm' ? makeWebmPlaceholder() : makeMp4Placeholder();
    },
    isVideoPath: isVideoPath,
    videoKindFor: videoKindFor,
  };
});
