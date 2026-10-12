/**
 * The SPA shell (agent-hub's built index.html), fetched and cached.
 *
 * WHY FETCH RATHER THAN BUNDLE: `agent-hub` and `server` are separate images,
 * built and deployed independently (scripts/build-images.ps1 takes a service
 * name). Baking a copy of index.html into the server image would mean the two
 * could disagree — the server would inject into a shell referencing asset
 * hashes that no longer exist, and every page would 404 its own JavaScript.
 * Fetching it from the running agent-hub means the shell is always the one
 * actually being served.
 *
 * The cache has a short TTL rather than being permanent: a deploy replaces the
 * agent-hub container with new asset hashes, and the server must pick that up
 * without a restart of its own.
 */
const log = require('../../telemetry/log');

const DEFAULT_ORIGIN = process.env.AGENT_HUB_ORIGIN || 'http://agent-hub';
const TTL_MS = Number(process.env.SEO_SHELL_TTL_MS || 60_000);
const FETCH_TIMEOUT_MS = 3_000;

let cache = { html: null, at: 0 };

function _reset() { cache = { html: null, at: 0 }; }

/**
 * @returns {Promise<string|null>} the shell HTML, or null when unavailable.
 *   Null is a normal outcome, not an error: the caller falls back to letting
 *   nginx serve the static shell, so an unreachable agent-hub degrades the
 *   page to its old client-rendered behaviour instead of failing the request.
 */
async function getShell({ origin = DEFAULT_ORIGIN, now = Date.now() } = {}) {
    if (cache.html && (now - cache.at) < TTL_MS) return cache.html;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(`${origin}/index.html`, {
                signal: controller.signal,
                headers: { 'X-Beeflow-Internal': 'seo-shell' },
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        // A shell with no mount point is not a shell — refusing it here beats
        // serving a page whose content React will never replace.
        if (!html.includes('<div id="root">')) throw new Error('no #root in shell');
        cache = { html, at: now };
        return html;
    } catch (err) {
        log.warn('[SEO] shell fetch failed:', err.message);
        // Serve a stale shell rather than nothing: asset hashes from the
        // previous build are still on disk in the running container.
        return cache.html || null;
    }
}

module.exports = { getShell, _reset, TTL_MS, DEFAULT_ORIGIN };
