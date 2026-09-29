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
 *   2. master switch OFF         → read ✗  write ✗   (beats everything below)
 *   3. agent.embed_enabled       → read ✗  write ✗   (pre-existing behaviour)
 *   4. per-chat pause            → read ✓  write ✗   (Brain toggle: writes only)
 *   5. moderation / guardrail    → read ✓  write ✗   (pre-existing behaviour)
 *   6. otherwise                 → read ✓  write ✓
 *
 * Rule 4 is deliberately weaker than rule 2. The composer toggle is documented
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

/**
 * Resolve read/write for one turn.
 *
 * @param {object}  opts
 * @param {string}  opts.userId
 * @param {boolean} [opts.perChatWriteEnabled]  the composer Brain toggle; only `false` means paused
 * @param {object}  [opts.agent]                agent row, for `embed_enabled`
 * @param {boolean} [opts.blocked]              moderation / guardrail violation this turn
 * @returns {Promise<{read: boolean, write: boolean, reason: string}>}
 */
async function resolveMemoryPolicy({ userId, perChatWriteEnabled, agent, blocked } = {}) {
    if (isAnonymousUserId(userId)) {
        return { read: false, write: false, reason: 'anonymous' };
    }
    if (!(await isMemoryEnabledForUser(userId))) {
        return { read: false, write: false, reason: 'user_disabled' };
    }
    if (agent?.embed_enabled) {
        return { read: false, write: false, reason: 'embed_agent' };
    }
    if (perChatWriteEnabled === false) {
        return { read: true, write: false, reason: 'chat_paused' };
    }
    if (blocked) {
        return { read: true, write: false, reason: 'blocked' };
    }
    return { read: true, write: true, reason: 'enabled' };
}

module.exports = {
    memoryEnabledKey,
    isAnonymousUserId,
    isMemoryEnabledForUser,
    resolveMemoryPolicy,
};
