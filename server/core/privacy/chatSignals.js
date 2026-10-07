/**
 * Chat signals: the recorder.
 *
 * Purpose: checking whether the Privacy Shield works on chat messages (GDPR
 * Art. 32(1)(d)). For each counted turn, the outcome the Privacy Shield or DLP
 * ALREADY decided on that turn, inside the same request, becomes a counter.
 * Nothing new is scanned, nothing is re-read, no classifier runs.
 *
 *   countTurn(...)       the one call a chat hook makes: synchronous, returns
 *                        undefined, never throws, never awaited. All I/O (the
 *                        resolver memo, the objection lookup) runs after the
 *                        request has moved on.
 *   recordChatTurn(...)  turns one decided turn into counter keys. Exported for
 *                        tests; it destructures exactly seven keys, so nothing
 *                        else (a user id, a conversation, an agent, the text)
 *                        can travel into the counters.
 *
 * A turn is counted only when ALL hold: the surface is on for the org (the
 * shared resolver, core/entitlements/chatMonitoringFlag.js); the client sent
 * the notice marker for exactly the current version ("announced equals
 * counted", amendment 16: old apps, API clients and cached pages without the
 * notice are not counted); the request did not opt out; and a signed-in
 * person has not objected ("Don't count my chat turns"). `userId` is used for
 * that objection lookup only and goes no further.
 *
 * Health data is dropped, never counted as 'other' (amendment 3), and so is a
 * label that reads as another special category or criminal data. Labels are
 * dropped right after mapping and are never logged.
 *
 * Counts sit in an in-process map keyed by the table's primary key, flushed as
 * ONE additive upsert every CHAT_SIGNALS_FLUSH_MS (60 s), early at 5 000 keys,
 * and on graceful shutdown. A failed flush is retried once with the next one,
 * then dropped (the key count is logged, nothing else). A crash can lose up to
 * a minute of counts, which is why the checks call the figures approximate.
 */

'use strict';

const V = require('../../stores/lib/chatMonitoringVocab');
const { periodStart } = require('../../stores/lib/chatSignalSuppression');
const { classifyProvider } = require('../providers/classification');
const { LOCAL_PROVIDER_TYPES } = require('../providers/localModels');
const { normalizeCategory } = require('./piiCategories');
const { kindOfCategory } = require('./personalColumns');
const { isAnonymousUserId } = require('../../utils/anonymousUser');
const log = require('../../telemetry/log');

// Lazy, so requiring the recorder costs nothing until a turn is counted.
const _store = () => require('../../stores/chatSignalStore');
const _objections = () => require('../../stores/chatSignalObjectionStore');
const _resolver = () => require('../entitlements/chatMonitoringFlag');

const ORG_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCAL_TYPES = new Set(LOCAL_PROVIDER_TYPES);
const MAX_KEYS = 5000;
const FLUSH_MS = (() => {
    const n = parseInt(process.env.CHAT_SIGNALS_FLUSH_MS, 10);
    return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

// ── pure helpers ─────────────────────────────────────────────────────────

/**
 * The provider of the model a turn went to, in the counters' vocabulary.
 * @param {string|null|undefined} type
 */
function normaliseProviderType(type) {
    const t = String(type || '').trim().toLowerCase();
    if (!t) return 'other';
    if (t === 'google-vertex' || t === 'google_vertex') return 'google_vertex';
    if (t === 'local' || LOCAL_TYPES.has(t)) return 'local';
    return V.PROVIDER_TYPES.includes(t) ? t : 'other';
}

/**
 * The PII gate's report (core/privacy/piiDetection/validate.js, `options.report`)
 * as an outcome. `deferred_to_dlp` is null: the DLP result decides that turn.
 * @param {{ status?: string, decision?: string }|null|undefined} report
 * @returns {string|null}
 */
function outcomeFromPiiReport(report) {
    const status = report && typeof report === 'object' ? report.status : undefined;
    switch (status) {
        case 'disabled':
        case 'allowed_by_policy':
            return 'unscanned';
        case 'too_short':   // under 3 characters no entity can be detected; both gates skip by design
        case 'clean':
            return 'clean';
        case 'guard_absent':
        case 'failed_open':
            return 'scan_failed_open';
        case 'failed_closed':
            return 'scan_failed_closed';
        case 'found':
            if (report.decision === 'tokenised') return 'protected';
            if (report.decision === 'blocked') return 'blocked';
            return 'unscanned';
        case 'deferred_to_dlp':
            return null;
        default:
            return 'unscanned';
    }
}

/**
 * The DLP preflight's result (core/dlp/dlpPreflight.js) as an outcome.
 * @param {{ outcome?: string, scanStatus?: string, categories?: string[], tooShort?: boolean }|null|undefined} dlp
 * @returns {string}
 */
function outcomeFromDlp(dlp) {
    if (!dlp || typeof dlp !== 'object') return 'unscanned';
    const found = Array.isArray(dlp.categories) && dlp.categories.length > 0;
    switch (dlp.outcome) {
        case 'blocked':
            return dlp.scanStatus === 'failed' ? 'scan_failed_closed' : 'blocked';
        case 'redacted':
            return 'protected';
        case 'scan_failed':
            return 'scan_failed_open';
        case 'allow':
            if (dlp.scanStatus === 'failed') return 'scan_failed_open';   // asked after a failed scan, then sent
            if (found) return 'sent_unprotected';                          // "send anyway", or auto-allow with findings
            if (dlp.scanStatus === 'skipped') return dlp.tooShort === true ? 'clean' : 'unscanned';
            if (dlp.scanStatus === 'ok') return 'clean';
            return 'unscanned';
        default:
            return 'unscanned';
    }
}

// Spellings of health data that the category tables do not know. Dropping
// more is the safe direction: health is never counted, in any form.
const HEALTH_HINT = /health|medic|medisch|patient|diagnos|disease|illness|sickness|gezondheid|ziekte/;
// The other special categories (GDPR Art. 9) and criminal data (Art. 10). No
// built-in detector reports them, but an organisation can name its own data
// type after one; folded into 'other', that count would be the special
// category whenever it is the org's only own type. Dropped for the same
// reason health is (legal verdict, do_not_build.special-kinds).
const SPECIAL_CATEGORY_HINT = /religio|geloof|levensbeschouw|ethnic|etnisch|etnici|racial|sexual|seksue|politic|politiek|tradeunion|vakbond|biometr|genetic|genetisch|crimin|strafrecht|strafbla|conviction|veroordel/;

/**
 * One guard or DLP label as a kind of personal data, or null (dropped).
 *   ApiKeyOrSecret → 'credential'; Organization and URL → null; anything that
 *   maps to health, or reads as another special category or criminal data →
 *   null, never 'other'; the guard's own audit markers (scan_*) → null; a
 *   known kind → itself; anything else (org data types, custom DLP terms,
 *   UserMarked) → 'other'.
 * @param {string} label
 * @returns {string|null}
 */
function kindOf(label) {
    const c = normalizeCategory(label);
    if (!c) return null;
    if (c === 'ApiKeyOrSecret') return 'credential';
    if (c === 'Organization' || c === 'URL') return null;
    if (/^scan_/i.test(c)) return null;
    const k = kindOfCategory(label);
    if (k === 'health') return null;
    const squashed = String(label).toLowerCase().replace(/[^a-z]/g, '');
    if (HEALTH_HINT.test(squashed) || SPECIAL_CATEGORY_HINT.test(squashed)) return null;
    if (k && V.KINDS.includes(k)) return k;
    return 'other';
}

// ── the org key (build spec 4.2) ─────────────────────────────────────────
//
// One rule serves the recorder and the in-chat notice, so a turn is counted
// under exactly the org whose notice the person saw.

/**
 * A direct-chat turn counts under the caller's effective org
 * (core/llm/modelResolver.resolveEffectiveOrgId, the same lookup
 * /api/privacy/shield-status uses), or the 'default' bucket without one.
 * @param {string|null|undefined} effectiveOrgId
 */
function directOrgKey(effectiveOrgId) {
    return typeof effectiveOrgId === 'string' && effectiveOrgId ? effectiveOrgId : 'default';
}

/**
 * Where an agent turn counts, or null when it must not be counted:
 *   a website visitor (guest id)               'agent_public' under the agent's org
 *   a member whose org IS the agent's org      'agent' under the agent's org
 *   a member of another org, a super admin
 *   (no caller org), an agent without an org   null: that org could not tell them
 * @param {{ userId?: string|null, callerOrgId?: string|null, agentOrgId?: string|null }} p
 * @returns {{ surface: 'agent'|'agent_public', orgKey: string } | null}
 */
function agentTurnTarget({ userId, callerOrgId, agentOrgId }) {
    if (typeof agentOrgId !== 'string' || !agentOrgId) return null;
    if (isAnonymousUserId(userId)) return { surface: 'agent_public', orgKey: agentOrgId };
    if (typeof callerOrgId === 'string' && callerOrgId && callerOrgId === agentOrgId) return { surface: 'agent', orgKey: agentOrgId };
    return null;
}

// ── aggregator ───────────────────────────────────────────────────────────

const PK = ['organization_id', 'period_start', 'granularity', 'surface', 'signal', 'value', 'destination', 'provider_type', 'protection'];

let _map = new Map();     // primary key joined with '|' -> turns
let _retry = null;        // the keys of one failed flush, sent once more with the next
let _timer = null;
let _chain = null;        // flushes run one after another
let _dropped = 0;         // keys refused while the map was full
let _now = () => new Date();

function _arm() {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = null; flush().catch(() => {}); }, FLUSH_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
}

function _bump(key) {
    if (!_map.has(key) && _map.size >= MAX_KEYS) { _dropped++; return; }
    _map.set(key, (_map.get(key) || 0) + 1);
    if (_map.size >= MAX_KEYS) flush().catch(() => {});
    else _arm();
}

function _rowsOf(map) {
    const rows = [];
    for (const [key, turns] of map) {
        const parts = key.split('|');
        const row = Object.fromEntries(PK.map((c, i) => [c, parts[i]]));
        rows.push({ ...row, turns });
    }
    return rows;
}

async function _flushOnce() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_dropped) {
        log.warn(`[ChatSignals] dropped ${_dropped} keys: the counter map was full`);
        _dropped = 0;
    }
    const fresh = _map;
    _map = new Map();
    const retry = _retry;
    _retry = null;
    if (!fresh.size && !(retry && retry.size)) return 0;
    const merged = new Map(fresh);
    if (retry) for (const [k, n] of retry) merged.set(k, (merged.get(k) || 0) + n);
    const rows = _rowsOf(merged);
    try {
        await _store().addCounts(rows);
        return rows.length;
    } catch (_) {
        if (retry && retry.size) log.warn(`[ChatSignals] dropped ${retry.size} keys after a failed flush`);
        _retry = fresh.size ? fresh : null;
        if (_retry) _arm();
        return 0;
    }
}

/**
 * Write what is in the map now. Resolves with the number of keys written
 * (0 on a failed write, whose keys wait for one more try). Never rejects.
 * @returns {Promise<number>}
 */
function flush() {
    const run = (_chain || Promise.resolve(0)).then(_flushOnce, _flushOnce).catch(() => 0);
    _chain = run;
    return run;
}

/**
 * One decided turn as counter keys. Synchronous; returns whether it counted.
 * @param {{ orgKey: string, surface: string, outcome: string, categories?: string[],
 *   providerConfig?: { providerType?: string, url?: string }|null, allowlistedHosts?: string[], signals?: string[] }} turn
 */
function recordChatTurn({ orgKey, surface, outcome, categories, providerConfig, allowlistedHosts, signals }) {
    try {
        if (typeof orgKey !== 'string' || !ORG_RE.test(orgKey)) return false;
        if (!V.SURFACES.includes(surface) || !V.OUTCOMES.includes(outcome)) return false;
        const granularity = V.granularityFor(surface);
        const period = periodStart(granularity, _now());
        const hosts = Array.isArray(allowlistedHosts) ? allowlistedHosts.filter(h => typeof h === 'string') : [];
        let destination = 'unknown';
        let providerType = '';
        if (providerConfig && typeof providerConfig === 'object') {
            const cfg = { providerType: providerConfig.providerType, url: providerConfig.url };
            destination = classifyProvider(cfg, hosts).isExternal ? 'external' : 'internal';
            providerType = normaliseProviderType(cfg.providerType);
        }
        _bump([orgKey, period, granularity, surface, 'outcome', outcome, destination, providerType, ''].join('|'));
        if (Array.isArray(signals) && signals.includes('kinds') && V.FOUND_OUTCOMES.includes(outcome)) {
            const protection = outcome === 'sent_unprotected' ? 'exposed' : 'protected';
            const kinds = new Set();
            for (const label of Array.isArray(categories) ? categories : []) {
                const k = kindOf(label);
                if (k) kinds.add(k);
            }
            // Presence per turn, not entity counts; kind rows never carry a provider.
            for (const k of kinds) _bump([orgKey, period, granularity, surface, 'kind', k, destination, '', protection].join('|'));
        }
        return true;
    } catch (_) {
        return false;
    }
}

async function _countTurnAsync(args) {
    const { orgKey, surface, userId, optOut, notice, outcome, categories, providerConfig, allowlistedHosts, dryRun } = args || {};
    if (dryRun) return;
    if (!V.SURFACES.includes(surface)) return;
    const key = typeof orgKey === 'string' && orgKey ? orgKey : 'default';
    const mon = await _resolver().resolveChatMonitoring(key);
    if (!mon || mon.state !== 'on' || !mon.surfaces.includes(surface)) return;
    if (typeof notice !== 'string' || notice !== `${surface}@${mon.version}`) return;
    if (optOut === true) return;
    if (!isAnonymousUserId(userId) && await _objections().isObjecting(userId)) return;
    recordChatTurn({ orgKey: key, surface, outcome, categories, providerConfig, allowlistedHosts, signals: mon.signals });
}

/**
 * Count one chat turn, if chat signals say so. Fire-and-forget: synchronous,
 * returns undefined, never throws, never awaited by the caller.
 *
 * @param {{ orgKey: string, surface: string, userId?: string|null, optOut?: boolean, notice?: string|null,
 *   outcome: string, categories?: string[], providerConfig?: { providerType?: string, url?: string }|null,
 *   allowlistedHosts?: string[], dryRun?: boolean }} args
 * @returns {undefined}
 */
function countTurn(args) {
    try {
        _countTurnAsync(args).catch(() => {});
    } catch (_) { /* never on the request path */ }
    return undefined;
}

/**
 * "Delete collected counts": drop the counts of one org that still wait in
 * this process (the map and a failed flush's retry), so the next flush cannot
 * write back what the admin just deleted. Other processes flush their own
 * pending minute; the retention purge removes those rows in time.
 * @param {string} orgKey
 * @returns {number} how many pending keys were dropped
 */
function discardOrg(orgKey) {
    if (typeof orgKey !== 'string' || !orgKey) return 0;
    const prefix = `${orgKey}|`;
    let n = 0;
    for (const m of [_map, _retry]) {
        if (!m) continue;
        for (const key of [...m.keys()]) {
            if (key.startsWith(prefix)) { m.delete(key); n++; }
        }
    }
    if (_retry && !_retry.size) _retry = null;
    return n;
}

/** Test-only: forget every pending count and timer. */
function _resetForTests() {
    if (_timer) clearTimeout(_timer);
    _timer = null;
    _map = new Map();
    _retry = null;
    _chain = null;
    _dropped = 0;
    _now = () => new Date();
}

/** Test-only: pin the clock the period is taken from. */
function _setNowForTests(fn) { _now = fn; }

/** Test-only: how many keys wait for the next flush. */
function _pendingKeys() { return _map.size + (_retry ? _retry.size : 0); }

module.exports = {
    countTurn,
    recordChatTurn,
    outcomeFromPiiReport,
    outcomeFromDlp,
    kindOf,
    normaliseProviderType,
    directOrgKey,
    agentTurnTarget,
    flush,
    discardOrg,
    MAX_KEYS,
    _resetForTests,
    _setNowForTests,
    _pendingKeys,
};
