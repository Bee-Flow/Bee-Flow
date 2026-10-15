// @typecheck
'use strict';
/** The allow-list presentation of memory rows for the API (see memoryQueries.js). */

const log = require('../telemetry/log');

/** What a client may see of a row: the contract fields plus the legacy ones mobile reads. */
const PUBLIC_FIELDS = Object.freeze([
    'id', 'type', 'content', 'summary', 'importance', 'origin', 'sensitivity', 'status',
    'agent_id', 'project_id', 'source_conversation_id',
    'created_at', 'updated_at', 'valid_from', 'valid_to', 'last_used_at', 'use_count',
    // legacy, still read by the mobile client and the project tab
    'user_id', 'subject', 'attribute', 'value', 'confidence', 'access_count',
    'last_accessed_at', 'last_confirmed_at', 'archived_at', 'superseded_by',
    'unreadable',
]);

/** ORDER BY for a sort, with a stable tie-break. */

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/**
 * @param {() => {getAll: Function, getOne: Function}} db  resolved lazily
 * @returns {{ presentMemories: (rows: Array<Record<string, any>>) => Promise<any[]> }}
 */
function makeMemoryPresenter(db) {
    /**
     * Names and chat kinds for a page of rows: four batched lookups, never one
     * per row. A lookup that fails (table missing on a fresh install) only
     * costs the enrichment.
     */
    async function lookups(rows) {
        const uniq = (xs) => [...new Set(xs.filter(Boolean))];
        const agentIds = uniq(rows.map((r) => r.agent_id));
        const projectIds = uniq(rows.map((r) => r.project_id));
        const convIds = uniq(rows.map((r) => r.source_conversation_id));
        const authorIds = uniq(rows.filter((r) => r.project_id).map((r) => r.user_id));
        const safe = async (ids, sql) => {
            if (ids.length === 0) return [];
            try { return await db().getAll(sql, [ids]); } catch (err) {
                log.warn('[memoryQueries] enrichment lookup failed:', err.message);
                return [];
            }
        };
        const [agents, projects, agentConvs, directConvs, authors] = await Promise.all([
            safe(agentIds, 'SELECT id, name FROM agents WHERE id = ANY($1::text[])'),
            safe(projectIds, 'SELECT id, name FROM projects WHERE id = ANY($1::text[])'),
            safe(convIds, 'SELECT id FROM agent_conversations WHERE id = ANY($1::text[])'),
            safe(convIds, 'SELECT id FROM direct_conversations WHERE id = ANY($1::text[])'),
            safe(authorIds, 'SELECT id, "displayName", username FROM users WHERE id = ANY($1::text[])'),
        ]);
        return {
            agent: new Map(agents.map((a) => [a.id, a.name])),
            project: new Map(projects.map((p) => [p.id, p.name])),
            agentConv: new Set(agentConvs.map((c) => c.id)),
            directConv: new Set(directConvs.map((c) => c.id)),
            author: new Map(authors.map((u) => [u.id, u])),
        };
    }

    /**
     * Hydrated rows → the Memory objects of the API contract.
     * @param {Array<Record<string, any>>} rows  already hydrated
     */
    async function presentMemories(rows) {
        if (!rows || rows.length === 0) return [];
        const l = await lookups(rows);
        return rows.map((r) => {
            /** @type {Record<string, any>} */
            const out = {};
            for (const f of PUBLIC_FIELDS) if (r[f] !== undefined) out[f] = r[f];
            for (const f of ['created_at', 'updated_at', 'valid_from', 'valid_to', 'last_used_at', 'archived_at', 'last_confirmed_at', 'last_accessed_at']) {
                if (f in out) out[f] = iso(out[f]);
            }
            out.summary = r.summary ?? null;
            out.importance = Number(r.importance ?? 0.5);
            out.origin = r.origin || 'inferred';
            out.sensitivity = r.sensitivity || 'none';
            out.status = r.status || 'active';
            out.use_count = Number(r.use_count) || 0;
            out.agent_id = r.agent_id ?? null;
            out.project_id = r.project_id ?? null;
            out.agent_name = r.agent_id ? (l.agent.get(r.agent_id) ?? null) : null;
            out.project_name = r.project_id ? (l.project.get(r.project_id) ?? null) : null;
            out.source_conversation_id = r.source_conversation_id ?? null;
            const c = r.source_conversation_id;
            out.source_conversation_kind = !c ? null : l.agentConv.has(c) ? 'agent' : l.directConv.has(c) ? 'direct' : null;
            out.valid_from = iso(r.valid_from);
            out.last_used_at = iso(r.last_used_at);
            if (r.project_id) {
                const u = l.author.get(r.user_id);
                out.created_by_name = u ? (u.displayName || u.username || null) : null;
                out.created_by_username = u?.username ?? null;
            }
            return out;
        });
    }

    return { presentMemories };
}

module.exports = { makeMemoryPresenter, PUBLIC_FIELDS, iso };
