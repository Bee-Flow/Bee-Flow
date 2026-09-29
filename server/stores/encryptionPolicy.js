// @typecheck
/**
 * Content-encryption policy — the single answer to "should this surface be
 * encrypted for this org, right now?"
 *
 * ── The rule that makes deploys and toggles safe ────────────────────────────
 *
 * WRITE paths consult this module. READ paths never do — they detect the
 * on-disk format of the value in front of them (see isEnvelope()). That
 * asymmetry is the whole design:
 *
 *   • Upgrading to this build changes nothing. Every org defaults to 'none',
 *     so writes stay plaintext and reads keep reading plaintext.
 *   • Turning encryption ON leaves every existing plaintext row readable;
 *     only new writes are ciphertext.
 *   • Turning encryption OFF leaves every existing ciphertext row readable
 *     (the key material is untouched); only new writes are plaintext.
 *   • Turning ONE SURFACE off does the same for just that surface.
 *
 * There is deliberately no "mode says encrypted, so assume the bytes are
 * encrypted" branch anywhere. A mode-dependent read is how a config flip
 * turns into permanent data loss.
 *
 * ── Tiers ───────────────────────────────────────────────────────────────────
 *
 *   none     no content encryption (default; what every install gets on upgrade)
 *   managed  per-user DEK, escrowed to a per-org root key so an admin can
 *            reset a password without destroying the user's data
 *   zk       per-user DEK wrapped only by the user's own secret; nobody can
 *            recover it for them
 *
 * ── Scope (partial enablement) ──────────────────────────────────────────────
 *
 * `encryption_scope` is an optional JSON object of per-surface booleans. Absent
 * or null means "every surface this tier supports". Set a surface to false to
 * leave it in plaintext while the rest is encrypted, e.g. to keep SQL search
 * over message bodies working while still protecting the PII map:
 *
 *   { "messages": false, "piiTokenMap": true }
 */

const SURFACES = Object.freeze({
    /** conversation_messages.content — the message bodies */
    MESSAGES: 'messages',
    /** conversation_messages.meta_json — carries the attachment sidecars
     *  (storageKey / extractedText), so this is document content, not metadata */
    MESSAGE_META: 'messageMeta',
    /** agent_conversations.meta_json / direct_conversations.meta_json —
     *  holds the LLM compaction summary, a précis of the whole conversation */
    CONVERSATION_META: 'conversationMeta',
    /** pii_token_map — the Privacy Shield token → real-PII dictionary */
    PII_TOKEN_MAP: 'piiTokenMap',
    /** agent_conversations.title / direct_conversations.title — LLM-generated
     *  from the first user message, so usually a précis of it */
    CONVERSATION_TITLE: 'conversationTitle',
    /** notebook_conversations.messages_json — notebook / legal-matter chat */
    NOTEBOOK_MESSAGES: 'notebookMessages',
    /** transcriptions.full_text / transcript / segments / speakers / summary and
     *  the derived lists — a verbatim record of what people said in a meeting,
     *  including everyone who was in the room. Keyed to the ORG, not to a user:
     *  a transcription is shareable (`shared_with`, `is_published`) and the
     *  summary/insight jobs read it with no session in scope. Same trade as
     *  PROJECT_SHARED_MESSAGES in stores/agent/messageCrypto.js, and the same
     *  honest label: on `zk` this surface is readable by the server operator. */
    TRANSCRIPTS: 'transcripts',
});

// NOTE — the per-user tokenization vault (pii_vault_entries) is deliberately
// NOT a surface here. Every surface above is a toggle an admin can turn off,
// and the vault is a long-lived accumulation of raw PII across all of a user's
// conversations: offering an "off" switch for it would be offering a switch
// that makes things worse, with no upside (nothing searches it in SQL). It is
// encrypted whenever a key can be resolved, on every tier, and
// stores/piiVaultStore.js owns that rule.

const ALL_SURFACES = Object.freeze(Object.values(SURFACES));

/**
 * Surfaces whose store actually honours the policy today.
 *
 * The other names above are defined because they are the known plaintext
 * surfaces we intend to cover, but their stores are not wired yet. Listing
 * them without this distinction would let an admin switch on a surface and
 * believe data was being protected when it was not — a silently inert
 * security control is worse than an absent one.
 *
 * Move a name into this set in the same change that wires its store.
 */
const IMPLEMENTED_SURFACES = Object.freeze([
    SURFACES.MESSAGES,
    SURFACES.MESSAGE_META,
    SURFACES.PII_TOKEN_MAP,
    SURFACES.CONVERSATION_META,
    SURFACES.CONVERSATION_TITLE,
    SURFACES.NOTEBOOK_MESSAGES,
    // Wired in stores/transcriptCrypto.js + stores/transcriptionStore.js. It
    // covers full_text, transcript, summary, segments, speakers, attendees and
    // chapters. action_items, decisions and questions are NOT covered — they
    // are merged in SQL on write, and that merge cannot run over an envelope.
    // The reason is written out in full at the top of transcriptCrypto.js;
    // this is a real remaining gap, deliberately visible rather than implied.
    SURFACES.TRANSCRIPTS,
]);

/** @param {string} surface @returns {boolean} */
function isSurfaceImplemented(surface) {
    return /** @type {readonly string[]} */ (IMPLEMENTED_SURFACES).includes(surface);
}
const TIERS = Object.freeze(['none', 'managed', 'zk']);

// Operators can change what a NEW org gets without touching code. Existing
// orgs are never affected by this — their column value already exists.
function defaultTier() {
    const t = String(process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER || 'none').trim();
    return TIERS.includes(t) ? t : 'none';
}

// Small TTL cache. Bounded and expiring on purpose — the existing per-user key
// cache in auth/connectorJwt.js grows without limit for the process lifetime,
// which is a leak we are not going to copy.
const _cache = new Map(); // orgKey -> { at, policy }
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;

function _cacheGet(key) {
    const hit = _cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
    return hit.policy;
}

function _cacheSet(key, policy) {
    if (_cache.size >= CACHE_MAX) {
        // Cheap eviction: drop the oldest inserted entry.
        const oldest = _cache.keys().next().value;
        if (oldest !== undefined) _cache.delete(oldest);
    }
    _cache.set(key, { at: Date.now(), policy });
}

function invalidatePolicyCache(orgId) {
    if (orgId === undefined) _cache.clear();
    else _cache.delete(String(orgId || ''));
}

function parseScope(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

/**
 * Build a policy object from raw column values. Pure — no I/O — so it is
 * directly unit-testable and usable by callers that already hold the org row.
 *
 * @param {{ encryption_tier?: string, encryption_scope?: string|object }} row
 * @returns {{ tier: string, enabled: boolean, scope: Record<string, boolean> }}
 */
function policyFromRow(row) {
    const rawTier = String(row?.encryption_tier || 'none').trim();
    const tier = TIERS.includes(rawTier) ? rawTier : 'none';
    const enabled = tier !== 'none';

    const declared = parseScope(row?.encryption_scope);
    /** @type {Record<string, boolean>} */
    const scope = {};
    for (const s of ALL_SURFACES) {
        // Absent scope = every surface on. An explicitly false surface is off.
        // Anything not a strict boolean is treated as "on" so a malformed
        // value fails toward protecting data rather than silently exposing it.
        scope[s] = enabled && (declared ? declared[s] !== false : true);
    }
    return { tier, enabled, scope };
}

const DISABLED_POLICY = Object.freeze(policyFromRow(null));

/**
 * Resolve the effective policy for an organisation.
 *
 * Fails safe in every direction: an unknown org, a missing column (mid-deploy,
 * before initDB has run the ALTER), or any DB error yields the disabled
 * policy, which means "write plaintext". It never throws — an encryption
 * policy lookup must not be able to take down a chat request.
 *
 * @param {string|null} orgId
 * @returns {Promise<{ tier: string, enabled: boolean, scope: Record<string, boolean> }>}
 */
async function resolvePolicy(orgId) {
    const key = String(orgId || '');
    const cached = _cacheGet(key);
    if (cached) return cached;

    let policy = DISABLED_POLICY;
    if (key) {
        try {
            const { getOne } = require('../db');
            const row = await getOne(
                'SELECT "encryption_tier", "encryption_scope" FROM organizations WHERE id = $1',
                [key]
            );
            if (row) policy = policyFromRow(row);
        } catch (_) {
            // Column or table not there yet, or the DB is unreachable. Either
            // way: behave exactly like today.
            policy = DISABLED_POLICY;
        }
    }
    _cacheSet(key, policy);
    return policy;
}

/**
 * @param {{ scope?: Record<string, boolean> }} policy
 * @param {string} surface - one of SURFACES
 * @returns {boolean}
 */
function shouldEncrypt(policy, surface) {
    return !!(policy && policy.scope && policy.scope[surface] === true);
}

module.exports = {
    SURFACES,
    ALL_SURFACES,
    IMPLEMENTED_SURFACES,
    isSurfaceImplemented,
    TIERS,
    defaultTier,
    policyFromRow,
    resolvePolicy,
    shouldEncrypt,
    invalidatePolicyCache,
    DISABLED_POLICY,
};
