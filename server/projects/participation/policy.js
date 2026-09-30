// @typecheck
/**
 * Who allows the AI to take part in a conversation on its own, and how much.
 *
 * Two switches sit above a chat's own `auto` mode, and the first "no" wins:
 *
 *   1. The ORGANISATION's policy, `org_ai_participation_<orgId>` in
 *      configStore. Whether `auto` (and `always`) may be used at all, how
 *      eager the relevance gate is, and the count caps that bound it. The
 *      organisation is the PROJECT's, not the poster's: a project follows the
 *      rules of the organisation that holds it.
 *   2. The AUTHOR's own choice, `user_ai_participation_<userId>`:
 *      `{ autoJoinOnMyMessages: false }` means that person's messages never
 *      start the relevance gate or the "unanswered question" timer. It does
 *      not remove their messages from the context of an answer someone else
 *      asked for (mention mode already includes them).
 *
 * Both are read on the post path and by the background job, so each answer is
 * memoised for CACHE_TTL_MS (the pattern of core/llm/contextPolicy.js); a save
 * through routes/aiParticipation.js drops the memo at once.
 *
 * ── Unknown narrows ─────────────────────────────────────────────────────────
 *
 * A policy that cannot be read is NOT the default: it is "the AI does not join
 * on its own" (autoAllowed false), and a preference that cannot be read counts
 * as an opt-out. Neither failure is memoised, so the next read tries again.
 * Explicit requests (@ai, "Ask AI") never depend on this module.
 *
 * Every number is clamped into a range on read and on save, so a hand-edited
 * row can never switch the caps off.
 */

'use strict';

const log = require('../../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_ai_participation_';
const USER_KEY_PREFIX = 'user_ai_participation_';
const CACHE_TTL_MS = 30_000;

const SENSITIVITIES = Object.freeze(['conservative', 'balanced', 'eager']);

/** The gate's confidence threshold per sensitivity. */
const THRESHOLDS = Object.freeze({ conservative: 0.85, balanced: 0.75, eager: 0.6 });

/** [min, max] per tunable. The defaults below sit inside each range. */
const RANGES = Object.freeze({
    cooldownMinutes: [1, 240],
    maxAutoPerChatHour: [1, 30],
    maxAutoPerProjectDay: [1, 500],
    maxGatesPerChatHour: [1, 120],
    maxGatesPerOrgDay: [10, 50_000],
    quietSeconds: [15, 900],
    maxDebounceSeconds: [30, 3600],
    unansweredMinutes: [2, 1440],
    commentUnansweredMinutes: [5, 2880],
});

/**
 * The product default for an organisation that never saved a policy.
 * `autoAllowed: true` because `always` already sends every message and `auto`
 * sends strictly less; a chat itself still starts in `mention`. An operator
 * can flip the default for every org with BEEFLOW_AI_AUTO_DEFAULT=0.
 */
const DEFAULT_ORG_POLICY = Object.freeze({
    autoAllowed: true,
    alwaysAllowed: true,
    commentsAutoAllowed: true,
    sensitivity: 'balanced',
    cooldownMinutes: 3,
    maxAutoPerChatHour: 4,
    maxAutoPerProjectDay: 30,
    maxGatesPerChatHour: 12,
    maxGatesPerOrgDay: 500,
    quietSeconds: 45,
    maxDebounceSeconds: 180,
    unansweredMinutes: 10,
    commentUnansweredMinutes: 30,
});

const DEFAULT_USER_PREFERENCE = Object.freeze({ autoJoinOnMyMessages: true });

/** @param {Record<string, string|undefined>} env */
function envDefaultAutoAllowed(env) {
    const raw = String(env.BEEFLOW_AI_AUTO_DEFAULT ?? '').trim().toLowerCase();
    if (!raw) return DEFAULT_ORG_POLICY.autoAllowed;
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** @param {any} v @param {number} fallback @param {readonly number[]} range */
function clampInt(v, fallback, range) {
    const [min, max] = range;
    // Number(null) and Number('') are 0: an absent value is the default, not the minimum.
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * A complete policy from a stored blob (or nothing). Unknown keys are dropped.
 *
 * @param {any} stored
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 */
function normalizeOrgPolicy(stored, { env = process.env } = {}) {
    const src = stored && typeof stored === 'object' ? stored : {};
    const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
    /** @type {Record<string, any>} */
    const out = {
        autoAllowed: bool(src.autoAllowed, envDefaultAutoAllowed(env)),
        alwaysAllowed: bool(src.alwaysAllowed, DEFAULT_ORG_POLICY.alwaysAllowed),
        commentsAutoAllowed: bool(src.commentsAutoAllowed, DEFAULT_ORG_POLICY.commentsAutoAllowed),
        sensitivity: SENSITIVITIES.includes(src.sensitivity) ? src.sensitivity : DEFAULT_ORG_POLICY.sensitivity,
    };
    for (const [key, range] of Object.entries(RANGES)) out[key] = clampInt(src[key], DEFAULT_ORG_POLICY[key], range);
    // The debounce ceiling can never be shorter than one quiet period.
    if (out.maxDebounceSeconds < out.quietSeconds) out.maxDebounceSeconds = out.quietSeconds;
    return /** @type {typeof DEFAULT_ORG_POLICY} */ (out);
}

/** @param {any} stored */
function normalizeUserPreference(stored) {
    const src = stored && typeof stored === 'object' ? stored : {};
    return {
        autoJoinOnMyMessages: typeof src.autoJoinOnMyMessages === 'boolean'
            ? src.autoJoinOnMyMessages
            : DEFAULT_USER_PREFERENCE.autoJoinOnMyMessages,
    };
}

/** The gate's confidence threshold for a policy. */
function thresholdFor(policy) {
    return THRESHOLDS[policy?.sensitivity] ?? THRESHOLDS.balanced;
}

/**
 * May the AI take part on its own on this surface, by the org's policy?
 * @param {{ autoAllowed: boolean, commentsAutoAllowed: boolean }} policy
 * @param {'chat'|'comment'|string} surface
 */
function autoAllowedOn(policy, surface) {
    if (!policy || !policy.autoAllowed) return false;
    return surface === 'comment' ? !!policy.commentsAutoAllowed : true;
}

/**
 * @param {object} [deps]
 * @param {(key: string) => Promise<any>} [deps.getConfig]
 * @param {(key: string, value: any) => Promise<any>} [deps.setConfig]
 * @param {() => number} [deps.now]
 * @param {Record<string, string|undefined>} [deps.env]
 */
function makePolicy(deps = {}) {
    const getConfig = deps.getConfig || ((key) => require('../../stores/configStore').getConfig(key));
    const setConfig = deps.setConfig || ((key, value) => require('../../stores/configStore').setConfig(key, value));
    const now = deps.now || (() => Date.now());
    const env = deps.env || process.env;
    /** @type {Map<string, { at: number, value: any }>} */
    const orgCache = new Map();
    /** @type {Map<string, { at: number, value: any }>} */
    const userCache = new Map();

    const fresh = (cache, key) => {
        const hit = cache.get(key);
        return hit && now() - hit.at < CACHE_TTL_MS ? hit.value : undefined;
    };

    /**
     * The organisation's policy. An org id of null (a personal project) gets
     * the default. Never throws; a read failure narrows (see the header).
     *
     * @param {string|null|undefined} orgId
     */
    async function resolveOrgPolicy(orgId) {
        const key = orgId || '';
        const hit = fresh(orgCache, key);
        if (hit) return hit;
        let stored = null;
        if (orgId) {
            try {
                stored = await getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
            } catch (err) {
                log.warn(`[AiParticipation] policy of org ${orgId} unreadable, the AI does not join on its own: ${err && err.message}`);
                return { ...normalizeOrgPolicy(null, { env }), autoAllowed: false, commentsAutoAllowed: false, unavailable: true };
            }
        }
        const policy = normalizeOrgPolicy(stored, { env });
        orgCache.set(key, { at: now(), value: policy });
        return policy;
    }

    /** Whether the org ever saved a policy (for the settings screen). */
    async function isOrgPolicyConfigured(orgId) {
        if (!orgId) return false;
        return !!(await getConfig(`${CONFIG_KEY_PREFIX}${orgId}`));
    }

    /**
     * Save an organisation's policy. The caller authorised the change.
     * @param {string} orgId
     * @param {object} input
     * @param {{ updatedBy?: string|null }} [meta]
     */
    async function saveOrgPolicy(orgId, input, { updatedBy = null } = {}) {
        const policy = normalizeOrgPolicy(input, { env });
        await setConfig(`${CONFIG_KEY_PREFIX}${orgId}`, { ...policy, updatedAt: new Date(now()).toISOString(), updatedBy });
        orgCache.delete(orgId);
        return policy;
    }

    /**
     * One person's choice. Never throws; an unreadable preference is an opt-out.
     * @param {string|null|undefined} userId
     */
    async function resolveUserPreference(userId) {
        if (!userId) return { autoJoinOnMyMessages: false };
        const hit = fresh(userCache, userId);
        if (hit) return hit;
        let stored;
        try {
            stored = await getConfig(`${USER_KEY_PREFIX}${userId}`);
        } catch (err) {
            log.warn(`[AiParticipation] preference of user ${userId} unreadable, treated as an opt-out: ${err && err.message}`);
            return { autoJoinOnMyMessages: false, unavailable: true };
        }
        const pref = normalizeUserPreference(stored);
        userCache.set(userId, { at: now(), value: pref });
        return pref;
    }

    /** @param {string} userId @param {{ autoJoinOnMyMessages: boolean }} input */
    async function saveUserPreference(userId, input) {
        const pref = normalizeUserPreference(input);
        await setConfig(`${USER_KEY_PREFIX}${userId}`, { ...pref, updatedAt: new Date(now()).toISOString() });
        userCache.delete(userId);
        return pref;
    }

    return {
        resolveOrgPolicy,
        isOrgPolicyConfigured,
        saveOrgPolicy,
        invalidateOrgPolicy: (orgId) => orgCache.delete(orgId || ''),
        resolveUserPreference,
        saveUserPreference,
        invalidateUserPreference: (userId) => userCache.delete(userId),
    };
}

let shared = null;
/** One instance per process, so the settings routes and the engine share one cache. */
function defaultPolicy() {
    if (!shared) shared = makePolicy();
    return shared;
}

module.exports = {
    CONFIG_KEY_PREFIX,
    USER_KEY_PREFIX,
    CACHE_TTL_MS,
    SENSITIVITIES,
    THRESHOLDS,
    RANGES,
    DEFAULT_ORG_POLICY,
    DEFAULT_USER_PREFERENCE,
    normalizeOrgPolicy,
    normalizeUserPreference,
    thresholdFor,
    autoAllowedOn,
    makePolicy,
    defaultPolicy,
};
