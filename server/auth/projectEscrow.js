// @typecheck
/**
 * Project key derivation — the key a SHARED project conversation is encrypted
 * under.
 *
 * ── Why a project needs its own key ─────────────────────────────────────────
 *
 * Every message key in this codebase is per-USER. On `managed` it is the
 * escrowed DEK bound to (org, user); on `zk` it is the session DEK derived from
 * that user's password. Both are, by construction, unreadable by anyone else.
 * That is correct for a private conversation and fatal for a shared one: member
 * B cannot open member A's thread, and the write path would re-encrypt the whole
 * conversation under B's key the first time B replied.
 *
 * So a shared thread is keyed to the PROJECT, derived from the org root key:
 *
 *   MASTER_ENCRYPTION_KEY  →  org vault KEK  →  Org Root Key (per org)
 *                                                    │ HKDF-SHA256
 *                                                    ▼
 *                                              Project key (per org+project)
 *                                                    │ HKDF-SHA256 (existing
 *                                                    ▼  conversationKey)
 *                                              Per-conversation key
 *
 * Derived rather than stored: nothing new to add to the rotate-master-key
 * inventory, and no second envelope to keep in sync. The per-conversation HKDF
 * step is kept so a leaked conversation key still does not open the project.
 *
 * ── What this costs, stated plainly ─────────────────────────────────────────
 *
 * On the `zk` tier this is a REAL WEAKENING, and it is deliberate. A shared
 * project conversation is readable by the server operator, because the key
 * chains back to MASTER_ENCRYPTION_KEY in their environment. It is the same
 * trade already made for ZK_ESCROW_SURFACES (the Privacy Shield token map and
 * conversation meta) and for the same reason: the alternative is not a stronger
 * shared thread, it is no shared thread at all — no background job, no
 * automation, and no second member could ever read it.
 *
 * PRIVATE conversations are untouched. They keep the per-user session DEK and
 * remain genuinely zero-knowledge. The weakening applies only when a user
 * explicitly shares a conversation into a project, and the UI says so at the
 * moment they do it.
 *
 * ── Rotation hazard ─────────────────────────────────────────────────────────
 *
 * `orgEscrow.rotateOrgRootKey` mints a new ORK and rewraps every member's DEK.
 * That is safe for WRAPPED keys and destructive for DERIVED ones: a rotation
 * changes every project key, orphaning every shared conversation's ciphertext
 * AND every team chat's (projects/chatCrypto.js seals titles and messages with
 * a key derived from this one) AND every co-edited document's (core/collab
 * seals its update log the same way). `assertNoSharedConversations` below is
 * the guard, and rotateOrgRootKey calls it before touching anything.
 */

const crypto = require('crypto');

const { resolveOrgId } = require('../stores/integrationConnectionStore');
const { secureClear } = require('./encryption');

/** Distinct from the message HKDF salt so the two hierarchies can never collide. */
const PROJECT_HKDF_SALT = Buffer.from('beeflow:project:hkdf-salt:v1');

// Bounded + expiring, mirroring the ORK cache in orgEscrow. Explicitly NOT the
// unbounded "cache forever" Map in auth/connectorJwt.js — that is a leak and
// long-lived key material on the heap.
const _projectKeyCache = new Map(); // `${orgId}|${projectId}` -> { at, key }
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;

function _cacheGet(cacheKey) {
    const hit = _projectKeyCache.get(cacheKey);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        _projectKeyCache.delete(cacheKey);
        secureClear(hit.key);
        return null;
    }
    return hit.key;
}

function _cacheSet(cacheKey, key) {
    if (_projectKeyCache.size >= CACHE_MAX) {
        const oldest = _projectKeyCache.keys().next().value;
        if (oldest !== undefined) {
            const ev = _projectKeyCache.get(oldest);
            _projectKeyCache.delete(oldest);
            if (ev) secureClear(ev.key);
        }
    }
    _projectKeyCache.set(cacheKey, { at: Date.now(), key });
}

/**
 * Drop cached project keys. Call after an ORK rotation.
 * @param {string} [orgId] omit to clear every org
 */
function invalidateProjectKeyCache(orgId) {
    if (orgId === undefined) {
        for (const [, v] of _projectKeyCache) secureClear(v.key);
        _projectKeyCache.clear();
        return;
    }
    const id = resolveOrgId(orgId);
    for (const [k, v] of [..._projectKeyCache]) {
        if (k.startsWith(`${id}|`)) {
            secureClear(v.key);
            _projectKeyCache.delete(k);
        }
    }
}

/**
 * Pure derivation, exported for tests and for callers that already hold the ORK.
 *
 * The info string binds BOTH the org and the project, mirroring
 * `orgEscrow.dekAad(orgId, userId)`. Binding the project alone would let a
 * project id recycled in another tenant derive the same key.
 *
 * @param {Buffer} ork 32-byte org root key
 * @param {string} orgId already passed through resolveOrgId
 * @param {string} projectId
 * @returns {Buffer} 32-byte key
 */
function deriveProjectKey(ork, orgId, projectId) {
    if (!Buffer.isBuffer(ork) || ork.length !== 32) {
        throw new Error('[ProjectEscrow] org root key must be a 32-byte Buffer');
    }
    if (!projectId) throw new Error('[ProjectEscrow] projectId is required');
    return Buffer.from(crypto.hkdfSync(
        'sha256', ork, PROJECT_HKDF_SALT,
        `beeflow:project:v1:key:${orgId}:${projectId}`, 32
    ));
}

/**
 * The project key for a conversation shared into `projectId`.
 *
 * Every call returns the caller's OWN copy. The cache zeroes its Buffer when
 * the entry expires or is evicted (`secureClear`), and callers hold the key
 * across awaits (a mention lookup, a context read, a whole chat stream). A
 * shared reference would be zeroed under them, and whatever they sealed next
 * would be sealed under a key derived from 32 zero bytes: unreadable for the
 * members, readable for anyone who knows the ids.
 *
 * THROWS rather than returning null when the key cannot be produced. Callers
 * must not fall back to plaintext here: unlike a fresh write, a shared-thread
 * write rewrites an ALREADY-ENCRYPTED conversation, so a silent downgrade would
 * strip protection from existing data. That is what
 * conversationMessages._refuseSilentDowngrade exists to stop, and this throw
 * keeps the failure upstream of it where the error message is useful.
 *
 * @param {string} projectId
 * @param {string|null} rawOrgId project.organizationId — '' is normal here
 * @returns {Promise<Buffer>}
 */
async function getProjectKey(projectId, rawOrgId) {
    if (!projectId) throw new Error('[ProjectEscrow] projectId is required');
    // Same sentinel as orgEscrow / orgVault. projects.organization_id defaults
    // to '' rather than NULL, so without this an org-less install would derive
    // a different key per code path.
    const orgId = resolveOrgId(rawOrgId);
    const cacheKey = `${orgId}|${projectId}`;

    const cached = _cacheGet(cacheKey);
    if (cached) return Buffer.from(cached);

    const { getOrgRootKey } = require('./orgEscrow');
    const ork = await getOrgRootKey(orgId);
    const key = deriveProjectKey(ork, orgId, projectId);
    _cacheSet(cacheKey, key);
    return Buffer.from(key);
}

/**
 * What else the org's projects hold under keys DERIVED from the ORK, besides
 * shared conversations. Each row is sealed with its project's key, so each is
 * data a rotation would make unreadable:
 *
 *   project_chats            team chats (stores/projectChatStore.js): a sealed
 *                            title, and messages sealed the same way
 *   collab_docs              co-edited documents (stores/collabDocStore.js):
 *                            every update, snapshot and checkpoint state
 *                            (core/collab/frame.js); only `key_scope =
 *                            'project'` rows use the project key
 *   project_comment_threads  comment threads (stores/projectCommentStore.js):
 *                            a sealed anchor, and comments sealed the same way
 *   user_memories            a project's shared memory pool (stores/memoryStore.js):
 *                            only the rows with a project_id, and only those
 *                            sealed (content starts with the envelope marker)
 *
 * The table and alias names are constants of this file, never input.
 */
const SEALED_UNDER_PROJECT_KEYS = Object.freeze([
    {
        table: 'project_chats', alias: 'pc', where: '',
        what: 'project team chat(s)', loses: 'their history',
        remedy: 'Delete them before rotating',
    },
    {
        table: 'collab_docs', alias: 'cd', where: "cd.key_scope = 'project' AND ",
        what: 'co-edited project document(s)', loses: 'their editing state',
        remedy: 'Switch co-editing off for the organisation (which folds every document back into its notebook or page) before rotating',
    },
    {
        table: 'project_comment_threads', alias: 'ct', where: '',
        what: 'project comment thread(s)', loses: 'their comments',
        remedy: 'Delete them before rotating',
    },
    {
        table: 'user_memories', alias: 'um',
        where: "um.project_id IS NOT NULL AND um.content LIKE '{\"_bfenc\"%' AND ",
        what: 'encrypted project memory row(s)', loses: 'their text',
        remedy: "Clear the project's shared memory before rotating",
    },
]);

/**
 * How many rows of one of those tables the org's projects hold. 0 on an
 * install that has never created the table: `to_regclass` asks first, so a
 * missing table is a fact rather than an error string to recognise.
 *
 * @param {(sql: string, params?: any[]) => Promise<any>} getOne
 * @param {{ table: string, alias: string, where: string }} kind
 * @param {string} id  already passed through resolveOrgId
 */
async function countSealedRows(getOne, kind, id) {
    const table = await getOne(`SELECT to_regclass('${kind.table}') IS NOT NULL AS present`);
    if (table?.present !== true) return 0;
    const row = await getOne(`
        SELECT COUNT(*)::int AS n
          FROM ${kind.table} ${kind.alias}
          JOIN projects p ON p.id = ${kind.alias}.project_id
         WHERE ${kind.where}COALESCE(NULLIF(p.organization_id, ''), $2) = $1
    `, [id, resolveOrgId(null)]);
    return row?.n || 0;
}

/**
 * Refuse an ORK rotation that would orphan shared conversations, team chats,
 * co-edited documents or comment threads.
 *
 * Project keys are DERIVED from the ORK, so rotating it silently changes every
 * one of them and no member — or background job — can open the existing
 * ciphertext afterwards. Re-encrypting every shared conversation and team chat
 * mid-rotation is the eventual answer; until that exists, stopping is the
 * honest option. Losing the ability to rotate is recoverable. Losing the
 * conversations is not.
 *
 * @param {string} orgId
 * @throws {Error} when the org has shared project conversations or anything
 *   else sealed under a project key (SEALED_UNDER_PROJECT_KEYS)
 */
async function assertNoSharedConversations(orgId) {
    const { getOne } = require('../db');
    const id = resolveOrgId(orgId);
    let row;
    try {
        row = await getOne(`
            SELECT COUNT(*)::int AS n
              FROM (
                SELECT c.id FROM direct_conversations c
                  JOIN projects p ON p.id = c.project_id
                 WHERE c.crypto_scope = 'project'
                   AND COALESCE(NULLIF(p.organization_id, ''), $2) = $1
                UNION ALL
                SELECT c.id FROM agent_conversations c
                  JOIN projects p ON p.id = c.project_id
                 WHERE c.crypto_scope = 'project'
                   AND COALESCE(NULLIF(p.organization_id, ''), $2) = $1
              ) t
        `, [id, resolveOrgId(null)]);
    } catch (err) {
        // The columns may not exist yet on an install that has never run the
        // Phase-1 migration. No shared conversations can exist there, so this is
        // not a reason to block a rotation.
        if (/column .* does not exist|relation .* does not exist/i.test(err.message)) return;
        throw err;
    }

    const n = row?.n || 0;
    if (n > 0) {
        throw new Error(
            `[ProjectEscrow] Refusing to rotate the org root key for ${id}: ` +
            `${n} shared project conversation(s) are encrypted with keys DERIVED from it, ` +
            'and rotation would make them permanently unreadable. Unshare them (which re-keys ' +
            'them to their owners) before rotating, or implement re-encryption in rotateOrgRootKey.'
        );
    }

    for (const kind of SEALED_UNDER_PROJECT_KEYS) {
        const count = await countSealedRows(getOne, kind, id);
        if (count > 0) {
            throw new Error(
                `[ProjectEscrow] Refusing to rotate the org root key for ${id}: ` +
                `${count} ${kind.what} are encrypted with keys DERIVED from it, ` +
                `and rotation would make ${kind.loses} permanently unreadable. ${kind.remedy}, ` +
                'or implement re-encryption in rotateOrgRootKey.'
            );
        }
    }
}

module.exports = {
    PROJECT_HKDF_SALT,
    deriveProjectKey,
    getProjectKey,
    invalidateProjectKeyCache,
    assertNoSharedConversations,
};
