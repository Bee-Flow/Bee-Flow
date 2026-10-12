/**
 * Chat signals: the effective state, one resolver for everything that
 * announces or counts.
 *
 * The recorder (core/privacy/chatSignals.js), the in-chat notice
 * (/api/privacy/shield-status), the agent and embed payloads and the checks
 * all read `resolveChatMonitoring(orgKey)`. One resolver is what keeps
 * "announced" and "counted" the same truth: a surface whose precondition
 * lapses is paused, and its counting and its notice stop together.
 *
 *   state  'on'         every condition holds and the start has passed
 *          'scheduled'  everything holds but the start is still ahead:
 *                       nothing is counted, the notice announces the date
 *          'off'        anything else (also on any read error)
 *
 * `on` needs ALL of: the compliance module active; the `compliance_hub_gdpr`
 * capability (the same as the /api/compliance mount, so a lapsed licence
 * stops counting within the memo window while the settings are kept);
 * chat_monitoring_enabled; 'outcomes' among the signals; no global code from
 * stores/lib/chatMonitoringRules.evaluate; at least one surface without
 * codes; and now >= chat_monitoring_effective_from. Surfaces with codes are
 * listed in `paused` and are neither counted nor announced.
 *
 * Shaped like coworkShieldFlag.js: never throws, a 30 s memo per org key,
 * single-flight on a miss, `invalidate(orgKey)` for the saving route. Platform
 * layer (layering.test.js PLATFORM_UNDER_CORE): it requires stores, stores/lib,
 * modules/index, telemetry and ./entitlements, and no other core module.
 */

'use strict';

const V = require('../../stores/lib/chatMonitoringVocab');
const rules = require('../../stores/lib/chatMonitoringRules');
const log = require('../../telemetry/log');

const CACHE_TTL_MS = 30_000;
const ERROR_TTL_MS = 5_000;
const ORGS_TTL_MS = 5 * 60_000;

const OFF = Object.freeze({
    state: 'off', version: null, from: null, surfaces: Object.freeze([]), paused: Object.freeze([]),
    signals: Object.freeze([]), noticeUrl: null, visitorNoticeUrl: null, retentionDays: V.RETENTION.default,
});

function defaultDeps() {
    return {
        isModuleActive: (id) => require('../../modules').isModuleActive(id),
        hasCapability: (capId, opts) => require('./entitlements').hasCapability(capId, opts),
        getSettings: (orgKey) => require('../../stores/complianceStore').getSettings(orgKey),
        getDpia: (orgKey) => require('../../stores/dpiaStore').getLatestForAgent(orgKey, V.CHAT_MONITORING_DPIA_KEY),
        hasAnyOrganization: () => require('../../stores/userStore').hasAnyOrganization(),
        now: () => Date.now(),
    };
}

/**
 * The effective state from what was read. Pure.
 * @param {{ settings: any, dpiaRow: any, installHasOrganisations: boolean, orgKey: string, now: number }} input
 */
function computeState({ settings, dpiaRow, installHasOrganisations, orgKey, now }) {
    const s = settings || {};
    if (s.chat_monitoring_enabled !== true) return OFF;
    const selectedSignals = Array.isArray(s.chat_monitoring_signals) ? s.chat_monitoring_signals : [];
    if (!selectedSignals.includes('outcomes')) return OFF;
    const ev = rules.evaluate(s, { dpiaRow, now: new Date(now), installHasOrganisations, orgKey, privacyNoticeUrl: s.privacy_notice_url });
    if (ev.global.length) return OFF;

    const selected = Array.isArray(s.chat_monitoring_surfaces) ? s.chat_monitoring_surfaces : [];
    const surfaces = [];
    const paused = [];
    for (const surface of V.PHASE.surfaces) {
        if (!selected.includes(surface)) continue;
        const missing = ev.bySurface[surface] || [];
        if (missing.length) paused.push(Object.freeze({ surface, missing: Object.freeze([...missing]) }));
        else surfaces.push(surface);
    }
    const version = rules.isoInstant(s.chat_monitoring_effective_from);
    if (!surfaces.length || !version) {
        return Object.freeze({ ...OFF, paused: Object.freeze(paused) });
    }
    const signals = ['outcomes', ...V.PHASE.signals.filter(x => x !== 'outcomes' && selectedSignals.includes(x))];
    const noticeUrl = rules.httpsUrl(s.chat_monitoring_notice_url);
    return Object.freeze({
        state: now >= Date.parse(version) ? 'on' : 'scheduled',
        version,
        from: version.slice(0, 10),
        surfaces: Object.freeze(surfaces),
        paused: Object.freeze(paused),
        signals: Object.freeze(signals),
        noticeUrl,
        visitorNoticeUrl: noticeUrl || rules.httpsUrl(s.privacy_notice_url),
        retentionDays: rules.clampedRetention(s),
    });
}

/**
 * A resolver over injectable reads (the default instance below reads the
 * real stores). Tests build their own.
 * @param {ReturnType<typeof defaultDeps>} deps
 * @param {{ ttlMs?: number, errorTtlMs?: number, orgsTtlMs?: number }} [opts]
 */
function makeResolver(deps, { ttlMs = CACHE_TTL_MS, errorTtlMs = ERROR_TTL_MS, orgsTtlMs = ORGS_TTL_MS } = {}) {
    const memo = new Map();      // orgKey -> { at, ttl, value }
    const inflight = new Map();  // orgKey -> Promise
    const generation = new Map(); // orgKey -> number, bumped by invalidate
    let orgs = null;             // { at, value }

    async function installHasOrganisations() {
        if (orgs && deps.now() - orgs.at < orgsTtlMs) return orgs.value;
        const value = !!(await deps.hasAnyOrganization());
        orgs = { at: deps.now(), value };
        return value;
    }

    async function read(orgKey) {
        if (!(await deps.isModuleActive('compliance'))) return OFF;
        const capable = await deps.hasCapability('compliance_hub_gdpr', { orgId: orgKey === 'default' ? null : orgKey });
        if (!capable) return OFF;
        const settings = await deps.getSettings(orgKey);
        if (!settings || settings.chat_monitoring_enabled !== true) return OFF;
        const [dpiaRow, hasOrgs] = await Promise.all([deps.getDpia(orgKey), installHasOrganisations()]);
        return computeState({ settings, dpiaRow, installHasOrganisations: hasOrgs, orgKey, now: deps.now() });
    }

    /**
     * @param {string|null|undefined} orgKey an org id, or 'default' for users without one
     * @returns {Promise<typeof OFF>}
     */
    async function resolveChatMonitoring(orgKey) {
        const key = typeof orgKey === 'string' && orgKey ? orgKey : 'default';
        const hit = memo.get(key);
        if (hit && deps.now() - hit.at < hit.ttl) return hit.value;
        if (inflight.has(key)) return inflight.get(key);
        const gen = generation.get(key) || 0;
        const p = (async () => {
            let value = OFF;
            let ttl = ttlMs;
            try {
                value = await read(key);
            } catch (e) {
                value = OFF;
                ttl = errorTtlMs;
                log.warn('[ChatMonitoringFlag] read failed; chat signals read as off:', e && e.code ? e.code : 'error');
            }
            if ((generation.get(key) || 0) === gen) memo.set(key, { at: deps.now(), ttl, value });
            return value;
        })().finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
        inflight.set(key, p);
        return p;
    }

    /** Forget the memo for an org key (the saving route, the DPIA hook). */
    function invalidate(orgKey) {
        const key = typeof orgKey === 'string' && orgKey ? orgKey : 'default';
        memo.delete(key);
        inflight.delete(key);
        generation.set(key, (generation.get(key) || 0) + 1);
    }

    function _resetForTests() {
        memo.clear();
        inflight.clear();
        generation.clear();
        orgs = null;
    }

    return { resolveChatMonitoring, invalidate, _resetForTests };
}

const _default = makeResolver(defaultDeps());

module.exports = {
    OFF,
    resolveChatMonitoring: _default.resolveChatMonitoring,
    invalidate: _default.invalidate,
    _resetForTests: _default._resetForTests,
    makeResolver,
    computeState,
};
