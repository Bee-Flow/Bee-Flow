// @typecheck
/**
 * Per-conversation crypto context for the message store.
 *
 * Resolves three things for a request: is encryption on for this org, which
 * surfaces, and what key to use. Everything downstream (conversationMessages)
 * takes the resulting context and never talks to the policy or the escrow
 * itself.
 *
 * ── Key precedence, per tier ────────────────────────────────────────────────
 *
 *   managed  THE ESCROW KEY, ALWAYS — the session DEK is deliberately ignored.
 *            The two are different keys (users.wrappedDEK is derived from the
 *            user's password; users.orgWrappedDEK is a random DEK wrapped by
 *            the org root key), so preferring whichever happened to be present
 *            meant a logged-in user wrote under one key and every background
 *            job read under the other. Reads then threw FieldDecryptError, and
 *            both promises of the tier — admin password reset without data
 *            loss, and unattended automations — were false. One key per user is
 *            the invariant that makes `managed` mean anything.
 *
 *   zk       THE SESSION DEK for message content, so the server genuinely
 *            cannot read it. But `zk` has no escrow, which left every keyless
 *            caller writing plaintext: the Privacy Shield token map — the
 *            dictionary that de-anonymises every token in the conversation —
 *            could not be encrypted AT ALL, by construction, because it is
 *            written from the DLP runner with no session in scope.
 *
 *            So a NARROW ESCROW applies to the background surfaces only
 *            (ZK_ESCROW_SURFACES below). Message bodies and message meta stay
 *            strictly zero-knowledge; the token map and conversation meta are
 *            protected by an org-held key instead of not at all. This is a
 *            deliberate, stated weakening of `zk` and the admin tier card says
 *            so in plain words — a surface that silently protects nothing is
 *            worse than one that is honestly labelled.
 *
 * ── PROJECT_SHARED_MESSAGES: the second stated weakening of `zk` ────────────
 *
 * A conversation SHARED INTO A PROJECT is encrypted with a key derived from the
 * org root key (auth/projectEscrow.js), not with any user's key — on `zk` too.
 * It is therefore readable by the server operator.
 *
 * There is no version of this that is both shared and zero-knowledge under the
 * current key hierarchy. A per-member wrapped project DEK would keep the
 * property, at the cost of: no background job or automation can ever read a
 * shared thread, and every invite requires the inviter to be online. The
 * product needs shared threads that automations can act on, so the trade was
 * made deliberately.
 *
 * The scope is narrow and user-controlled:
 *   - PRIVATE conversations are untouched. Still the session DEK, still zk.
 *   - Only an explicit "share into project" action moves a conversation across,
 *     it re-encrypts at that moment, and the UI states the consequence there.
 *   - Unsharing re-keys it back to the owner.
 *
 * As with ZK_ESCROW_SURFACES: honestly labelled beats silently degraded.
 *
 * If no key can be resolved, the context reports `encrypt: false` and writes
 * stay plaintext. Emitting a value nobody can open is strictly worse than
 * emitting plaintext, so we never do it.
 *
 * ── AAD binds to the conversation, NOT the reader ───────────────────────────
 *
 * The older message envelope used `v2:user:{userId}:conv:{id}`, which meant a
 * conversation read on behalf of anyone but the original author failed its AAD
 * check — and the read path turned that into an empty message list, i.e. data
 * loss presented as an empty chat. Binding to the conversation keeps the
 * cross-conversation replay protection that actually matters while letting a
 * shared or admin-viewed conversation decrypt.
 */

const crypto = require('crypto');
const log = require('../../telemetry/log');

const HKDF_SALT = Buffer.from('beeflow:msg:hkdf-salt:v1');

const { SURFACES, resolvePolicy, shouldEncrypt } = require('../encryptionPolicy');

/**
 * Derive the per-conversation key from a root DEK.
 * @param {Buffer} dek
 * @param {string} conversationId
 * @returns {Buffer} 32-byte key
 */
function conversationKey(dek, conversationId) {
    return Buffer.from(crypto.hkdfSync('sha256', dek, HKDF_SALT, `beeflow:msg:v3:conv:${conversationId}`, 32));
}

/**
 * AAD for a message field.
 * @param {string} conversationId
 * @param {string} type 'agent' | 'direct'
 * @param {string} field 'content' | 'meta'
 */
function messageAad(conversationId, type, field) {
    return `bfmsg:v3:${type || 'agent'}:${conversationId}:${field}`;
}

function _toKeyBuffer(encryptionKey) {
    if (!encryptionKey) return null;
    if (Buffer.isBuffer(encryptionKey)) return encryptionKey.length === 32 ? encryptionKey : null;
    if (typeof encryptionKey === 'string') {
        try {
            const buf = Buffer.from(encryptionKey, 'base64');
            return buf.length === 32 ? buf : null;
        } catch (_) { return null; }
    }
    return null;
}

/**
 * A context that encrypts nothing — today's behaviour, and the fallback for
 * every error path.
 */
// Throttled so a busy org cannot flood the log with one line per message —
// the signal we need is "this is happening", not the count.
const _warnedNoKey = new Map(); // orgId|tier -> last logged at (ms)
const NO_KEY_WARN_INTERVAL_MS = 60_000;

const _NO_KEY_HINT = {
    // No session DEK. On zk that is the only source for message content.
    messages: 'Message content stays PLAINTEXT. On zk the content key is derived at login: '
        + 'the user must sign in again (sessions created before the tier change carry no DEK).',
    // No escrow. Everything a background job touches falls back to plaintext.
    background: 'The Privacy Shield token map and conversation meta stay PLAINTEXT. '
        + 'These use the org escrow — check MASTER_ENCRYPTION_KEY and organizations.org_root_key.',
    all: 'NOTHING is being encrypted. Check MASTER_ENCRYPTION_KEY, the org escrow key, '
        + 'and that the org is entitled to the encryption feature.',
};

function _warnNoKey(orgId, tier, userId, kind = 'all') {
    const k = `${orgId}|${tier}|${kind}`;
    const now = Date.now();
    const last = _warnedNoKey.get(k) || 0;
    if (now - last < NO_KEY_WARN_INTERVAL_MS) return;
    _warnedNoKey.set(k, now);
    log.error(
        `[MessageCrypto] Org '${orgId}' is on encryption tier '${tier}' but no ${kind === 'all' ? '' : kind + ' '}key ` +
        `is available (user=${userId || 'none'}). ${_NO_KEY_HINT[kind] || _NO_KEY_HINT.all}`
    );
}

/**
 * What resolveCrypto hands a store: the keys in scope and, per surface,
 * whether to encrypt.
 * @typedef {object} CryptoContext
 * @property {Buffer|null} key                 message content (zero-knowledge surface)
 * @property {Buffer|null} backgroundKey       surfaces a keyless caller has to reach
 * @property {boolean} encryptMessages
 * @property {boolean} encryptMeta
 * @property {boolean} encryptConversationMeta
 * @property {boolean} encryptTitle
 * @property {boolean} encryptNotebookMessages
 * @property {boolean} encryptMemories        user_memories (a background surface: uses backgroundKey)
 * @property {string} tier
 * @property {boolean} [sharedProject]
 */

/** @type {Readonly<CryptoContext>} */
const PLAINTEXT_CONTEXT = Object.freeze({
    key: null,
    backgroundKey: null,
    encryptMessages: false,
    encryptMeta: false,
    encryptConversationMeta: false,
    encryptTitle: false,
    encryptNotebookMessages: false,
    encryptMemories: false,
    tier: 'none',
});

/**
 * Surfaces that use the org escrow even on `zk`.
 *
 * These are all written or read by code with no user session in scope — the DLP
 * runner persisting a token map, compaction summarising a conversation at 3am,
 * the vault being read to answer a settings page. On `zk` there was no key for
 * them at all, so they were written in the clear. An org-held key is weaker
 * than zero-knowledge and strictly stronger than plaintext.
 *
 * Message content is deliberately NOT in this set. That is the line that makes
 * `zk` still worth choosing.
 */
/**
 * Tag on an error thrown when a shared project's key cannot be produced.
 * Routes map it to a 503 with an operator-facing message; the outer catch in
 * resolveCrypto uses it to know this is the one failure it must not absorb.
 */
const PROJECT_KEY_UNAVAILABLE = 'PROJECT_KEY_UNAVAILABLE';

const ZK_ESCROW_SURFACES = Object.freeze([
    SURFACES.PII_TOKEN_MAP,
    SURFACES.CONVERSATION_META,
    SURFACES.CONVERSATION_TITLE,
    // Memory is extracted after the reply, read by automations and pruned by the
    // retention job, none of which has a session. Readable by the operator on
    // zk, like the token map; stated on the tier card.
    SURFACES.MEMORIES,
]);

/**
 * Resolve the escrowed DEK for a user, or null if it cannot be had.
 * Never throws — a key lookup must not be able to fail a chat request.
 */
async function _escrowKey(userId, orgId, seedDek = null) {
    if (!userId) return null;
    try {
        const escrow = require('../../auth/orgEscrow');
        return await escrow.getOrCreateUserDek(userId, orgId, { seedDek });
    } catch (err) {
        log.error('[MessageCrypto] escrow key unavailable:', err.message);
        return null;
    }
}

/**
 * Resolve the crypto context for a conversation operation.
 *
 * Never throws: any failure resolves to PLAINTEXT_CONTEXT, because reads stay
 * correct regardless (they detect the format on the value) and a policy lookup
 * must not be able to fail a chat request.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.userId]
 * @param {string|null} [opts.orgId]           avoids a user lookup when known
 * @param {string|Buffer|null} [opts.encryptionKey]  session DEK, if any
 * @param {{projectId: string, orgId?: string}|null} [opts.projectKeyFor]
 *        Set for a conversation whose `crypto_scope` is 'project'. The key then
 *        comes from the project, not the caller — see the PROJECT_SHARED_MESSAGES
 *        note in this file's header. Never inferred: a caller must say so.
 * @returns {Promise<CryptoContext>}
 */
async function resolveCrypto({ userId = null, orgId = undefined, encryptionKey = null, projectKeyFor = null } = {}) {
    try {
        let resolvedOrgId = orgId;
        if (resolvedOrgId === undefined && userId) {
            const userStore = require('../userStore');
            const user = await userStore.getUser(userId);
            resolvedOrgId = user?.organizationId || null;
        }

        const policy = await resolvePolicy(resolvedOrgId);
        if (!policy.enabled) return PLAINTEXT_CONTEXT;

        // ── Shared project conversation ──────────────────────────────────────
        // The key belongs to the PROJECT, on every tier. Resolving it from the
        // caller instead would mean each member wrote under their own key and
        // the next reader — member, admin or 3am automation — got a decrypt
        // failure presented as an empty conversation.
        //
        // This is where `zk` is knowingly weakened, for shared threads only.
        if (projectKeyFor && projectKeyFor.projectId) {
            const { getProjectKey } = require('../../auth/projectEscrow');
            // This must NOT degrade to plaintext. Unlike a fresh write, a shared
            // write rewrites rows that are already encrypted, so falling back
            // would strip protection from existing data. The outer catch below
            // exists to keep a policy hiccup from failing a chat request — it
            // must not apply here, so the failure is tagged and rethrown past it.
            let key;
            try {
                key = await getProjectKey(
                    projectKeyFor.projectId,
                    projectKeyFor.orgId !== undefined ? projectKeyFor.orgId : resolvedOrgId
                );
            } catch (err) {
                err.code = PROJECT_KEY_UNAVAILABLE;
                throw err;
            }
            const on = (surface) => shouldEncrypt(policy, surface);
            return {
                key,
                backgroundKey: key,
                encryptMessages: on(SURFACES.MESSAGES),
                encryptMeta: on(SURFACES.MESSAGE_META),
                encryptConversationMeta: on(SURFACES.CONVERSATION_META),
                encryptTitle: on(SURFACES.CONVERSATION_TITLE),
                encryptNotebookMessages: on(SURFACES.NOTEBOOK_MESSAGES),
                encryptMemories: on(SURFACES.MEMORIES),
                tier: policy.tier,
                sharedProject: true,
            };
        }

        // `key`           protects message content — the zero-knowledge surface.
        // `backgroundKey` protects the surfaces a keyless caller has to reach.
        // On `managed` they are the same key by design: one key per user is what
        // lets an admin-reset user and a 3am automation read the same rows.
        let key = null;
        let backgroundKey = null;

        if (policy.tier === 'managed') {
            // The session DEK is IGNORED as a content key here, on purpose: it
            // is a different key from the escrowed one, and honouring whichever
            // happened to be present is what split a user's data across two.
            //
            // It is still passed as a SEED, so the very first escrow created for
            // a user adopts the key their existing rows were already written
            // under instead of minting an unrelated one. After that first write
            // the seed is ignored — the stored escrow is authoritative forever.
            key = await _escrowKey(userId, resolvedOrgId, encryptionKey);
            backgroundKey = key;
        } else {
            key = _toKeyBuffer(encryptionKey);
            backgroundKey = await _escrowKey(userId, resolvedOrgId);
        }

        if (!key && !backgroundKey) {
            // The org asked for encryption and we are about to write plaintext.
            // This used to return silently, which is how an org sat on the `zk`
            // tier writing cleartext with nothing in the logs to show for it.
            // Falling back to plaintext is still the right call — emitting a
            // value nobody can ever open would be worse — but it must be loud.
            _warnNoKey(resolvedOrgId, policy.tier, userId, 'all');
            return PLAINTEXT_CONTEXT;
        }

        // Partial resolution is the dangerous case, because the org still sees
        // "encryption: on" while one half of it silently degrades. Warn for each
        // half independently or the louder one masks the quieter.
        if (!key && shouldEncrypt(policy, SURFACES.MESSAGES)) {
            _warnNoKey(resolvedOrgId, policy.tier, userId, 'messages');
        }
        if (!backgroundKey && shouldEncrypt(policy, SURFACES.PII_TOKEN_MAP)) {
            _warnNoKey(resolvedOrgId, policy.tier, userId, 'background');
        }

        // A surface is only encrypted when the policy asks for it AND a key that
        // can serve it actually resolved. Without the second half, `zk` with no
        // session would report encryptMessages:true and then write plaintext,
        // which is precisely the silent failure this module exists to avoid.
        const on = (surface, k) => !!k && shouldEncrypt(policy, surface);

        return {
            key,
            backgroundKey,
            encryptMessages: on(SURFACES.MESSAGES, key),
            encryptMeta: on(SURFACES.MESSAGE_META, key),
            encryptConversationMeta: on(SURFACES.CONVERSATION_META, backgroundKey),
            encryptTitle: on(SURFACES.CONVERSATION_TITLE, backgroundKey),
            encryptNotebookMessages: on(SURFACES.NOTEBOOK_MESSAGES, key),
            encryptMemories: on(SURFACES.MEMORIES, backgroundKey),
            tier: policy.tier,
        };
    } catch (err) {
        // A shared-project key that cannot be produced is NOT a "write plaintext
        // and carry on" situation — see the block above. Everything else is:
        // reads stay correct regardless (the format is detected on the value),
        // and a policy lookup must not be able to fail a chat request.
        if (err.code === PROJECT_KEY_UNAVAILABLE) throw err;
        log.error('[MessageCrypto] policy resolution failed, writing plaintext:', err.message);
        return PLAINTEXT_CONTEXT;
    }
}

module.exports = {
    conversationKey,
    messageAad,
    resolveCrypto,
    PLAINTEXT_CONTEXT,
    ZK_ESCROW_SURFACES,
    PROJECT_KEY_UNAVAILABLE,
    _toKeyBuffer,
    _escrowKey,
};
