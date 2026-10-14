// @typecheck
/**
 * Tenant-key HMAC verification for machine-to-machine calls FROM the Nextcloud
 * connector — no user session is involved; the caller identifies the org by
 * its NC instance id and proves possession of that org's tenant key.
 *
 * Scheme (must stay byte-identical to the connector's signing side, e.g.
 * nextcloud-connector/src/taskProcessing.js executeViaSaaS and
 * studioAppMenus.js):
 *
 *   X-Beeflow-NC-Instance-Id: <instance id bound at bootstrap>
 *   X-Beeflow-Sig: <unixSeconds>.<hex hmac-sha256>
 *   message = `${ts}\n${METHOD}\n${originalUrl}\n${rawBody}`
 *
 * `originalUrl` is the full mounted path (+ query string) as Express saw it;
 * GET requests sign an empty body. 5-minute clock-skew tolerance, constant-
 * time comparison. Returns the org row on success, null on any failure —
 * callers answer 401 without detailing which check failed.
 *
 * The one copy of this check: routes/nextcloudTaskProcessing.js,
 * routes/nextcloudStudioApps.js, routes/automation/events.js (/events/nextcloud)
 * and routes/webhooks/ncEvents.js (/webhook/nc-user-sync) all call it, so a
 * change to the scheme (window, rotation, replay) lands everywhere at once.
 *
 * ── Replay ───────────────────────────────────────────────────────────
 *
 * The signature covers the timestamp but carries no nonce, so on its own a
 * captured request verifies again for as long as its timestamp is inside the
 * window. A caller whose request CHANGES state and must happen once (the
 * user-sync webhook: a replayed `user.deleted` deactivates an account the
 * admin re-created in the meantime) passes `{ rejectReplay: true }`: the
 * first delivery of a signature is accepted and remembered until its
 * timestamp leaves the window, a second one is refused like any bad
 * signature. It is opt-in because the GET callers legitimately send the same
 * signed request twice in one second (same ts, same URL, empty body = the
 * same signature).
 *
 * The memory is per process (like utils/perUserRateLimit's in-memory path):
 * with several replicas a replay that lands on another replica is not
 * caught. Keyed on the EXPECTED digest, not the header text, so re-casing the
 * hex (Buffer.from accepts both) does not make a replay look new.
 */

const crypto = require('crypto');
// configStore and userStore are required lazily (through DEFAULT_DEPS), not
// here: importing configStore stands up the Postgres pool at module load, which
// makes dependants un-requireable in infra-free unit tests. Tests swap them
// through _setDepsForTests instead of reaching into the module cache.
const DEFAULT_DEPS = {
    configStore: () => require('../stores/configStore'),
    userStore: () => require('../stores/userStore'),
};
let _deps = { ...DEFAULT_DEPS };

const SKEW_SECONDS = 300;
// An upper bound on remembered signatures, so a flood of valid ones (which
// needs the tenant key) cannot grow the map without limit. At the events
// rate limit (600/min/IP) one connector fills ~3000 in a window.
const MAX_SEEN = 50_000;
/** @type {Map<string, number>} org:digest -> ms after which the ts is out of the window */
const seen = new Map();

/**
 * True when this signature was already accepted inside its window; records
 * it otherwise. Expired entries are swept when the map is full.
 * @param {string} key
 * @param {number} ts
 */
function isReplay(key, ts) {
    const now = Date.now();
    const until = seen.get(key);
    if (until !== undefined && until > now) return true;
    if (seen.size >= MAX_SEEN) {
        for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
        // Still full: drop the oldest. That entry's remaining window is the
        // only thing given up, and only under a flood of signed requests.
        while (seen.size >= MAX_SEEN) {
            const oldest = seen.keys().next().value;
            if (oldest === undefined) break;
            seen.delete(oldest);
        }
    }
    seen.set(key, (ts + SKEW_SECONDS + 1) * 1000);
    return false;
}

/**
 * @param {any} req
 * @param {{ rejectReplay?: boolean }} [opts]
 */
async function verifyConnectorSig(req, { rejectReplay = false } = {}) {
    const configStore = _deps.configStore();
    const instanceId = String(req.headers['x-beeflow-nc-instance-id'] || '');
    if (!instanceId) return null;
    const userStore = _deps.userStore();
    const org = await userStore.getOrganizationByNcInstanceId(instanceId).catch(() => null);
    if (!org) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) return null;

    const sigHeader = String(req.headers['x-beeflow-sig'] || '');
    const dot = sigHeader.indexOf('.');
    if (dot === -1) return null;
    const ts = parseInt(sigHeader.slice(0, dot), 10);
    const sig = sigHeader.slice(dot + 1);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > SKEW_SECONDS) return null;

    const message = `${ts}\n${req.method}\n${req.originalUrl}\n${req.rawBody || ''}`;
    const expected = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    if (expected.length !== sig.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
    } catch { return null; }
    // Only a VERIFIED signature is remembered: nobody without the key can
    // fill the map, or pre-empt a delivery they could not have signed.
    if (rejectReplay && isReplay(`${org.id}:${expected}`, ts)) return null;
    return org;
}

/**
 * Test seam: replace the lazily required stores (`{ configStore, userStore }`,
 * each a getter); no argument restores the real ones.
 * @param {Partial<typeof DEFAULT_DEPS> | null} [over]
 */
function _setDepsForTests(over = null) {
    _deps = { ...DEFAULT_DEPS, ...(over || {}) };
}

module.exports = { verifyConnectorSig, _resetReplayCacheForTests: () => seen.clear(), _setDepsForTests };
