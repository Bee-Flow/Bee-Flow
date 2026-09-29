// @typecheck
/**
 * DLP (Data Loss Prevention) runner — the single entry point for scanning a
 * user's outbound prompt before it reaches an LLM.
 *
 * Combines two signal sources:
 *   - PII detection (`server/core/privacy/piiDetection.js`), which also runs
 *     the org's own data types ("Your own data", core/privacy/customTypes);
 *     they replaced the separate custom-terms scan that used to live here
 *   - Provider classification (external vs. internal)
 *
 * And turns them into a single *action*:
 *   - 'allow'   — send the prompt as-is
 *   - 'redact'  — tokenise findings, send the tokenised text, keep a tokenMap
 *   - 'block'   — refuse the turn, surface an error to the user
 *   - 'ask'     — pause the stream, show the user a preview, wait for their choice
 *
 * The runner never throws for "PII found" the way the old flow does. Instead
 * the caller inspects `action` and drives the UX accordingly. This keeps the
 * interactive path and the auto path in the same function.
 */

const { detectPii, tokenizeText } = require('../privacy/piiDetection');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { buildAllowMatcher, filterAllowedEntities } = require('./allowTerms');
const { classifyProvider } = require('../providers/classification');
const log = require('../../telemetry/log');

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
    let map = conversationTokenMaps.get(conversationId);
    if (!map) { map = new Map(); conversationTokenMaps.set(conversationId, map); }
    return map;
}

// Conversations for which we've already logged a "no matching row to persist
// into" warning, so the message fires at most once each (benign for
// notebook-scoped maps whose id is a notebookId — see _writeMapToDb).
const _persistWarned = new Set();

// Lazily emit an operator-facing guardrail event for token-map persistence /
// eviction problems. Lazy-required so the common (no-error) path never pulls in
// the store — that keeps the persistence unit tests (which mock `../../db`)
// clean, and never lets telemetry break the chat path.
function _emitTokenMapEvent(conversationId, action_taken, extra = {}) {
    try {
        const store = require('../../stores/guardrailEventStore');
        store.logGuardrailEvent({
            conversation_id: conversationId,
            violation_type: 'pii_tokenmap',
            action_taken,
            source: 'pii',
            violation_categories: extra.reason ? String(extra.reason).slice(0, 200) : null,
        }).catch(() => {});
    } catch (_) { /* never let telemetry break the chat path */ }
}

function _mergeIntoTokenMap(conversationId, incoming) {
    if (!conversationId || !incoming) return;
    const map = _ensureTokenMap(conversationId);
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
        _emitTokenMapEvent(conversationId, 'token_evicted', { reason: `evicted ${evicted} at cap ${MAX_TOKENS_PER_CONV}` });
    }
}

// ─── DB persistence (write-through + hydrate) ───────────────────────
// Without this, the in-process Map at line 32 is lost on every server
// restart. Persisted content (Notebook, saved messages) that still contains
// `[person_N]` placeholders would then be unredeemable forever. Persisting
// the token map alongside the conversation row makes restore-on-reload
// possible. See plan: token round-trip beyond the chat message.

// Lazy-load DB helpers so this file stays cheap to require in test contexts
// that don't touch persistence (the existing scanner tests, for example).
function _db() {
    return require('../../db');
}

// ── Token-map encryption ────────────────────────────────────────────────────
// The token map is the reverse dictionary for the Privacy Shield: it maps
// [email_1] back to the real address. In other words it holds precisely the PII
// that was stripped out of the message — and it sat in plaintext JSONB on the
// SAME ROW as the (supposedly) encrypted conversation. Encrypting the messages
// while leaving this readable protects nothing.
//
// The envelope must stay a JSON OBJECT. _hydrateFromDb branches on
// `typeof stored === 'object'` (node-postgres parses JSONB for us); a bare
// ciphertext string would fall through that check silently — no error, no log —
// and every [email_N] placeholder in stored messages would become permanently
// unresolvable. That is why fieldEnvelope has an `asObject` mode.

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
    const map = conversationTokenMaps.get(conversationId);
    if (!map) return;
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
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
        if (agentResult?.rowCount > 0) return;
        const directResult = await run(
            'UPDATE direct_conversations SET pii_token_map = $1::jsonb WHERE id = $2',
            [payload, conversationId],
        );
        if (directResult?.rowCount > 0) return;
        // Notebook / legal-matter chat keys the map on the notebook id, which is
        // the `notebooks.id`. Persist there so the
        // doc/source/chat tokens survive a reload + restart (the "Part 2A" the
        // warning below anticipated). Plaintext JSONB, matching the two tables above.
        const notebookResult = await run(
            'UPDATE notebooks SET pii_token_map = $1::jsonb WHERE id = $2',
            [payload, conversationId],
        );
        if (notebookResult?.rowCount > 0) { _notebookBoundIds.add(conversationId); return; }
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
        _emitTokenMapEvent(conversationId, 'persist_failed', { reason: err.message });
    }
}

async function _hydrateFromDb(conversationId) {
    if (!conversationId || _hydratedConversations.has(conversationId)) return;
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
                    _emitTokenMapEvent(conversationId, 'hydrate_decrypt_failed', { reason: err.message });
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
    if (!_hydratedConversations.has(conversationId) && (!conversationTokenMaps.get(conversationId) || conversationTokenMaps.get(conversationId).size === 0)) {
        await _hydrateFromDb(conversationId);
    }
    return getConversationTokenMap(conversationId);
}

function clearConversationState(conversationId) {
    if (!conversationId) return;
    conversationDlpPrefs.delete(conversationId);
    conversationTokenMaps.delete(conversationId);
    _hydratedConversations.delete(conversationId);
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
function gc(maxIdleMs = 60 * 60 * 1000) {
    // In this implementation we don't track per-conversation last-access, so
    // we rely on explicit clears. This hook is reserved for future use — when
    // conversations are deleted, callers should call clearConversationState().
    void maxIdleMs;
}

/**
 * Normalise findings to a single shape:
 *   { category, label, offset, length, text, source, severity }
 *
 * An org's own data type keeps the shape its old custom-term findings had
 * (`source: 'custom'`, severity medium); its category is the type's id, which
 * is what the tokenizer turns into the admin's placeholder.
 */
function _normalisePiiEntities(entities) {
    if (!Array.isArray(entities)) return [];
    return entities.map(e => {
        const custom = isCustomTypeId(e.category);
        return {
            category: e.category || 'PII',
            label: e.label || e.category || 'PII',
            offset: typeof e.offset === 'number' ? e.offset : 0,
            length: e.length || (e.text ? e.text.length : 0),
            text: e.text || '',
            source: custom ? 'custom' : 'pii',
            severity: custom ? 'medium' : 'high',
            confidence: e.confidence,
        };
    });
}

/**
 * Build a tokenised version of `text` for a list of normalised findings.
 * Returns { tokenizedText, tokenMap, summary } where summary is a compact
 * `{ category → count }` for logging and the UI.
 */
async function _tokeniseAll(text, findings, conversationId = null) {
    // Pass the conversation's accumulated token map so counters continue across
    // turns and repeated values reuse their existing tokens. Without this,
    // turn 2's [email_1] would silently overwrite turn 1's mapping in the
    // merged conv map.
    const existing = conversationId ? getConversationTokenMap(conversationId) : null;

    // Union with the user's tokenization vault, so a value keeps the same token
    // across every conversation they have. The precedence rules live in the
    // store (buildSeed) because five other call sites need exactly the same
    // ones — a second copy here is how the two would drift apart.
    const userId = await _vaultUserFor(conversationId);
    const vault = require('../../stores/piiVaultStore');
    const { tokenMap: seeded, counterFloors } = await vault.buildSeed(userId, findings, existing);

    // `tokenizeText` from piiDetection expects entities with offset/length/category/text.
    // Our normalised findings already match that shape.
    const { tokenizedText, tokenMap, sweptEntities = [] } = tokenizeText(text, findings, seeded, { counterFloors });

    // Teach the vault what this turn used. Deliberately not awaited: a vault
    // write must never sit on the critical path of a chat turn, and the
    // conversation token map remains the authority for restoring THIS
    // conversation whether or not it lands.
    if (userId) {
        vault.recordTokens(userId, tokenMap)
            .catch(err => log.warn(`[DlpRunner] vault record failed: ${err.message}`));
    }

    // Count the mentions the tokenizer's name sweep replaced too (BFSF-269):
    // they were redacted, so a summary of the findings alone undercounts.
    const summary = [...findings, ...sweptEntities].reduce((acc, f) => {
        const key = f.label || f.category;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return { tokenizedText, tokenMap, summary };
}

/**
 * Which user's vault does this conversation belong to?
 *
 * Cached via _resolveOwner, and null-safe: a conversation id with no owner row
 * (a notebook-scoped map before its notebook exists) simply gets no vault.
 */
/**
 * Persist a token map to the owning user's vault. Fire-and-forget by design:
 * the conversation map is already updated and remains the authority for this
 * conversation, so a vault write must never delay or fail a chat turn.
 */
function _recordToVault(conversationId, tokenMap) {
    if (!conversationId || !tokenMap || Object.keys(tokenMap).length === 0) return;
    _vaultUserFor(conversationId)
        .then(userId => (userId
            ? require('../../stores/piiVaultStore').recordTokens(userId, tokenMap)
            : null))
        .catch(err => log.warn(`[DlpRunner] vault record failed for ${conversationId}: ${err.message}`));
}

async function _vaultUserFor(conversationId) {
    if (!conversationId) return null;
    try {
        const owner = await _resolveOwner(conversationId);
        return owner?.userId || null;
    } catch (_) {
        return null;
    }
}

/**
 * Extract the last user message's plain-text content from a messages array.
 */
function _extractLastUserText(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
            const text = m.content.find(b => b?.type === 'text');
            return text?.text || '';
        }
        return '';
    }
    return '';
}

/**
 * Start the PII half of a DLP scan early, without consuming the result.
 *
 * The chat path pays two sequential guard round trips before the first LLM
 * token: the memory-context scrub, then this scan. They scan DIFFERENT texts,
 * so one cannot serve the other — but they can OVERLAP. Calling this before
 * memory retrieval starts the guard scan of the user message; when scan()
 * later calls detectPii with the same (text, categories, threshold), the
 * single-flight table in piiDetection joins the in-flight request (or the
 * cache serves it), so the real scan pays ~nothing.
 *
 * Correct by construction rather than by a mutation guard: if guardrails
 * rewrite the message in between, scan() derives a DIFFERENT cache key and
 * simply performs a fresh scan — the pre-warm is discarded, never misapplied.
 * The waste of a discarded pre-warm is bounded by the one-window cap below.
 *
 * Deliberately duplicates scan()'s early-exit conditions INSIDE this module
 * (not in the caller) so the two derivations of "what will be scanned, with
 * which arguments" cannot drift apart.
 *
 * Fire-and-forget: never throws, never blocks, returns nothing.
 */
function preWarmPiiScan({ messages, orgShieldConfig, providerConfig }) {
    try {
        if (!orgShieldConfig?.dlpEnabled || !orgShieldConfig?.enabled) return;
        const provider = classifyProvider(providerConfig || {}, orgShieldConfig?.dlpAllowlistedHosts || []);
        const scope = orgShieldConfig.dlpScope || 'external';
        if (scope === 'external' && !provider.isExternal) return;
        const text = _extractLastUserText(messages);
        if (!text || text.length < 3) return;
        // One window max: past that the windowed path is multiple sequential
        // guard calls, too expensive to risk discarding on a guardrail rewrite.
        const { MAX_REQUEST_CHARS } = require('../privacy/piiDetection');
        if (text.length > MAX_REQUEST_CHARS) return;
        const piiCategories = Array.isArray(orgShieldConfig.piiDetectionCategories) && orgShieldConfig.piiDetectionCategories.length > 0
            ? orgShieldConfig.piiDetectionCategories
            : null;
        const piiThreshold = typeof orgShieldConfig.piiDetectionConfidenceThreshold === 'number'
            ? orgShieldConfig.piiDetectionConfidenceThreshold
            : undefined;
        detectPii(text, piiCategories, piiThreshold).catch(() => { /* the real scan reports */ });
    } catch (_) { /* pre-warming must never break the turn */ }
}

/**
 * Core entry point.
 *
 * @param {object} params
 * @param {Array}  params.messages            Full messages array (we scan the last user message)
 * @param {object} params.orgShieldConfig     Resolved config from `resolveOrgShield`
 * @param {string} [params.orgId]             Org ID (unused since custom terms moved into detectPii; callers still pass it)
 * @param {string} params.conversationId      Scope for the per-conversation remembered choice + tokenMap
 * @param {object} params.providerConfig      { providerType, url, displayName } for classification
 * @param {function} [params.onProgress]      Called per scanned window of a big paste
 *                                            ({ done, total, ... }); the caller renders it.
 * @param {boolean} [params.hasAttachments]  the turn also carries attachments
 * @returns {Promise<DlpResult>}
 *
 * @typedef {object} DlpResult
 * @property {'allow'|'redact'|'block'|'ask'} action
 * @property {Array}    findings
 * @property {object}   provider             { isExternal, reason, displayName }
 * @property {string|null} redactedText      Present when action is 'redact'
 * @property {object|null} tokenMap          Map<token, original> when action is 'redact'
 * @property {string}   scanStatus           'ok' | 'failed' | 'skipped'
 * @property {object}   summary              { label → count }
 * @property {string}   [reason]             why a block was chosen, when it was
 */
async function scan({ messages, orgShieldConfig, conversationId, providerConfig, onProgress, hasAttachments = false }) {
    const dlpEnabled = !!orgShieldConfig?.dlpEnabled;
    if (!dlpEnabled) {
        return { action: 'allow', findings: [], provider: { isExternal: false, reason: 'dlp_disabled' }, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    const provider = classifyProvider(providerConfig || {}, orgShieldConfig?.dlpAllowlistedHosts || []);
    const scope = orgShieldConfig.dlpScope || 'external';
    if (scope === 'external' && !provider.isExternal) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    const text = _extractLastUserText(messages);
    if (!text || text.length < 3) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    // detectPii() calls the PII Guard service (GLiNER) and runs the org's
    // own data types; when the guard isn't installed it returns null (or
    // `guardAbsent` with the org's own matches) — a scan failure, below.
    const piiEnabled = !!orgShieldConfig.enabled;
    const piiCategories = Array.isArray(orgShieldConfig.piiDetectionCategories) && orgShieldConfig.piiDetectionCategories.length > 0
        ? orgShieldConfig.piiDetectionCategories
        : null;
    const piiThreshold = typeof orgShieldConfig.piiDetectionConfidenceThreshold === 'number'
        ? orgShieldConfig.piiDetectionConfidenceThreshold
        : undefined;

    let piiResult = null;
    let piiFailed = false;
    let failReason = null;
    try {
        if (piiEnabled) {
            piiResult = await detectPii(text, piiCategories, piiThreshold, { onProgress });
            // detectPii no longer throws on guard errors — it returns a
            // degraded result (guard unreachable, or GLiNER model not ready
            // so only the regex tier answered). Treat that as a scan failure
            // so the fail-closed policy applies instead of trusting an
            // under-redacted result (BFSF-269).
            if (piiResult?.degraded) {
                // Does the degradation touch what THIS org asked for? Same
                // narrowing as validateInputForPii: the guard names WHICH
                // categories lost coverage when it can (a dead label group),
                // and an org scoped to {Email, PhoneNumber} must not be
                // blocked because the healthcare group died. Absent/empty
                // degradedCategories means "unknown — assume all" (older
                // guard, oversize partial scan) and keeps the strict path.
                const affected = piiResult.degradedCategories;
                const requested = Array.isArray(piiCategories) && piiCategories.length
                    ? piiCategories : null;
                if (affected && requested && !affected.some(c => requested.includes(c))) {
                    log.warn(`[DLP] PII scan DEGRADED (${piiResult.degradedReason || 'unknown'}) but only for [${affected.join(', ')}], none of which this org requested — continuing with the result`);
                } else {
                    piiFailed = true;
                    failReason = 'pii_unavailable';
                    log.warn('[DLP] PII scan DEGRADED:', piiResult.degradedReason || 'unknown');
                }
            } else if (piiResult === null || piiResult?.guardAbsent) {
                // NOT the same as "clean". detectPii returns null when the
                // guard is not installed at all, and this branch used to leave
                // piiFailed false — so an org with the shield enabled, DLP
                // enabled and fail_closed set shipped every message unmasked
                // and reported scanStatus 'ok'. "No detector" and "no PII" are
                // different answers and must not collapse into one.
                // `guardAbsent` is the same answer from a scan that also ran
                // the org's own words/patterns in Node: same failure, and its
                // findings are still used (fail_open redacts them).
                piiFailed = true;
                failReason = 'guard_not_installed';
                log.warn('[DLP] PII scan requested but the guard service is not installed — treating as a scan failure, not as "clean"');
            }
        }
    } catch (err) {
        piiFailed = true;
        failReason = 'pii_unavailable';
        log.warn('[DLP] PII scan failed:', err.message);
    }

    let piiEntities = piiResult?.hasPii ? _normalisePiiEntities(piiResult.entities) : [];
    // Never-redact layer: public organisations and the org's own allowlist.
    // Never applied to the org's own data types (allowTerms skips them): a
    // type is something the org deliberately asked to hide.
    if (piiEntities.length) {
        const allowMatcher = buildAllowMatcher(orgShieldConfig);
        const filtered = filterAllowedEntities(piiEntities, allowMatcher);
        if (filtered.allowed.length) {
            // Logged by CATEGORY and count, never by value — same privacy
            // contract as the guard's own log lines. But logged: a detection
            // that disappears without a trace is indistinguishable from a
            // detector that broke.
            const byCat = {};
            for (const e of filtered.allowed) byCat[e.category] = (byCat[e.category] || 0) + 1;
            log.info(`[DLP] allowlist kept ${filtered.allowed.length} span(s) unredacted:`,
                JSON.stringify(byCat));
        }
        piiEntities = filtered.entities;
    }
    // detectPii hands back disjoint spans (built-in and custom merged by one
    // rule), so this is only the tail-first order the splice needs.
    const all = [...piiEntities].sort((a, b) => b.offset - a.offset);

    // Handle scan failure / degradation per org policy. `piiFailureMode` is
    // the unified key (shared with the legacy PII path in piiDetection.js);
    // `dlpFailureMode` is kept as a fallback for older stored configs.
    const scanFailed = piiFailed && piiEnabled;
    if (scanFailed) {
        const failMode = orgShieldConfig.piiFailureMode || orgShieldConfig.dlpFailureMode || 'fail_closed';
        if (failMode === 'fail_closed') {
            return { action: 'block', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'failed', summary: {}, reason: failReason || 'pii_unavailable' };
        }
        // fail_open: continue, but mark the scan as failed.
    }

    // Apply mode: honour per-conversation remembered preference first — a
    // "remember my choice" from an earlier ask (this conversation) governs
    // here too, including the always-review case below, so a remembered
    // 'allow' doesn't get re-litigated on every clean message.
    const remembered = getConversationPref(conversationId);
    const mode = orgShieldConfig.dlpMode || 'ask';
    const effectiveChoice = remembered || null;

    if (all.length === 0) {
        // dlpAlwaysReview: pause even on a clean scan, so the user gets a
        // chance to flag what the detector missed — the only false-negative
        // safety net that exists. Skipped once the user has already picked
        // a per-conversation default (rememberForConversation), and skipped
        // when this turn also has attachments: those get their own ask-review
        // a few steps later (attachmentAskFlow.js) with real content to check,
        // so pausing here too — on an empty finding — only added a second,
        // near-empty modal right after the first, not real extra coverage.
        if (orgShieldConfig.dlpAlwaysReview && !effectiveChoice && !hasAttachments) {
            return { action: 'ask', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: scanFailed ? 'failed' : 'ok', summary: {} };
        }
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: scanFailed ? 'failed' : 'ok', summary: {} };
    }

    if (effectiveChoice === 'allow' || mode === 'auto_allow') {
        return { action: 'allow', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary: all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {}) };
    }

    if (effectiveChoice === 'redact' || mode === 'auto_redact') {
        const { tokenizedText, tokenMap, summary } = await _tokeniseAll(text, all, conversationId);
        _mergeIntoTokenMap(conversationId, tokenMap);
        _writeMapToDb(conversationId).catch(() => { /* logged in helper */ });
        return { action: 'redact', findings: all, provider, redactedText: tokenizedText, tokenMap, scanStatus: 'ok', summary };
    }

    if (mode === 'block') {
        const summary = all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {});
        return { action: 'block', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary };
    }

    // Default: ask the user.
    const summary = all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {});
    return { action: 'ask', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary };
}

/**
 * Helper for the callers who chose 'redact' via an interactive decision — apply
 * tokenisation now that the user has said yes.
 */
async function applyRedactionChoice({ conversationId, text, findings }) {
    const { tokenizedText, tokenMap, summary } = await _tokeniseAll(text, findings, conversationId);
    _mergeIntoTokenMap(conversationId, tokenMap);
    _writeMapToDb(conversationId).catch(() => { /* logged in helper */ });
    return { tokenizedText, tokenMap, summary };
}

/**
 * Public helper: merge an externally-built tokenMap into the conversation's
 * shared store so the streaming un-tokeniser (wrapped around `onEvent` in
 * chatStream.js) can restore these tokens on the response.
 *
 * Used by the legacy PII path in `guardrailsRunner.js` and by direct chat,
 * both of which produce their own tokenMap but historically dropped it after
 * rewriting the user message — which meant tokens leaked through to the user
 * when DLP itself was disabled.
 */
function mergeTokenMap(conversationId, tokenMap) {
    if (!conversationId || !tokenMap) return;
    let asObject = tokenMap;
    if (tokenMap instanceof Map) {
        asObject = {};
        for (const [k, v] of tokenMap) asObject[k] = v;
    }
    _mergeIntoTokenMap(conversationId, asObject);

    // Teach the vault, from the one funnel every producer reaches.
    //
    // This is the catch-all. Tokens are minted in six places — the DLP runner,
    // direct chat via validateInputForPii, the attachment scanner, compose
    // scan, tool-result redaction and the automation engine — and they all end
    // up here. Recording only at the mint sites meant direct chat's tokens
    // never reached the vault, so the same address got a stable placeholder in
    // agent chat and a fresh one in direct chat.
    //
    // Duplicate records are free: the value index makes a repeat sighting a
    // usage bump rather than a new row.
    _recordToVault(conversationId, asObject);
    // Write-through to DB so the map survives a server restart. The chat
    // turn does not block on this — failures are logged inside the helper.
    _writeMapToDb(conversationId).catch(() => { /* already logged */ });
}

module.exports = {
    scan,
    preWarmPiiScan,
    applyRedactionChoice,
    mergeTokenMap,
    getConversationTokenMap,
    getConversationTokenMapAsync,
    clearConversationState,
    setConversationPref,
    getConversationPref,
    gc,
};
