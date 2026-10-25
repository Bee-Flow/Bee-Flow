// @typecheck
/**
 * memoryQueries — the read/list/bulk queries behind routes/memory.js.
 *
 * memoryStore.js owns writing a memory and retrieving it for a prompt. The
 * Memory screen needs something else: filtered, sorted, enriched lists, review
 * queues, bulk actions and per-conversation deletes. They live here so the
 * store stays about the memory pipeline and the route stays about HTTP.
 *
 * Everything that returns rows goes through `hydrateRows` (stores/memoryCrypto)
 * so sealed columns are opened, and everything that returns a memory to the
 * client goes through `presentMemories`, which is an ALLOW-LIST: the embedding,
 * the blind index and any column added next year stay server-side.
 *
 * Built by a factory so a test can run it against an in-process Postgres
 * without touching the module system; the default instance uses the real db.
 */

const log = require('../telemetry/log');
const { makeMemoryPresenter, PUBLIC_FIELDS, iso } = require('./memoryPresenter');

/** Statuses the Memory screen may list. */
const LISTABLE_STATUSES = Object.freeze(['active', 'pending_review', 'archived']);
const SORTS = Object.freeze(['recent', 'last_used', 'importance']);
const SCOPES = Object.freeze(['personal', 'agent', 'project', 'all']);

/** Longest page, and the most rows a JS-side (sealed) search will scan. */
const MAX_LIMIT = 200;
const DEFAULT_SCAN_LIMIT = 1000;
const EXPORT_CAP = 10000;

const ORDER_BY = Object.freeze({
    recent: 'COALESCE(updated_at, created_at) DESC, id',
    last_used: 'last_used_at DESC NULLS LAST, COALESCE(updated_at, created_at) DESC, id',
    importance: 'importance DESC, COALESCE(updated_at, created_at) DESC, id',
});


/**
 * @param {{ db: () => any, crypto: () => any, ready: () => Promise<void>, lifecycle: () => any }} c
 */
function makeListing({ db, crypto, ready }, presentMemories) {
    /**
     * Where-clause for a list. Rows that are not 'active' (pending, archived)
     * are private to the person they belong to, in every scope.
     *
     * @param {string} userId
     * @param {any} f
     */
    function buildWhere(userId, f) {
        const params = [userId];
        const p = (v) => { params.push(v); return `$${params.length}`; };
        const where = [];
        const scope = f.scope || 'personal';
        if (scope === 'project') {
            // $1 is always bound; Postgres cannot type a parameter nothing mentions.
            where.push('$1::text IS NOT NULL', `project_id = ${p(f.projectId)}`);
        } else if (scope === 'agent') {
            where.push('user_id = $1', 'project_id IS NULL');
            if (f.agentId) {
                const a = p(f.agentId);
                where.push(f.includeGeneral ? `(agent_id = ${a} OR agent_id IS NULL)` : `agent_id = ${a}`);
            } else {
                where.push('agent_id IS NOT NULL');
            }
        } else if (scope === 'all') {
            where.push(f.projectId
                ? `((user_id = $1 AND project_id IS NULL) OR project_id = ${p(f.projectId)})`
                : 'user_id = $1 AND project_id IS NULL');
        } else {
            where.push('user_id = $1', 'project_id IS NULL');
        }
        // Art. 9 rows are visible to their own person only, also in a project
        // pool (rows there are otherwise shared by every member).
        where.push(`(COALESCE(sensitivity, 'none') <> 'art9' OR user_id = $1)`);
        const status = f.status || 'active';
        where.push(`COALESCE(status, 'active') = ${p(status)}`);
        if (status !== 'active') where.push('user_id = $1');
        if (f.type) where.push(`type = ${p(f.type)}`);
        if (f.origin) where.push(`COALESCE(origin, 'inferred') = ${p(f.origin)}`);
        return { where, params };
    }

    /**
     * One page of a list.
     *
     * Search cannot run in SQL over a sealed column: when the scope holds a
     * sealed row (or the org seals memory now) the newest `scanLimit` rows are
     * opened and filtered here and `truncated` says whether older rows were
     * left unsearched.
     *
     * @param {string} userId
     * @param {{scope?: string, agentId?: string|null, projectId?: string|null, includeGeneral?: boolean,
     *   origin?: string|null, status?: string, sort?: string, type?: string|null, search?: string|null,
     *   limit?: number, offset?: number, scanLimit?: number}} f
     */
    async function listMemories(userId, f = {}) {
        await ready();
        const { hydrateRows, resolveWriteContext } = crypto();
        const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(String(f.limit), 10) || 50));
        const offset = Math.max(0, parseInt(String(f.offset), 10) || 0);
        const order = ORDER_BY[f.sort] || ORDER_BY.recent;
        const { where, params } = buildWhere(userId, f);
        const needle = f.search && String(f.search).trim() ? String(f.search).trim() : '';

        if (needle) {
            const sealed = await db().getOne(
                `SELECT 1 AS present FROM user_memories WHERE ${where.join(' AND ')} AND content LIKE '{"_bfenc"%' LIMIT 1`, params);
            const mustScan = !!sealed
                || (await resolveWriteContext({ userId, projectId: f.projectId || null })).encrypt;
            if (mustScan) {
                const cap = Math.max(1, Math.min(10000, parseInt(String(f.scanLimit), 10) || DEFAULT_SCAN_LIMIT));
                const rows = await db().getAll(
                    `SELECT * FROM user_memories WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${cap}`, params);
                const q = needle.toLowerCase();
                const hits = (await hydrateRows(rows)).filter((m) =>
                    [m.content, m.summary, m.subject, m.attribute, m.value].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
                return {
                    items: await presentMemories(hits.slice(offset, offset + limit)),
                    total: hits.length, limit, offset, truncated: rows.length >= cap,
                };
            }
            params.push(`%${needle.replace(/[\\%_]/g, '\\$&')}%`);
            const i = params.length;
            where.push(`(content ILIKE $${i} OR summary ILIKE $${i} OR subject ILIKE $${i} OR attribute ILIKE $${i} OR value ILIKE $${i})`);
        }

        const whereSql = where.join(' AND ');
        const rows = await db().getAll(
            `SELECT * FROM user_memories WHERE ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params);
        const count = await db().getOne(`SELECT COUNT(*)::int AS total FROM user_memories WHERE ${whereSql}`, params);
        return { items: await presentMemories(await hydrateRows(rows)), total: count?.total || 0, limit, offset };
    }

    /**
     * The caller's readable ACTIVE rows among `ids` (the reload previews of the
     * chat): their own personal rows, or project-pool rows `canReadProject`
     * allows. Never another person's art. 9 row, never a non-active one.
     *
     * @param {string} userId
     * @param {string[]} ids
     * @param {{canReadProject?: (projectId: string) => Promise<boolean>}} [opts]
     */
    async function listActiveByIds(userId, ids, { canReadProject } = {}) {
        const list = [...new Set((Array.isArray(ids) ? ids : []).filter((i) => typeof i === 'string' && i))];
        if (list.length === 0) return [];
        await ready();
        const rows = await db().getAll(`
            SELECT * FROM user_memories
             WHERE id = ANY($1::text[])
               AND COALESCE(status, 'active') = 'active'
               AND (expires_at IS NULL OR expires_at > NOW())
               AND (user_id = $2 OR project_id IS NOT NULL)
               AND (COALESCE(sensitivity, 'none') <> 'art9' OR user_id = $2)
             ORDER BY created_at DESC, id
             LIMIT 50
        `, [list, userId]);
        const roles = new Map();
        const readable = [];
        for (const row of rows) {
            if (row.project_id) {
                // A pool row needs a role in its project, also for its author.
                if (!canReadProject) continue;
                if (!roles.has(row.project_id)) roles.set(row.project_id, !!(await canReadProject(row.project_id)));
                if (!roles.get(row.project_id)) continue;
            }
            readable.push(row);
        }
        return presentMemories(await crypto().hydrateRows(readable));
    }

    /**
     * The caller's memories made in one conversation since a moment, for the
     * "Remembered" chip. Superseded rows are history, not news.
     */
    async function listRecent(userId, conversationId, since) {
        await ready();
        const rows = await db().getAll(`
            SELECT * FROM user_memories
             WHERE user_id = $1
               AND COALESCE(status, 'active') <> 'superseded'
               AND created_at >= $3
               AND (source_conversation_id = $2
                    OR id IN (SELECT memory_id FROM memory_sources WHERE conversation_id = $2))
             ORDER BY created_at DESC, id
             LIMIT 50
        `, [userId, conversationId, since]);
        return presentMemories(await crypto().hydrateRows(rows));
    }

    /** The caller's rows waiting for review, oldest first. */
    async function listReview(userId, { limit = 50, offset = 0 } = {}) {
        await ready();
        const lim = Math.max(1, Math.min(MAX_LIMIT, parseInt(String(limit), 10) || 50));
        const off = Math.max(0, parseInt(String(offset), 10) || 0);
        const where = `user_id = $1 AND status = 'pending_review'`;
        const rows = await db().getAll(
            `SELECT * FROM user_memories WHERE ${where} ORDER BY created_at ASC, id LIMIT ${lim} OFFSET ${off}`, [userId]);
        const count = await db().getOne(`SELECT COUNT(*)::int AS total FROM user_memories WHERE ${where}`, [userId]);
        return { items: await presentMemories(await crypto().hydrateRows(rows)), total: count?.total || 0 };
    }

    /**
     * Numbers for the Memory screen header, over the person's ACTIVE personal
     * memory (the same rows the default list shows), plus the review backlog.
     */
    async function getStats(userId) {
        await ready();
        const base = `user_id = $1 AND project_id IS NULL AND COALESCE(status, 'active') = 'active'`;
        const [total, byType, byImportance, byOrigin, last, pending] = await Promise.all([
            db().getOne(`SELECT COUNT(*)::int AS count FROM user_memories WHERE ${base}`, [userId]),
            db().getAll(`SELECT type, COUNT(*)::int AS count FROM user_memories WHERE ${base} GROUP BY type`, [userId]),
            db().getAll(`
                SELECT CASE WHEN importance >= 0.8 THEN 'high' WHEN importance >= 0.5 THEN 'medium' ELSE 'low' END AS level,
                       COUNT(*)::int AS count
                  FROM user_memories WHERE ${base} GROUP BY level`, [userId]),
            db().getAll(`SELECT COALESCE(origin, 'inferred') AS origin, COUNT(*)::int AS count FROM user_memories WHERE ${base} GROUP BY 1`, [userId]),
            db().getOne(`SELECT MAX(COALESCE(updated_at, created_at)) AS at FROM user_memories WHERE ${base}`, [userId]),
            db().getOne(`SELECT COUNT(*)::int AS count FROM user_memories WHERE user_id = $1 AND status = 'pending_review'`, [userId]),
        ]);
        const importanceDistribution = { high: 0, medium: 0, low: 0 };
        for (const r of byImportance) if (r.level in importanceDistribution) importanceDistribution[r.level] = r.count;
        const origins = { explicit: 0, inferred: 0, imported: 0, tool: 0 };
        for (const r of byOrigin) origins[r.origin] = r.count;
        return {
            total: total?.count || 0,
            typeDistribution: { labels: byType.map((r) => r.type), data: byType.map((r) => r.count) },
            importanceDistribution,
            lastUpdatedAt: iso(last?.at),
            pendingReview: pending?.count || 0,
            byOrigin: origins,
        };
    }

    return { listMemories, listActiveByIds, listRecent, listReview, getStats };
}

/** Bulk actions (retype, deletes) and the data-subject export. */
function makeBulk({ db, crypto, ready, lifecycle }, presentMemories) {
    /**
     * Change the type of rows (already authorised and hydrated by the caller).
     * The blind index covers type|subject|attribute, so it is recomputed for
     * rows that have a subject, or the canonical dedupe would no longer find
     * them. Bookkeeping rows (schedule_coverage) are never retyped.
     * @returns {Promise<number>} rows changed
     */
    async function setType(rows, type) {
        await ready();
        const { resolveWriteContext, keyHashForWrite } = crypto();
        const wctxs = new Map();
        let changed = 0;
        for (const row of rows) {
            if (row.type === 'schedule_coverage' || row.unreadable) continue;
            if (row.type === type) { changed++; continue; }
            let keyHash = null;
            if (row.subject && row.attribute) {
                const scope = `${row.user_id}|${row.project_id || ''}`;
                if (!wctxs.has(scope)) wctxs.set(scope, resolveWriteContext({ userId: row.user_id, projectId: row.project_id || null }));
                keyHash = keyHashForWrite({ type, subject: row.subject, attribute: row.attribute }, await wctxs.get(scope));
            }
            await db().run(
                'UPDATE user_memories SET type = $1, key_hash = COALESCE($2, key_hash), updated_at = NOW() WHERE id = $3',
                [type, keyHash, row.id]);
            changed++;
        }
        return changed;
    }

    /**
     * Delete the caller's OWN memories that came out of one conversation,
     * memory_sources included. Predecessors those memories replaced are
     * restored first (best effort), so deleting a chat does not also lose the
     * older fact it had corrected. Never touches another member's rows in a
     * shared project pool.
     * @returns {Promise<number>}
     */
    async function deleteByConversation(userId, conversationId) {
        await ready();
        const rows = await db().getAll(`
            SELECT id FROM user_memories
             WHERE user_id = $1
               AND (source_conversation_id = $2
                    OR id IN (SELECT memory_id FROM memory_sources WHERE conversation_id = $2))
        `, [userId, conversationId]);
        const ids = rows.map((r) => r.id);
        if (ids.length === 0) return 0;
        for (const id of ids) {
            try { await lifecycle().restorePredecessorOf(id); } catch (err) {
                log.warn(`[memoryQueries] predecessor of ${id} not restored: ${err.message}`);
            }
        }
        const res = await db().getOne(`
            WITH gone AS (DELETE FROM user_memories WHERE id = ANY($1::text[]) AND user_id = $2 RETURNING id),
                 src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
            SELECT COUNT(*)::int AS n FROM gone
        `, [ids, userId]);
        return res?.n || 0;
    }

    /**
     * Hard-delete every article-9 (sensitive) memory a person has, in every
     * status: what turning the sensitive opt-in off promises. memory_sources
     * go in the same statement.
     * @returns {Promise<number>}
     */
    async function deleteSensitiveForUser(userId) {
        await ready();
        const res = await db().getOne(`
            WITH gone AS (DELETE FROM user_memories WHERE user_id = $1 AND sensitivity = 'art9' RETURNING id),
                 src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
            SELECT COUNT(*)::int AS n FROM gone
        `, [userId]);
        return res?.n || 0;
    }

    /**
     * Hard-delete every art. 9 memory (any status) of every user in an org,
     * with its memory_sources rows, in one statement. For the moment the org
     * stops allowing sensitive memories. Returns the number removed.
     * @returns {Promise<number>}
     */
    async function deleteSensitiveForOrg(orgId) {
        if (!orgId) return 0;
        await ready();
        const res = await db().getOne(`
            WITH gone AS (DELETE FROM user_memories
                           WHERE sensitivity = 'art9' AND user_id IN (SELECT id FROM users WHERE "organizationId" = $1)
                       RETURNING id),
                 src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
            SELECT COUNT(*)::int AS n FROM gone
        `, [orgId]);
        return res?.n || 0;
    }

    /**
     * Ids of the members of an org (bounded), for per-member housekeeping such
     * as clearing the sensitive opt-in flags.
     * @returns {Promise<string[]>}
     */
    async function listOrgUserIds(orgId, cap = 50000) {
        if (!orgId) return [];
        await ready();
        const rows = await db().getAll(`SELECT id FROM users WHERE "organizationId" = $1 ORDER BY id LIMIT ${Math.max(1, Math.min(100000, Number(cap) || 50000))}`, [orgId]);
        return rows.map((r) => r.id);
    }

    /**
     * Everything Bee Flow holds about one person, for the data-subject export:
     * their own rows in every status (superseded history included), opened.
     */
    async function listForExport(userId) {
        await ready();
        const rows = await db().getAll(
            `SELECT * FROM user_memories WHERE user_id = $1 AND type <> 'schedule_coverage' ORDER BY created_at, id LIMIT ${EXPORT_CAP}`, [userId]);
        return presentMemories(await crypto().hydrateRows(rows, { keepUnreadable: true }));
    }

    return { setType, deleteByConversation, deleteSensitiveForUser, deleteSensitiveForOrg, listOrgUserIds, listForExport };
}

/**
 * @param {object} [deps]
 * @param {{run: Function, getOne: Function, getAll: Function}} [deps.db]
 * @param {Function} [deps.hydrateRows]
 * @param {Function} [deps.resolveWriteContext]
 * @param {Function} [deps.keyHashForWrite]
 * @param {Function} [deps.ensureReady]  awaited before every query (the store's initDB)
 * @param {() => any} [deps.lifecycle]   memoryLifecycle, resolved lazily
 */
function createMemoryQueries(deps = {}) {
    const db = () => deps.db || require('../db');
    const crypto = () => ({
        hydrateRows: deps.hydrateRows || require('./memoryCrypto').hydrateRows,
        resolveWriteContext: deps.resolveWriteContext || require('./memoryCrypto').resolveWriteContext,
        keyHashForWrite: deps.keyHashForWrite || require('./memoryCrypto').keyHashForWrite,
    });
    const ready = async () => { if (deps.ensureReady) await deps.ensureReady(); else await require('./memoryStore').initDB(); };
    const lifecycle = () => (deps.lifecycle ? deps.lifecycle() : require('./memoryLifecycle'));

    const c = { db, crypto, ready, lifecycle };
    const { presentMemories } = makeMemoryPresenter(db);
    return {
        presentMemories,
        ...makeListing(c, presentMemories),
        ...makeBulk(c, presentMemories),
    };
}

module.exports = Object.assign(createMemoryQueries(), {
    createMemoryQueries, LISTABLE_STATUSES, SORTS, SCOPES, PUBLIC_FIELDS,
});

/**
 * @typedef {{ db: () => any, crypto: () => any, ready: () => Promise<void>, lifecycle: () => any }} QueryDeps
 * @typedef {(rows: Array<Record<string, any>>) => Promise<any[]>} PresentMemories
 */
