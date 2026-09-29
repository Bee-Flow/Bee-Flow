/**
 * GET /api/public/github-stats — live repository facts for the marketing
 * site's `github-stats` block (stars, latest release).
 *
 * Unauthenticated by design: it serves anonymous marketing visitors and
 * exposes only what github.com already shows the world. The URL is fixed
 * server-side (env-overridable, never caller-supplied), so the SSRF guards
 * that wrap user-provided URLs elsewhere do not apply here.
 *
 * Fail-soft: a ~24h in-memory cache answers most requests; when GitHub is
 * unreachable a stale cache still answers, and with no cache at all the
 * route returns 503 — the frontend section then renders its link-only
 * fallback instead of empty numbers.
 *
 * A failure is remembered for FAILURE_TTL_MS whether or not there is a stale
 * copy to serve. It used to hold only with NO cache: once the 24h copy aged
 * out while GitHub answered 403 (rate limit) or 404 (a repository it cannot
 * see), every pageview paid an upstream round trip that failed again,
 * burning the 60-per-hour budget the backoff below exists to protect.
 *
 * ── No query, and why `?repo=` is refused rather than ignored ─────────
 *
 * The repository is REPO, full stop. The block's `repoUrl` is a link the
 * section renders (marketing/sections/GitHubStats.jsx); it is not sent here
 * and never chooses the numbers. A caller asking `?repo=acme/fork` used to
 * get this repository's numbers under a 200; only the `url` inside the answer
 * said they were not the fork's. It gets a sentence now. (The section itself
 * still shows these numbers next to whatever `repoUrl` an admin configured,
 * and does not read that `url` — a client-side fix, not one for this route.)
 */
const express = require('express');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const router = express.Router();

const NO_QUERY_TEXT = 'This endpoint reports one repository, chosen on the server; it takes no parameters.';
const NO_QUERY = z.object({}).strict(NO_QUERY_TEXT);

const REPO = process.env.GITHUB_STATS_REPO || 'Bee-Flow/Bee-Flow';
const TTL_MS = 24 * 60 * 60 * 1000;
// Failures are cached too, briefly. Without this a repo GitHub cannot see
// (private, renamed) made every single marketing pageview trigger a fresh
// server→GitHub request, which burns the 60-per-hour unauthenticated rate
// limit within minutes and adds a round trip to a page that gets nothing back.
const FAILURE_TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, data: null, releaseUnknown: false };
let failedAt = 0;
let inFlight = null; // dedupes a cold-cache stampede into one upstream fetch

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'beeflow-server',
        },
    });
    if (!res.ok) {
        const err = new Error(`GitHub responded ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

/**
 * `previous` is the copy being replaced, if any. `releaseUnknown` says the
 * release could not be read: GitHub answers 404 when a repository has no
 * published release, and that is an answer — a 403 (the rate limit, often
 * reached exactly between these two calls), a 5xx or a dropped connection is
 * not. Those used to be caught as "no release" and cached for the full 24h,
 * so the release chip vanished from the site for a day. Now the previous tag
 * is carried over and the copy is kept only as long as a failure is.
 */
async function loadStats(previous) {
    const repo = await fetchJson(`https://api.github.com/repos/${REPO}`);
    let latestRelease = null;
    let releaseUnknown = false;
    try {
        const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
        latestRelease = { tag: rel.tag_name || '', publishedAt: rel.published_at || null };
    } catch (err) {
        if (err.status !== 404) {
            releaseUnknown = true;
            latestRelease = previous ? previous.latestRelease : null;
        }
    }
    const data = {
        stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : null,
        forks: Number.isFinite(repo.forks_count) ? repo.forks_count : null,
        latestRelease,
        url: repo.html_url || `https://github.com/${REPO}`,
    };
    return { data, releaseUnknown };
}

router.get('/github-stats', validate({ query: NO_QUERY }), async (req, res) => {
    if (cache.data && Date.now() - cache.at < TTL_MS) {
        res.set('Cache-Control', cache.releaseUnknown ? 'public, max-age=600' : 'public, max-age=3600');
        return res.json(cache.data);
    }
    // A recent failure is not retried per pageview — with a stale copy to show
    // for it just as much as without one.
    if (Date.now() - failedAt < FAILURE_TTL_MS) {
        res.set('Cache-Control', 'public, max-age=600');
        if (cache.data) return res.json(cache.data);
        return res.status(503).json({ error: 'github_unavailable' });
    }
    try {
        if (!inFlight) {
            inFlight = loadStats(cache.data).finally(() => { inFlight = null; });
        }
        const { data, releaseUnknown } = await inFlight;
        // A copy without a readable release is asked again after
        // FAILURE_TTL_MS, not tomorrow.
        cache = { at: releaseUnknown ? Date.now() - TTL_MS + FAILURE_TTL_MS : Date.now(), data, releaseUnknown };
        failedAt = 0;
        res.set('Cache-Control', releaseUnknown ? 'public, max-age=600' : 'public, max-age=3600');
        return res.json(data);
    } catch (err) {
        failedAt = Date.now();
        if (cache.data) {
            // Stale beats nothing; retry sooner than the regular TTL.
            res.set('Cache-Control', 'public, max-age=600');
            return res.json(cache.data);
        }
        return res.status(503).json({ error: 'github_unavailable' });
    }
});

module.exports = router;
