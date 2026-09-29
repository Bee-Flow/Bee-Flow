/**
 * "Reuse this app's answer ACROSS runs" — the organisation's policy for it.
 *
 * There are two caches, and they are not the same thing:
 *
 *   1. The RUN MEMO (toolMemo.js). Lives on the run's ctx and dies with it.
 *      Cannot cross a user, an org, a run or a replica BY CONSTRUCTION, so it
 *      needs no policy beyond the per-step tick.
 *   2. THIS ONE. A row in Postgres that OUTLIVES the run, so every guarantee
 *      the memo gets for free has to be established here on purpose — and one
 *      of them (a stable key) cannot be established at all under some privacy
 *      modes. Hence a policy, hence off by default.
 *
 * ── WHY OFF BY DEFAULT, AND OFF AT THREE LEVELS ─────────────────────
 * Off unless ALL of these say yes:
 *   env    INTEGRATION_CACHE_DISABLED not ON         (self-host / incident kill switch)
 *   org    policy.enabled === true                   (default false, admin opt-in)
 *   org    policy.scopes[<kind>] === true            (integration / http, see normalizeScopes)
 *   step   step.askOnce.acrossRuns === true          (default absent)
 *
 * Three levels rather than one because they answer three different questions:
 * an operator needs to switch it off for the whole box without touching data,
 * an organisation needs to decide whether third-party answers may be stored at
 * all, and the person building a routine is the only one who knows whether
 * THIS look-up's answer is still true five minutes later.
 *
 * ── WHAT IT IS NEVER ALLOWED TO DO ──────────────────────────────────
 * The eligibility gate in execAi refuses a durable entry whenever
 * `safety.egressMode(...) !== 'real'`, and that line is load-bearing rather
 * than belt-and-braces here. Under `tokenize` the outgoing arguments are
 * run-vault PLACEHOLDERS, and under `redact` every person collapses to the
 * literal `[person]` — so two different data subjects produce the SAME
 * arguments, and a cache keyed on those arguments would hand one person's
 * answer to another. Within a single run those labels are stable and the memo
 * is safe; across runs the vault is gone and they are not.
 *
 * Stored per org under `org_integration_cache_<orgId>` (configStore), memoised
 * for CACHE_TTL_MS because it is read on the step hot path.
 */

'use strict';

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_integration_cache_';
const CACHE_TTL_MS = 30_000;

const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

/**
 * The product default. `enabled: false` is deliberate and is NOT env-tunable
 * the way chat compaction's is: turning it on stores third-party response
 * payloads for a whole organisation, which is a decision that belongs to that
 * organisation's admin and should leave a config row saying they made it.
 */
const DEFAULT_POLICY = Object.freeze({
    enabled: false,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    scopes: Object.freeze({ integration: true, http: false }),
});

const _cache = new Map();   // orgId|'' → { at, policy }

/**
 * The shared operator-switch grammar: `1` / `true` / `on` / `yes` (any case,
 * padding tolerated) mean ON, everything else — `0` and `false` included —
 * means OFF.
 *
 * Exported because bare truthiness on an env var is a trap operators walk
 * into. `AUTOMATION_ASK_ONCE_DISABLED=0` is a non-empty string, so a
 * `!process.env.X` test switches the feature OFF at the exact moment someone
 * writes the word they think means "leave it on" — and the only symptom is a
 * routine quietly getting slower.
 */
function envFlagOn(name) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Is the whole feature switched off for this process? */
function killSwitchOn() {
    return envFlagOn('INTEGRATION_CACHE_DISABLED');
}

/**
 * WHICH outbound answers this consent covers.
 *
 * One key, one screen, two ticks — because the underlying decision is the same
 * one ("may third-party response payloads be stored at rest for this org") and
 * two config keys would let an org sit half-on with nobody able to see which
 * half. But an admin who consented to "what an app answers" did not consent to
 * arbitrary outbound HTTP, so widening it takes a fresh tick rather than a copy
 * change.
 *
 * `integration` defaults ON when absent: a row written before this existed was
 * an admin saying yes to the app-look-up cache, which is exactly what that flag
 * means, and migrations/integration-cache-scopes-2026-09 stamps the same value.
 * A replica that reads such a row before the migration lands must not disagree
 * with it.
 *
 * `http` defaults OFF and only a literal true turns it on. There is no reading
 * of an older config row under which the admin agreed to this.
 */
function normalizeScopes(stored) {
    const src = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    return { integration: src.integration !== false, http: src.http === true };
}

/**
 * Normalise a stored blob into a complete policy. Anything unrecognised falls
 * back to the DEFAULT, never to "on" — a corrupt config row must not be the
 * thing that starts storing an organisation's data.
 */
function normalizePolicy(stored) {
    const src = (stored && typeof stored === 'object') ? stored : {};
    const enabled = src.enabled === true;

    let ttl = DEFAULT_TTL_SECONDS;
    if (src.ttlSeconds !== null && src.ttlSeconds !== undefined && src.ttlSeconds !== '') {
        const n = Number(src.ttlSeconds);
        if (Number.isFinite(n)) ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(n)));
    }
    return { enabled, ttlSeconds: ttl, scopes: normalizeScopes(src.scopes) };
}

/**
 * The effective policy for an organisation. `orgId` may be null (a personal
 * account) — those never get the durable cache, because "the organisation
 * decided" has no one to be true of.
 *
 * Never throws: a config-store failure falls back to the default, which is off.
 */
async function resolveCachePolicy(orgId) {
    if (killSwitchOn()) return { ...DEFAULT_POLICY, enabled: false, killSwitch: true };
    if (!orgId) return { ...DEFAULT_POLICY };

    const hit = _cache.get(orgId);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) return hit.policy;
    return await readPolicy(orgId);
}

/**
 * The same policy, read straight from the config row — no memo.
 *
 * `invalidateCachePolicy` is in-process only, so after an admin switches the
 * feature off and purges, ANOTHER replica keeps its 30-second-old "enabled:
 * true" and refills the table behind them. That is fine on the read path (a
 * stale hit is an answer they consented to storing) and not fine on the write
 * path, where it manufactures rows after the deletion.
 *
 * Only the write path uses this: a durable write is rare next to the step hot
 * path, so one extra config read per stored answer is cheap, and the read side
 * stays memoised.
 */
async function resolveCachePolicyFresh(orgId) {
    if (killSwitchOn()) return { ...DEFAULT_POLICY, enabled: false, killSwitch: true };
    if (!orgId) return { ...DEFAULT_POLICY };
    return await readPolicy(orgId);
}

async function readPolicy(orgId) {
    let stored = null;
    try {
        stored = await configStore.getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
    } catch (err) {
        log.warn(`[IntegrationCache] policy read failed for org ${orgId}: ${err.message}`);
    }
    const policy = normalizePolicy(stored);
    _cache.set(orgId, { at: Date.now(), policy });
    return policy;
}

/** Drop the memoised policy for an org — called by the settings route on save. */
function invalidateCachePolicy(orgId) {
    if (orgId) _cache.delete(orgId);
    else _cache.clear();
}

module.exports = {
    resolveCachePolicy,
    resolveCachePolicyFresh,
    invalidateCachePolicy,
    normalizePolicy,
    normalizeScopes,
    killSwitchOn,
    envFlagOn,
    CONFIG_KEY_PREFIX,
    DEFAULT_POLICY,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS,
};
