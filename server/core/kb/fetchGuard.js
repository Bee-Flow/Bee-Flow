// @typecheck
const { assertUrlIsPublic } = require('./kbIngestionHelpers');
const { safeFetch } = require('../../utils/ssrfGuard');

/**
 * The SSRF screen every caller-influenced knowledge-base fetch goes through.
 *
 * Lifted verbatim out of `routes/knowledgeBases/shared.js` when the scheduled
 * refresh engine (`core/kb/sources`) needed the same guard: `core/` may not
 * require `routes/`, and a second copy of a security control is how one of
 * the two quietly misses the next fix. `shared.js` re-exports these, so the
 * routes and `knowledgeBases.ssrf.test.js` see no change at all.
 *
 * Used by: the sitemap walker, a URL an ingest was handed, a `source_uri`
 * stored by an earlier ingest, and now every scheduled webpage refresh — the
 * last of which is why this matters more than it did: a URL screened once at
 * creation is fetched again every week, by a job, with nobody watching.
 *
 * Same two layers fetchUrlContent applies, because these call sites need the
 * raw body (XML / robots.txt) rather than markdown and so can't go through it:
 *   1. assertUrlIsPublic — screens the host and EVERY address it resolves to
 *      before a socket is opened.
 *   2. safeFetch — revalidates inside the connect handler on the initial
 *      request and on each redirect hop, which is what actually defeats DNS
 *      rebinding and redirect laundering.
 *
 * Every URL is screened individually and on its own merits. Validating only
 * the origin the caller supplied is worthless here: the <loc> entries come out
 * of a sitemap the attacker hosts, so they need not share that origin — that
 * indirection is exactly what turned this endpoint into an arbitrary internal
 * GET with the response body ingested into a searchable KB.
 */

// The one target that is refused in every mode — shared with the Nextcloud
// guard so there is a single list of metadata hostnames in the product.
const { isMetadataHost } = require('../../integrations/nextcloudTarget');

/**
 * Deployment-level escape hatch, defaulting CLOSED.
 *
 * The guard above is the right default and is what closes the SSRF, but it is
 * also a new functional restriction for on-prem customers: a self-hosted
 * install legitimately wants to index its own intranet wiki, and every url on
 * such a box is an RFC1918 address. The repo already ships this exact escape
 * hatch twice — integrations/shared/apiClient.js (`allowPrivate`) and
 * integrations/nextcloudTarget.js (NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1) — so the KB
 * fetches get the equivalent rather than a hard wall.
 *
 * Properties that make it safe to have at all:
 *   - Off unless the operator sets KB_ALLOW_PRIVATE_HOSTS=1 in the environment.
 *     Nothing in req.body, no KB setting and no per-user preference can reach
 *     it, so a manage_knowledge user cannot turn the guard off for one request.
 *   - Cloud metadata endpoints (169.254.169.254, metadata.google.internal, …)
 *     stay refused in BOTH modes. No intranet wiki lives there, and that is the
 *     one target where a blind SSRF turns straight into cloud credentials.
 *   - Non-http(s) schemes stay refused in both modes.
 */
function allowPrivateKbHosts() {
    return process.env.KB_ALLOW_PRIVATE_HOSTS === '1';
}

async function screenTarget(targetUrl, allowPrivate) {
    // Default posture: the full screen — host plus every address it resolves to.
    if (!allowPrivate) return assertUrlIsPublic(targetUrl);

    // Opted-in posture: private space is what the operator asked for, but the
    // scheme and the metadata endpoints are still not negotiable.
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (_) { throw new Error('Invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP/HTTPS URLs are allowed');
    }
    if (isMetadataHost(parsed.hostname)) {
        throw new Error(`URL ${parsed.hostname} is a cloud metadata endpoint and is never fetched`);
    }
    return parsed;
}

async function guardedFetch(targetUrl, opts = {}) {
    // Read once per fetch so a request cannot straddle two policies.
    const allowPrivate = allowPrivateKbHosts();
    await screenTarget(targetUrl, allowPrivate);
    // safeFetch refuses private addresses at connect time, which is precisely
    // what the opted-in mode exists to permit — so that mode uses the plain
    // fetch and gives up the rebinding defence along with it. That is the
    // trade the operator made by setting the flag; it is not reachable without.
    const response = await (allowPrivate ? fetch : safeFetch)(targetUrl, opts);
    const resolved = response.url || targetUrl;
    if (resolved !== targetUrl) await screenTarget(resolved, allowPrivate);
    return response;
}


module.exports = { guardedFetch, screenTarget, allowPrivateKbHosts };
