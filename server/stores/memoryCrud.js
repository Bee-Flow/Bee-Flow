// @typecheck
/**
 * stores/memoryCrud.js — writing memories: create (with canonical dedupe
 * through the blind index), update, confirm, provenance, and the delete and
 * clear paths. Split out of stores/memoryStore.js.
 */

const { run, getOne } = require('../db');
const { randomUUID } = require('crypto');
const log = require('../telemetry/log');
const { embedAndStore } = require('./memoryEmbedding');
const { getMemoryById } = require('./memoryReads');
const { SCHEDULE_COVERAGE_TYPE } = require('./memoryStats');
const { dep } = require('./memoryDeps');
const {
    resolveWriteContext, sealFields, keyHashForWrite, keyHashCandidates, hydrateRows, canonicalParts,
} = dep('memoryCrypto');

/** The store's schema-init memo, installed by stores/memoryStore (read per call). */
const initDB = () => dep('initDB')();

// user_memories.origin: who caused the row to exist.
//   explicit  the person wrote it in the Memory panel
//   inferred  the extractor lifted it out of a conversation
//   imported  pasted in from another assistant's export
//   tool      an agent saved it through the memory_remember tool
const ORIGINS = Object.freeze(['explicit', 'inferred', 'imported', 'tool']);
// user_memories.sensitivity: 'art9' marks a GDPR Article 9 special category
// (health, beliefs, ...). Only the column lives here; the write pipeline decides.
const SENSITIVITIES = Object.freeze(['none', 'art9']);
// user_memories.status:
//   active          the live row; every read path filters on exactly this
//   superseded      replaced by a newer value for the same key (superseded_by)
//   expired         schedule_coverage past its TTL
//   pending_review  extracted but waiting for the person to accept it; invisible
//                   to retrieval, listing and counts until promoted to 'active'
//   archived        kept but out of use (archived_at); invisible like pending
// Every query below filters `status = 'active'` (or COALESCE(status,'active')),
// so the two newer values are excluded everywhere without further changes. The
// "clear" paths delete by owner regardless of status, which is what a clear
// must do.
const WRITABLE_STATUSES = Object.freeze(['active', 'pending_review']);

// ============ Memory CRUD Functions ============

/**
 * @param {object} [options]
 * @param {'explicit'|'inferred'|'imported'|'tool'} [options.origin]  default 'inferred'
 * @param {string|null} [options.sourceConversationId]  the conversation it came from
 * @param {'none'|'art9'} [options.sensitivity]  default 'none'
 * @param {'active'|'pending_review'} [options.status]  default 'active'
 * @param {number} [options.confidence]  0..1, default 1.0 (explicit / UI writes)
 * @param {string|null} [options.replacesId]  a pending_review row: the active row that approval supersedes
 */
async function createMemory(userId, agentId, type, content, summary = null, importance = 0.5, subject = null, attribute = null, value = null, evidenceQuote = null, projectId = null, options = {}) {
    await initDB();
    const confidence = Number.isFinite(options?.confidence) ? Math.min(1, Math.max(0, options.confidence)) : 1.0;
    const meta = {
        origin: ORIGINS.includes(options?.origin) ? options.origin : 'inferred',
        sensitivity: SENSITIVITIES.includes(options?.sensitivity) ? options.sensitivity : 'none',
        status: WRITABLE_STATUSES.includes(options?.status) ? options.status : 'active',
        sourceConversationId: options?.sourceConversationId || null,
        replacesId: options?.replacesId || null,
    };
    const wctx = await resolveWriteContext({ userId, projectId });

    // 1. Try Canonical Deduplication, through the blind index
    if (subject && attribute) {
        const existing = await _findActiveByKey(wctx, { userId, type, subject, attribute, projectId, agentId });

        if (existing) {
            if (existing.value === value) {
                log.info(`[MemoryStore] Canonical duplicate found (confirmed): ${type}`);
                await confirmMemory(existing.id);
                return existing.id;
            }

            log.info(`[MemoryStore] ${meta.status === 'active' ? 'Superseding' : 'Proposing a replacement for'} memory ${existing.id} (${type})`);
            const newId = randomUUID();
            await _insertMemory(newId, wctx, {
                userId, agentId, type, content, summary, importance, subject, attribute, value,
                evidenceQuote, projectId, confidence, ...meta,
            });
            // Only an active statement replaces an active fact: a pending_review
            // row waits for approval (memoryLifecycle.approve supersedes then).
            if (meta.status === 'active') {
                await run(`UPDATE user_memories SET status = 'superseded', superseded_by = $1, valid_to = NOW(), updated_at = NOW() WHERE id = $2`, [newId, existing.id]);
            }
            embedAndStore(newId, content, wctx);
            return newId;
        }
    }

    // 2. Create new memory
    const id = randomUUID();
    await _insertMemory(id, wctx, {
        userId, agentId, type, content, summary, importance, subject, attribute, value,
        evidenceQuote, projectId, confidence, ...meta,
    });

    // Embed async (fire-and-forget)
    embedAndStore(id, content, wctx);

    log.info(`[MemoryStore] Created memory ${id} (${type})`);
    return id;
}

/** INSERT one row, sealing the text columns when the write context says so. */
async function _insertMemory(id, wctx, f) {
    const sealed = sealFields(id, {
        content: f.content,
        summary: f.summary || String(f.content).slice(0, 50),
        value: f.value || null,
        evidence_quote: f.evidenceQuote ?? null,
        subject: f.subject || null,
        attribute: f.attribute || null,
    }, wctx);
    const keyHash = f.subject && f.attribute
        ? keyHashForWrite({ type: f.type, subject: f.subject, attribute: f.attribute }, wctx)
        : null;
    await run(`
        INSERT INTO user_memories (id, user_id, agent_id, type, content, subject, attribute, value, confidence, summary, importance, evidence_quote, last_confirmed_at, status, project_id, origin, sensitivity, source_conversation_id, key_hash, replaces_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15, $16, $17, $18, $19)
    `, [id, f.userId, f.agentId, f.type, sealed.content, sealed.subject, sealed.attribute, sealed.value, f.confidence,
        sealed.summary, f.importance, sealed.evidence_quote, f.status, f.projectId, f.origin, f.sensitivity,
        f.sourceConversationId, keyHash, f.status === 'pending_review' ? (f.replacesId || null) : null]);
}

/**
 * The active row for a canonical key, hydrated, or null. Scoped to the
 * project's pool or to the user's personal rows, and to one agent bucket (a
 * global memory never matches an agent-scoped one).
 */
async function _findActiveByKey(wctx, { userId, type, subject, attribute, projectId = null, agentId = null }) {
    const hashes = keyHashCandidates({ type, subject, attribute }, wctx);
    // Fallback for a row that has no key_hash yet (written by a build that
    // predates the column during a rolling upgrade, before the next boot's
    // backfill): compare the plaintext columns, normalised like canonicalKey.
    // A sealed row always has a key_hash, so this can only match plaintext.
    const norm = (c) => `regexp_replace(lower(btrim(${c})), '\\s+', ' ', 'g')`;
    let query = `SELECT * FROM user_memories WHERE status = 'active'
        AND (key_hash = ANY($1::text[]) OR (key_hash IS NULL AND ${norm('type')} = $4 AND ${norm('subject')} = $5 AND ${norm('attribute')} = $6))`;
    /** @type {any[]} */
    const params = [hashes];
    if (projectId) {
        query += ` AND project_id = $2`;
        params.push(projectId);
    } else {
        query += ` AND user_id = $2 AND project_id IS NULL`;
        params.push(userId);
    }
    query += ` AND agent_id IS NOT DISTINCT FROM $3 LIMIT 1`;
    params.push(agentId || null, ...canonicalParts(type, subject, attribute));
    const row = await getOne(query, params);
    return row ? (await hydrateRows([row]))[0] || null : null;
}

async function findByKey(userId, type, subject, attribute, projectId = null, agentId = null) {
    await initDB();
    const wctx = await resolveWriteContext({ userId, projectId });
    return _findActiveByKey(wctx, { userId, type, subject, attribute, projectId, agentId });
}

async function updateMemoryValue(memoryId, newValue, newContent, evidenceQuote) {
    await initDB();
    const row = await getOne('SELECT user_id, project_id FROM user_memories WHERE id = $1', [memoryId]);
    if (!row) return;
    const wctx = await resolveWriteContext({ userId: row.user_id, projectId: row.project_id });
    const sealed = sealFields(memoryId, { value: newValue, content: newContent, evidence_quote: evidenceQuote }, wctx);
    await run(`
        UPDATE user_memories SET value = $1, content = $2, evidence_quote = $3, last_confirmed_at = NOW(), updated_at = NOW() WHERE id = $4
    `, [sealed.value, sealed.content, sealed.evidence_quote, memoryId]);
    // The text changed, so the vector must follow (fire-and-forget, as in createMemory).
    embedAndStore(memoryId, newContent, wctx);
    log.info(`[MemoryStore] Updated memory ${memoryId} with a new value`);
}

async function confirmMemory(memoryId) {
    await initDB();
    await run(`
        UPDATE user_memories SET last_confirmed_at = NOW(), confidence = LEAST(1.0, confidence + 0.05), access_count = access_count + 1 WHERE id = $1
    `, [memoryId]);
}

async function updateMemory(id, content, summary = null, importance = null) {
    await initDB();
    const existing = await getMemoryById(id);
    if (!existing) return false;
    const wctx = await resolveWriteContext({ userId: existing.user_id, projectId: existing.project_id });
    const sealed = sealFields(id, { content, summary: summary || content.slice(0, 50) }, wctx);
    await run(`
        UPDATE user_memories SET content = $1, summary = $2, importance = $3, updated_at = NOW(), reviewed_at = NOW() WHERE id = $4
    `, [sealed.content, sealed.summary, importance !== null ? importance : existing.importance, id]);
    if (content !== existing.content) embedAndStore(id, content, wctx);
    return true;
}

async function deleteMemory(id) {
    // With its memory_sources rows: there is no foreign key to cascade them.
    return deleteMemoriesWithSources('id = $1', [id]);
}

/**
 * Delete every memory matching `where`, and the source messages behind them.
 *
 * `memory_sources` links a memory to its source conversation (it used to hold
 * a raw copy of the message too, see migrations/memory-sources-strip-2026-10.js)
 * and has no foreign key to `user_memories`, so deleting the memories alone
 * strands those rows (see the order rule in
 * migrations/memory-guest-purge-2026-08.js). One statement, so the two
 * deletes cannot come apart.
 *
 * @param {string} where  a fixed predicate on user_memories; values go in `params`
 * @param {any[]} params
 */
async function deleteMemoriesWithSources(where, params) {
    await initDB();
    await run(`
        WITH gone AS (DELETE FROM user_memories WHERE ${where} RETURNING id)
        DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone)
    `, params);
    return true;
}

/**
 * Bulk delete in ONE statement, memory_sources rows included. The caller has
 * already authorised every id (routes/memory.js runs canAccessMemory per row:
 * personal rows are the owner's, project-pool rows need editor), so there is
 * no user filter here. Unknown ids are skipped. Returns the number removed.
 *
 * @param {string[]} ids
 * @returns {Promise<number>}
 */
async function deleteMemoriesByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    await initDB();
    const res = await getOne(`
        WITH gone AS (DELETE FROM user_memories WHERE id = ANY($1::text[]) RETURNING id),
             src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
        SELECT COUNT(*)::int AS n FROM gone
    `, [ids]);
    return res?.n || 0;
}

/**
 * "Clear All" in Settings: the person's PERSONAL memory, every status. Rows
 * in a project's shared pool are not theirs to clear from here, even the
 * ones they wrote; that is clearProjectMemories.
 */
async function clearAllMemories(userId) {
    return deleteMemoriesWithSources('user_id = $1 AND project_id IS NULL', [userId]);
}

/**
 * "Clear All" in a project's Memory tab: the project's shared pool, whoever
 * wrote each row and in every status. The same pool getMemoriesForProject
 * lists (its active rows) plus the superseded history behind them, as the
 * personal clear has always taken. Authorization is the caller's: the route
 * asks for editor on the project first.
 */
async function clearProjectMemories(projectId) {
    return deleteMemoriesWithSources('project_id = $1', [projectId]);
}

/**
 * Org admin "clear all memories of this organisation": every user_memories row
 * of every user in the org, personal and project-pool rows they wrote, with
 * their memory_sources rows, in ONE statement. The schedule_coverage
 * bookkeeping rows are not memories and stay. Returns the number removed.
 */
async function deleteMemoriesForOrg(orgId) {
    if (!orgId) return 0;
    await initDB();
    const res = await getOne(`
        WITH gone AS (
            DELETE FROM user_memories
            WHERE user_id IN (SELECT id FROM users WHERE "organizationId" = $1)
              AND type <> $2
            RETURNING id
        ),
        src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
        SELECT COUNT(*)::int AS n FROM gone
    `, [orgId, SCHEDULE_COVERAGE_TYPE]);
    return res?.n || 0;
}

// Provenance only: which conversation a memory came from. The message text is
// deliberately NOT stored (no plaintext copy of the chat); the legacy
// `message_content` column stays in the schema but is never written.
async function addMemorySource(memoryId, conversationId) {
    await initDB();
    const id = randomUUID();
    await run(`
        INSERT INTO memory_sources (id, memory_id, conversation_id)
        VALUES ($1, $2, $3)
    `, [id, memoryId, conversationId]);
}

module.exports = {
    ORIGINS, SENSITIVITIES, WRITABLE_STATUSES,
    createMemory, findByKey, updateMemoryValue, confirmMemory, updateMemory,
    deleteMemory, deleteMemoriesByIds, clearAllMemories, clearProjectMemories, deleteMemoriesForOrg,
    addMemorySource,
};
