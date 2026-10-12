/**
 * memoryPolicy — the single place that answers "may this turn read memory, and
 * may it write memory?".
 *
 * Before this module the answer was derived independently at four call sites,
 * and they disagreed. `memoryWriteEnabled` (the composer's Brain toggle) was
 * consulted only at the two EXTRACTION sites, never at the two RETRIEVAL sites,
 * so pausing memory stopped new memories being saved while every existing one
 * was still injected into every system prompt. There was no user-level switch
 * at all — no config key, no licence feature, nothing.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 * Evaluated in this order. Write it down here because it is the part that gets
 * re-derived wrongly by the next person to touch a call site.
 *
 *   1. anonymous user            → read ✗  write ✗   (never touches configStore)
 *   2. org memory disabled       → read ✗  write ✗   (reason org_disabled; beats the user)
 *   3. user master switch OFF    → read ✗  write ✗
 *   4. agent.embed_enabled       → read ✗  write ✗   (pre-existing behaviour)
 *   5. per-chat memory OFF       → read ✗  write ✗   (reason chat_off)
 *   6. per-chat saving paused    → read ✓  write ✗   (Brain toggle: writes only)
 *   7. moderation / guardrail    → read ✓  write ✗   (pre-existing behaviour)
 *   8. otherwise                 → read ✓  write ✓
 *
 * Rule 6 is deliberately weaker than rule 3. The composer toggle is documented
 * to the user as "Memory saving paused" and is a per-chat, per-device control;
 * the Settings switch is the account-wide kill switch and turns memory inert.
 *
 * ── What is NOT a master switch ─────────────────────────────────────────────
 * `agent.config.memoryEnabled` and `agent.config.useGeneralMemory` decide WHICH
 * bucket an agent's memories are routed to, and project `extractMemories`
 * decides whether a project id is attached to a write. Both are scope, not
 * enablement, and both only apply once `read`/`write` are already true. They
 * stay exactly where they are.
 *
 * Note the name collision: the wire/UI field for the user switch is
 * `memoryEnabled`, and so is the *unrelated* agent config flag. The resolver
 * here is deliberately named `isMemoryEnabledForUser` so a grep stays useful.
 */

const configStore = require('../../stores/configStore');
// Re-exported below so callers have one import for the whole policy. It lives
// in utils/ because memoryStore (platform) needs it too, and platform must not
// require core — see server/layering.test.js.
const { isAnonymousUserId } = require('../../utils/anonymousUser');
const log = require('../../telemetry/log');

// ── Org layer ───────────────────────────────────────────────────────
const ORG_DEFAULTS = Object.freeze({
    enabled: true,
    sensitiveOptInAllowed: false,
    maxPerUser: 1000,
});
const MAX_PER_USER_MIN = 50;
const MAX_PER_USER_MAX = 10000;

/** Config key holding the org memory settings. */
function orgMemoryKey(orgId) { return `org_memory_${orgId}`; }

function asMaxPerUser(v) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return ORG_DEFAULTS.maxPerUser;
    return Math.min(MAX_PER_USER_MAX, Math.max(MAX_PER_USER_MIN, n));
}

/** Sanitise a stored doc into the three known fields; anything else is dropped. */
function sanitizeOrgMemory(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};
    return {
        enabled: d.enabled !== false,
        sensitiveOptInAllowed: d.sensitiveOptInAllowed === true,
        maxPerUser: d.maxPerUser === undefined || d.maxPerUser === null
            ? ORG_DEFAULTS.maxPerUser : asMaxPerUser(d.maxPerUser),
    };
}

/**
 * The org-settings accessors over a config store. `configStore` below is the
 * real one; routes/orgMemory.test.js builds them over an in-memory store.
 */
function createOrgMemorySettings(store) {
    /** Effective org settings; defaults when the org has never saved any. */
    async function getOrgMemorySettings(orgId) {
        if (!orgId) return { ...ORG_DEFAULTS };
        return sanitizeOrgMemory(await store.getConfig(orgMemoryKey(orgId)));
    }

    /** Merge a partial patch onto the stored settings and persist. */
    async function setOrgMemorySettings(orgId, patch = {}) {
        const current = await getOrgMemorySettings(orgId);
        const next = sanitizeOrgMemory({ ...current, ...patch });
        await store.setConfig(orgMemoryKey(orgId), next);
        return next;
    }

    return { getOrgMemorySettings, setOrgMemorySettings };
}

const { getOrgMemorySettings, setOrgMemorySettings } = createOrgMemorySettings(configStore);

/** Fail open on a config outage, like the per-user switch. */
async function isMemoryEnabledForOrg(orgId) {
    if (!orgId) return true;
    try {
        return (await getOrgMemorySettings(orgId)).enabled;
    } catch (err) {
        log.warn('[memoryPolicy] org config read failed, defaulting to enabled:', err.message);
        return true;
    }
}

/** Config key holding the per-user master switch. */
function memoryEnabledKey(userId) {
    return `memory_enabled_user_${userId}`;
}

/**
 * The per-user master switch.
 *
 * NOTE THE DEFAULT. Memory is ON unless explicitly turned off, so this reads
 * `!== false`. `configStore.getConfig` returns null for an absent key, and the
 * neighbouring `simpleMode` preference reads `!!value` — copying that here
 * would silently disable memory for every existing user on deploy.
 */
async function isMemoryEnabledForUser(userId) {
    if (isAnonymousUserId(userId)) return false;
    try {
        return (await configStore.getConfig(memoryEnabledKey(userId))) !== false;
    } catch (err) {
        // A config outage must not silently wipe everyone's memory. Fail open:
        // the switch defaults to on, so on-error means on.
        log.warn('[memoryPolicy] config read failed, defaulting to enabled:', err.message);
        return true;
    }
}

/** Config key holding the per-user sensitive-data (art. 9) opt-in. */
function memorySensitiveOptInKey(userId) {
    return `memory_sensitive_opt_in_user_${userId}`;
}

/**
 * Sensitive memories may be stored only when the user opted in AND the org
 * allows it. Fails closed: any error, anonymous user or missing key means no.
 */
async function isSensitiveOptInForUser(userId, orgId) {
    if (!userId || isAnonymousUserId(userId)) return false;
    try {
        if ((await configStore.getConfig(memorySensitiveOptInKey(userId))) !== true) return false;
        return (await getOrgMemorySettings(orgId)).sensitiveOptInAllowed === true;
    } catch (err) {
        log.warn('[memoryPolicy] sensitive opt-in read failed, defaulting to off:', err.message);
        return false;
    }
}

/**
 * Resolve read/write for one turn.
 *
 * @param {object}  opts
 * @param {string}  opts.userId
 * @param {string}  [opts.orgId]               org of the user, for the org-level switch
 * @param {boolean} [opts.perChatReadEnabled]   per-chat memory off; only `false` blocks read and write
 * @param {boolean} [opts.perChatWriteEnabled]  the composer Brain toggle; only `false` means paused
 * @param {object}  [opts.agent]                agent row, for `embed_enabled`
 * @param {boolean} [opts.blocked]              moderation / guardrail violation this turn
 * @returns {Promise<{read: boolean, write: boolean, reason: string, sensitive: boolean}>}
 *   `sensitive`: art. 9 memories may be READ this turn (user opted in AND org allows it).
 *   Resolved only when read is true, so a switched-off turn costs no extra config read.
 */
async function resolveMemoryPolicy({ userId, orgId, perChatReadEnabled, perChatWriteEnabled, agent, blocked } = {}) {
    if (isAnonymousUserId(userId)) {
        return { read: false, write: false, reason: 'anonymous', sensitive: false };
    }
    if (!(await isMemoryEnabledForOrg(orgId))) {
        return { read: false, write: false, reason: 'org_disabled', sensitive: false };
    }
    if (!(await isMemoryEnabledForUser(userId))) {
        return { read: false, write: false, reason: 'user_disabled', sensitive: false };
    }
    if (agent?.embed_enabled) {
        return { read: false, write: false, reason: 'embed_agent', sensitive: false };
    }
    if (perChatReadEnabled === false) {
        return { read: false, write: false, reason: 'chat_off', sensitive: false };
    }
    if (perChatWriteEnabled === false) {
        return { read: true, write: false, reason: 'chat_paused', sensitive: await isSensitiveOptInForUser(userId, orgId) };
    }
    if (blocked) {
        return { read: true, write: false, reason: 'blocked', sensitive: await isSensitiveOptInForUser(userId, orgId) };
    }
    return { read: true, write: true, reason: 'enabled', sensitive: await isSensitiveOptInForUser(userId, orgId) };
}

module.exports = {
    memoryEnabledKey,
    memorySensitiveOptInKey,
    isSensitiveOptInForUser,
    isAnonymousUserId,
    isMemoryEnabledForUser,
    resolveMemoryPolicy,
    orgMemoryKey,
    ORG_DEFAULTS,
    createOrgMemorySettings,
    getOrgMemorySettings,
    setOrgMemorySettings,
    isMemoryEnabledForOrg,
};
