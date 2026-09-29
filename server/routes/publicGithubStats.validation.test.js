/**
 * What the public GitHub-stats route accepts, and how often it asks GitHub
 * when GitHub says no (routes/publicGithubStats.js).
 *
 * Two promises, both silent when broken:
 *
 *   - the repository is fixed on the server, so `?repo=…` is refused in a
 *     sentence instead of being answered with this repository's numbers;
 *   - a failed upstream read is remembered for FAILURE_TTL_MS. It used to be
 *     remembered only when there was NO cached copy, so once the 24h copy
 *     aged out during a GitHub 403, every pageview asked GitHub again;
 *   - a release that could not be READ is not "no release". Any failure of
 *     the second call used to be cached for 24h as `latestRelease: null`, and
 *     the release chip left the site for a day. Only GitHub's 404 means none.
 *
 * No network: `fetch` and the clock are replaced, and every scenario loads a
 * fresh copy of the module, whose cache lives at module scope.
 *
 * Run: cd server && node --test routes/publicGithubStats.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
const terminalErrorHandler = createTerminalErrorHandler({ log: { warn() {}, error() {} } });

const HOUR = 60 * 60 * 1000;
const realFetch = global.fetch;
const realNow = Date.now;
let now = 1_800_000_000_000;
let upstream = [];           // every URL the route asked GitHub for
let githubAnswers = 'ok';    // 'ok' | 'rate-limited'
let releaseAnswers = 'ok';   // the release call alone: 'ok' | 'none' (404) | 'rate-limited'

const RATE_LIMITED = { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) };

function fakeFetch(url) {
    upstream.push(String(url));
    if (githubAnswers !== 'ok') return Promise.resolve(RATE_LIMITED);
    const isRelease = String(url).endsWith('/releases/latest');
    if (isRelease && releaseAnswers === 'rate-limited') return Promise.resolve(RATE_LIMITED);
    if (isRelease && releaseAnswers === 'none') {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) });
    }
    const body = isRelease
        ? { tag_name: 'v2.4.0', published_at: '2026-09-01T00:00:00Z' }
        : { stargazers_count: 1234, forks_count: 56, html_url: 'https://github.com/Bee-Flow/Bee-Flow' };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

test.beforeEach(() => {
    upstream = [];
    githubAnswers = 'ok';
    releaseAnswers = 'ok';
    now = 1_800_000_000_000;
    global.fetch = fakeFetch;
    Date.now = () => now;
});
test.afterEach(() => {
    global.fetch = realFetch;
    Date.now = realNow;
});

/** A fresh router: the cache, the failure stamp and the in-flight promise start empty. */
function freshRouter() {
    delete require.cache[require.resolve('./publicGithubStats')];
    return require('./publicGithubStats');
}

function dispatch(router, url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = { method: 'GET', url, originalUrl: url, path: pathname, query, headers: {}, get() { return undefined; } };
        const res = {
            statusCode: 200, headersSent: false, headers: {},
            set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

// ═══ the query ══════════════════════════════════════════════════════

test('asking for another repository is refused in words, and GitHub is not asked', async () => {
    const router = freshRouter();
    const res = await dispatch(router, '/github-stats?repo=acme/fork');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.strictEqual(res.body.error, 'This endpoint reports one repository, chosen on the server; it takes no parameters.');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(upstream, []);
});

test('the request the marketing section makes still answers with the numbers', async () => {
    const router = freshRouter();
    const res = await dispatch(router, '/github-stats');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.stars, 1234);
    assert.deepStrictEqual(res.body.latestRelease, { tag: 'v2.4.0', publishedAt: '2026-09-01T00:00:00Z' });
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=3600');
});

// ═══ the failure backoff ════════════════════════════════════════════

test('with a stale copy, a GitHub failure is not retried on every pageview', async () => {
    const router = freshRouter();
    await dispatch(router, '/github-stats');                 // warm the cache
    assert.strictEqual(upstream.length, 2, 'repo + latest release');

    now += 25 * HOUR;                                         // the copy ages out…
    githubAnswers = 'rate-limited';                           // …while GitHub says 403
    upstream = [];
    const first = await dispatch(router, '/github-stats');
    assert.strictEqual(first.statusCode, 200, 'stale beats nothing');
    assert.strictEqual(first.body.stars, 1234);
    assert.strictEqual(upstream.length, 1, 'the failure is asked once');

    upstream = [];
    for (let i = 0; i < 5; i += 1) {
        now += 60 * 1000;                                     // five more pageviews, a minute apart
        const res = await dispatch(router, '/github-stats');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.stars, 1234);
        assert.strictEqual(res.headers['cache-control'], 'public, max-age=600');
    }
    assert.deepStrictEqual(upstream, [], 'inside the failure window nobody asks GitHub again');
});

test('after the failure window, the stale copy is refreshed', async () => {
    const router = freshRouter();
    await dispatch(router, '/github-stats');
    now += 25 * HOUR;
    githubAnswers = 'rate-limited';
    await dispatch(router, '/github-stats');

    now += 11 * 60 * 1000;                                    // past FAILURE_TTL_MS
    githubAnswers = 'ok';
    upstream = [];
    const res = await dispatch(router, '/github-stats');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(upstream.length, 2, 'asked again once the window passed');
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=3600');
});

test('without any copy, a recent failure is still a 503 without asking again', async () => {
    const router = freshRouter();
    githubAnswers = 'rate-limited';
    const first = await dispatch(router, '/github-stats');
    assert.strictEqual(first.statusCode, 503);
    upstream = [];
    now += 60 * 1000;
    const second = await dispatch(router, '/github-stats');
    assert.strictEqual(second.statusCode, 503);
    assert.deepStrictEqual(second.body, { error: 'github_unavailable' });
    assert.deepStrictEqual(upstream, []);
});

// ═══ the release call ═══════════════════════════════════════════════

test('a repository without a release (GitHub 404) is an answer, kept for the day', async () => {
    const router = freshRouter();
    releaseAnswers = 'none';
    const res = await dispatch(router, '/github-stats');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.latestRelease, null);
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=3600');

    now += 11 * 60 * 1000;
    upstream = [];
    await dispatch(router, '/github-stats');
    assert.deepStrictEqual(upstream, [], 'not asked again within the day');
});

test('a release call that is rate-limited is not cached for a day as "no release"', async () => {
    const router = freshRouter();
    releaseAnswers = 'rate-limited';
    const first = await dispatch(router, '/github-stats');
    assert.strictEqual(first.statusCode, 200, 'the stars are still worth showing');
    assert.strictEqual(first.body.stars, 1234);
    assert.strictEqual(first.headers['cache-control'], 'public, max-age=600');

    now += 60 * 1000;                                         // a minute later: still the short copy
    upstream = [];
    const cached = await dispatch(router, '/github-stats');
    assert.deepStrictEqual(upstream, []);
    assert.strictEqual(cached.headers['cache-control'], 'public, max-age=600');

    now += 10 * 60 * 1000;                                    // past FAILURE_TTL_MS, not 24h
    releaseAnswers = 'ok';
    upstream = [];
    const later = await dispatch(router, '/github-stats');
    assert.strictEqual(upstream.length, 2, 'asked again after the failure window');
    assert.deepStrictEqual(later.body.latestRelease, { tag: 'v2.4.0', publishedAt: '2026-09-01T00:00:00Z' });
    assert.strictEqual(later.headers['cache-control'], 'public, max-age=3600');
});

test('when the release cannot be read on a refresh, the tag the site showed stays', async () => {
    const router = freshRouter();
    await dispatch(router, '/github-stats');                 // v2.4.0 cached
    now += 25 * HOUR;
    releaseAnswers = 'rate-limited';
    const res = await dispatch(router, '/github-stats');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.latestRelease, { tag: 'v2.4.0', publishedAt: '2026-09-01T00:00:00Z' });
    assert.strictEqual(res.headers['cache-control'], 'public, max-age=600');
});
