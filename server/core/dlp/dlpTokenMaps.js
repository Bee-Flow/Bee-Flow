// @typecheck
const log = require('../../telemetry/log');
const { createTokenMapEviction, emitTokenMapEvent } = require('./tokenMapEviction');

// Conversation-scoped "remember my last choice" preference. Cleared on
// explicit conversation delete (and naturally GC'd in process restart).
const conversationDlpPrefs = new Map(); // conversationId → 'redact' | 'allow'

// Conversation-scoped accumulated token maps. The same conversation may redact
// across several turns; new entries are merged in so `restoreTokens` in the
// response path can still undo an earlier turn's token.
const conversationTokenMaps = new Map(); // conversationId → Map<token, original>

// One-shot "have we tried hydrating this conv from the DB yet" tracker. Once a
// SELECT has returned (whether it found a row or not), we skip the query on
// every subsequent `getConversationTokenMap` call. The in-process Map is the
// source of truth for the rest of the conversation's lifetime.
const _hydratedConversations = new Set();

let _hydrationInFlight = new Map(); // convId → Promise resolved when the SELECT lands

// Cap on distinct PII tokens accumulated per conversation. Raised from 500
// once tool RESULTS and KB chunks (not just the user message) started minting
// tokens: a single KB-heavy / multi-tool turn can add hundreds of result
// tokens, and front-first eviction at 500 would drop the user's turn-1
// `[email_1]` — silently breaking its restore on the response and on later
// tool args (BFSF-171 class bug). 2000 keeps that margin comfortable for any
// realistic conversation; eviction only triggers in pathological cases.
const MAX_TOKENS_PER_CONV = 2000;

// Notebook / legal-matter maps accumulate tokens from the document body, every
// retrieved KB chunk, AND the chat — a single dossier is exactly the worst case
// the 2000 cap was sized against. Give notebook-bound ids more headroom so a
// long-running matter doesn't front-evict its turn-1 tokens (which would leave a
// raw `[person_1]` un-restorable). Ids are auto-marked when their map is found in
// / written to the `notebooks` table (see _hydrateFromDb / _writeMapToDb).
const MAX_TOKENS_PER_NOTEBOOK = 5000;

const _notebookBoundIds = new Set();

function _capFor(conversationId) {
    return _notebookBoundIds.has(conversationId) ? MAX_TOKENS_PER_NOTEBOOK : MAX_TOKENS_PER_CONV;
}

function _ensureTokenMap(conversationId) {
    if (!conversationId) return new Map();
    eviction.touch(conversationId);
    let map = conversationTokenMaps.get(conversationId);
    if (!map) { map = new Map(); conversationTokenMaps.set(conversationId, map); }
    return map;
}

// Conversations for which we've already logged a "no matching row to persist
// into" warning, so the message fires at most once each (benign for
// notebook-scoped maps whose id is a notebookId — see _writeMapToDb).
const _persistWarned = new Set();

const eviction = createTokenMapEviction({
    conversationTokenMaps, hydrated: _hydratedConversations, notebookBound: _notebookBoundIds,
    persistWarned: _persistWarned, hydrationInFlight: () => _hydrationInFlight,
});

function _mergeIntoTokenMap(conversationId, incoming) {
    if (!conversationId || !incoming) return;
    const map = _ensureTokenMap(conversationId);
    eviction.markDirty(conversationId);
    for (const [token, original] of Object.entries(incoming)) {
        map.set(token, original);
    }
    // Cheap LRU-ish cap: trim from the insertion-order front if we exceed the cap.
    const cap = _capFor(conversationId);
    let evicted = 0;
    while (map.size > cap) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
        evicted++;
    }
    if (evicted > 0) {
        // Eviction means an earlier `[category_N]` can no longer be restored —
        // the user may be shown a raw placeholder, or a later tool arg that
        // references it can no longer be detokenised. Surface it instead of
        // silently dropping tokens (this was a silent correctness bug).
        log.warn(`[DlpRunner] token-map cap (${cap}) exceeded for conv ${conversationId}; evicted ${evicted} oldest token(s) — earlier placeholders may no longer restore`);
        emitTokenMapEvent(conversationId, 'token_evicted', { reason: `evicted ${evicted} at cap ${MAX_TOKENS_PER_CONV}` });
    }
}

// Lazy-load DB helpers so this file stays cheap to require in test contexts
// that don't touch persistence (the existing scanner tests, for example).
function _db() {
    return require('../../db');
}

const _ownerCache = new Map(); // conversationId -> { userId, table } | null

const OWNER_CACHE_MAX = 500;

function _ownerCacheSet(id, val) {
    if (_ownerCache.size >= OWNER_CACHE_MAX) {
        const oldest = _ownerCache.keys().next().value;
        if (oldest !== undefined) _ownerCache.delete(oldest);
    }
    _ownerCache.set(id, val);
}

/** Find which table owns this id and who the owner is. Cached. */
async function _resolveOwner(conversationId) {
    if (_ownerCache.has(conversationId)) return _ownerCache.get(conversationId);
    let found = null;
    try {
        const { getOne } = _db();
        for (const table of ['agent_conversations', 'direct_conversations', 'notebooks']) {
            const row = await getOne(`SELECT user_id FROM ${table} WHERE id = $1`, [conversationId]);
            if (row) { found = { userId: row.user_id, table }; break; }
        }
    } catch (_) {
        found = null;
    }
    _ownerCacheSet(conversationId, found);
    return found;
}

function _piiAad(conversationId) {
    return `bfpii:v1:${conversationId}`;
}

/**
 * Crypto context for this conversation's token map, or null to store plaintext.
 * Never throws — the shield must not be able to fail a chat turn.
 */
async function _tokenMapCrypto(conversationId) {
    try {
        const owner = await _resolveOwner(conversationId);
        if (!owner?.userId) return null;
        const { SURFACES, resolvePolicy, shouldEncrypt } = require('../../stores/encryptionPolicy');
        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(owner.userId);
        const policy = await resolvePolicy(user?.organizationId || null);
        if (!shouldEncrypt(policy, SURFACES.PII_TOKEN_MAP)) return null;

        // backgroundKey, never `key`. This runs from the DLP path with no
        // session in scope, so on `zk` the content key is always null — which
        // is why the token map, the one artefact that reverses the whole
        // Privacy Shield, could not be encrypted at all on the tier that
        // advertises the strongest protection. backgroundKey resolves through
        // the org escrow on both encrypting tiers.
        const { resolveCrypto } = require('../../stores/agent/messageCrypto');
        const ctx = await resolveCrypto({ userId: owner.userId, orgId: user?.organizationId || null });
        return ctx.backgroundKey ? { key: ctx.backgroundKey } : null;
    } catch (err) {
        log.warn(`[DlpRunner] token-map crypto unavailable for ${conversationId}: ${err.message}`);
        return null;
    }
}

async function _writeMapToDb(conversationId) {
    if (!conversationId) return;
    // Never overwrite the stored map with a partial one (merge after eviction).
    await _hydrateFromDb(conversationId);
    const map = conversationTokenMaps.get(conversationId);
    if (!map) return;
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    const markPersisted = eviction.beginWrite(conversationId); // the row then holds this snapshot
    let payload = JSON.stringify(obj);
    try {
        const crypt = await _tokenMapCrypto(conversationId);
        if (crypt) {
            const { encryptField } = require('../../stores/lib/fieldEnvelope');
            // asObject keeps the stored value a JSON object so the
            // `typeof === 'object'` hydration check still passes.
            payload = JSON.stringify(encryptField(payload, {
                key: crypt.key,
                aad: _piiAad(conversationId),
                encrypt: true,
                asObject: true,
            }));
        }
    } catch (err) {
        log.warn(`[DlpRunner] token-map encryption failed for ${conversationId}, storing plaintext: ${err.message}`);
    }
    try {
        const { run } = _db();
        // Try agent_conversations first; fall back to direct_conversations.
        const agentResult = await run(
            'UPDATE agent_conversations SET pii_token_map = $1::jsonb WHERE id = $2',
            [payload, conversationId],
        );
        if (agentResult?.rowCount > 0) { markPersisted(); return; }
        const directResult = await run(
            'UPDATE direct_conversations SET pii_token_map = $1::jsonb WHERE id = $2',
            [payload, conversationId],
        );
        if (directResult?.rowCount > 0) { markPersisted(); return; }
        // Notebook / legal-matter chat keys the map on the notebook id, which is
        // the `notebooks.id`. Persist there so the
        // doc/source/chat tokens survive a reload + restart (the "Part 2A" the
        // warning below anticipated). Plaintext JSONB, matching the two tables above.
        const notebookResult = await run(
            'UPDATE notebooks SET pii_token_map = $1::jsonb WHERE id = $2',
            [payload, conversationId],
        );
        if (notebookResult?.rowCount > 0) { _notebookBoundIds.add(conversationId); markPersisted(); return; }
        // Neither table had a matching row, so the map lives in-process ONLY and
        // a restart would lose it — the user would then see `[email_1]` forever.
        // Warn once per conversation (kept a warn, not a guardrail alert,
        // because notebook-scoped maps are keyed by a notebookId that legitimately
        // isn't a conversation row until Part 2A wires persistence).
        if (!_persistWarned.has(conversationId)) {
            _persistWarned.add(conversationId);
            log.warn(`[DlpRunner] token-map persist found no conversation row for ${conversationId} (${map.size} token(s) held in-process only)`);
        }
    } catch (err) {
        // A real DB error (not just "no row") — escalate to an operator-visible
        // guardrail event. Silent failure here is the #1 way a conversation
        // becomes permanently unrestorable.
        log.warn(`[DlpRunner] DB write-through failed for conv ${conversationId}: ${err.message}`);
        emitTokenMapEvent(conversationId, 'persist_failed', { reason: err.message });
    }
}

async function _hydrateFromDb(conversationId) {
    if (!conversationId || _hydratedConversations.has(conversationId)) return;
    eviction.touch(conversationId);
    if (_hydrationInFlight.has(conversationId)) {
        await _hydrationInFlight.get(conversationId);
        return;
    }
    const p = (async () => {
        try {
            const { getOne } = _db();
            let row = await getOne('SELECT pii_token_map FROM agent_conversations WHERE id = $1', [conversationId]);
            if (!row) row = await getOne('SELECT pii_token_map FROM direct_conversations WHERE id = $1', [conversationId]);
            if (!row) {
                // A notebook row always exists for a valid notebook (the legal
                // matter / notebook itself), even before any token is minted —
                // mark it bound so the higher per-notebook cap applies from turn 1.
                row = await getOne('SELECT pii_token_map FROM notebooks WHERE id = $1', [conversationId]);
                if (row) _notebookBoundIds.add(conversationId);
            }
            let stored = row?.pii_token_map;

            // Decrypt if — and only if — what is stored is an envelope. Driven
            // by the value, not by the current policy, so a map written while
            // encryption was on stays restorable after it is switched off, and
            // a plaintext map written before it was switched on needs no
            // migration. Same rule as every other encrypted surface.
            const { isEnvelope, decryptField } = require('../../stores/lib/fieldEnvelope');
            if (isEnvelope(stored)) {
                const crypt = await _tokenMapCrypto(conversationId);
                try {
                    const plain = decryptField(stored, {
                        key: crypt?.key || null,
                        aad: _piiAad(conversationId),
                    });
                    stored = JSON.parse(plain);
                } catch (err) {
                    // Loud: without the map every [email_N] in this conversation
                    // stays an opaque placeholder to the user. Leaving it silent
                    // would look like the shield simply had nothing to restore.
                    log.error(`[DlpRunner] token map for conv ${conversationId} could not be decrypted: ${err.message}`);
                    emitTokenMapEvent(conversationId, 'hydrate_decrypt_failed', { reason: err.message });
                    stored = null;
                }
            }

            if (stored && typeof stored === 'object') {
                // `node-postgres` parses JSONB into a plain object automatically.
                const entries = Object.entries(stored);
                if (entries.length > 0) {
                    const map = _ensureTokenMap(conversationId);
                    let added = 0;
                    for (const [k, v] of entries) {
                        if (!map.has(k)) { map.set(k, v); added++; }
                    }
                    if (added > 0) log.info(`[DlpRunner] Hydrated token map for conv ${conversationId} from DB (${added} tokens)`);
                }
            }
        } catch (err) {
            log.warn(`[DlpRunner] DB hydrate failed for conv ${conversationId}: ${err.message}`);
        } finally {
            _hydratedConversations.add(conversationId);
            _hydrationInFlight.delete(conversationId);
        }
    })();
    _hydrationInFlight.set(conversationId, p);
    await p;
}

/**
 * Returns the accumulated token map for a conversation as a plain object
 * (consumable by `restoreTokens`).
 *
 * Sync by default. If you need post-restart hydration (i.e. you are about to
 * render content for a user and want to handle the case where the in-process
 * map is empty), use `getConversationTokenMapAsync` instead.
 */
function getConversationTokenMap(conversationId) {
    const map = conversationTokenMaps.get(conversationId);
    if (!map) return {};
    eviction.touch(conversationId);
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    return obj;
}

/**
 * Async variant — hydrates from DB on the first call per process for a given
 * conversation. Use this on render paths where the conversation may have been
 * loaded after a server restart (workspace GET endpoint, reload routes).
 */
async function getConversationTokenMapAsync(conversationId) {
    if (!conversationId) return {};
    eviction.touch(conversationId);
    if (!_hydratedConversations.has(conversationId) && (!conversationTokenMaps.get(conversationId) || conversationTokenMaps.get(conversationId).size === 0)) {
        await _hydrateFromDb(conversationId);
    }
    return getConversationTokenMap(conversationId);
}

/**
 * Drop everything held for a conversation. With `ephemeral`, the scope was a
 * per-run one (see `scan`) that never had a row, so there is nothing in the
 * database to clear either.
 * @param {string} conversationId
 * @param {{ ephemeral?: boolean }} [opts]
 */
function clearConversationState(conversationId, { ephemeral = false } = {}) {
    if (!conversationId) return;
    conversationDlpPrefs.delete(conversationId);
    conversationTokenMaps.delete(conversationId);
    _hydratedConversations.delete(conversationId);
    _persistWarned.delete(conversationId);
    _ownerCache.delete(conversationId);
    eviction.forget(conversationId);
    if (ephemeral) return;
    // Best-effort DB clear so a deleted-then-recreated conversation doesn't
    // inherit stale tokens. Fire-and-forget.
    (async () => {
        try {
            const { run } = _db();
            await run('UPDATE agent_conversations SET pii_token_map = NULL WHERE id = $1', [conversationId]);
            await run('UPDATE direct_conversations SET pii_token_map = NULL WHERE id = $1', [conversationId]);
            await run('UPDATE notebooks SET pii_token_map = NULL WHERE id = $1', [conversationId]);
        } catch (err) {
            log.warn(`[DlpRunner] DB clear failed for conv ${conversationId}: ${err.message}`);
        }
    })();
}

function setConversationPref(conversationId, choice) {
    if (!conversationId) return;
    if (choice === 'redact' || choice === 'allow') {
        conversationDlpPrefs.set(conversationId, choice);
    }
}

function getConversationPref(conversationId) {
    return conversationId ? conversationDlpPrefs.get(conversationId) || null : null;
}

/**
 * Idle-cleanup. Call periodically (the kbQueryCache GC already runs every 10 min;
 * we piggyback by exposing this and letting that file call us).
 */
function gc() {
    // Idle eviction is tracked per conversation (see sweepIdle); explicit
    // deletes still go through clearConversationState().
    eviction.sweepIdle();
}

module.exports = { eviction, _mergeIntoTokenMap, _resolveOwner, _writeMapToDb, _hydrateFromDb, getConversationTokenMap, getConversationTokenMapAsync, clearConversationState, setConversationPref, getConversationPref, gc };
