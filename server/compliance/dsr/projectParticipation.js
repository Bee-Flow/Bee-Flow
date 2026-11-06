// @typecheck strict
/**
 * DSR discovery, source 7: where the subject takes part in the organisation's collaborative
 * projects, as counts by user id. Split out of discovery.js, which re-exports the SQL table.
 */

'use strict';

// Where a person takes part in the org's collaborative projects. One small
// count each, pinned to the org the way every project check scopes (an
// org-less project belongs to the 'default' bucket).
const PROJECT_ORG = `COALESCE(NULLIF(p.organization_id, ''), 'default') = $1`;
/** @type {Readonly<Record<string, string>>} */
const PROJECT_PARTICIPATION_SQL = Object.freeze({
    memberships: `SELECT COUNT(*)::int AS n FROM project_shares s JOIN projects p ON p.id = s.project_id
                  WHERE ${PROJECT_ORG} AND s.shared_with_type = 'user' AND s.shared_with_id = $2`,
    owned_projects: `SELECT COUNT(*)::int AS n FROM projects p WHERE ${PROJECT_ORG} AND p.owner_id = $2`,
    shared_chats: `SELECT ((SELECT COUNT(*) FROM direct_conversations c JOIN projects p ON p.id = c.project_id
                            WHERE ${PROJECT_ORG} AND c.user_id = $2 AND c.shared_scope = 'project')
                         + (SELECT COUNT(*) FROM agent_conversations c JOIN projects p ON p.id = c.project_id
                            WHERE ${PROJECT_ORG} AND c.user_id = $2 AND c.shared_scope = 'project'))::int AS n`,
    project_notebooks: `SELECT COUNT(*)::int AS n FROM notebooks n JOIN projects p ON p.id = n.project_id
                        WHERE ${PROJECT_ORG} AND n.user_id = $2`,
    project_documents: `SELECT COUNT(*)::int AS n FROM studio_documents d JOIN projects p ON p.id = d.project_id
                        WHERE ${PROJECT_ORG} AND d.user_id = $2`,
    // Comments they wrote on project notebooks and documents (sealed with the
    // project key, so counted by author id, never read). An erased comment is
    // blanked but keeps its author id, so it still counts.
    project_comments: `SELECT COUNT(*)::int AS n FROM project_comments c JOIN projects p ON p.id = c.project_id
                       WHERE ${PROJECT_ORG} AND c.author_user_id = $2`,
    // Suggestions on documents made in their name (sealed, counted by id).
    document_suggestions: `SELECT COUNT(*)::int AS n FROM document_suggestions s
                           WHERE COALESCE(NULLIF(s.organization_id, ''), 'default') = $1 AND s.author_user_id = $2`,
});

/**
 * The subject's place in the org's collaborative projects, as counts by user
 * id. A table this install does not have is a true zero (nobody can be in
 * it); a count that FAILS is unknown (null), and so is the total.
 * @param {string} orgId
 * @param {string | null | undefined} userId
 * @param {{ db?: { getOne?: (sql: string, params?: unknown[]) => Promise<Record<string, any> | null | undefined> } | null }} deps
 * @returns {Promise<{ count: number | null, items: { kind: string, count: number | null }[] }>}
 */
async function scanProjectParticipation(orgId, userId, deps) {
    /** @type {{ kind: string, count: number | null }[]} */
    const items = Object.keys(PROJECT_PARTICIPATION_SQL).map(kind => ({ kind, count: 0 }));
    if (!userId) return { count: 0, items };
    if (!deps.db?.getOne) return { count: null, items: items.map(i => ({ ...i, count: /** @type {number | null} */ (null) })) };
    let unknown = false;
    for (const item of items) {
        try {
            const row = await deps.db.getOne(PROJECT_PARTICIPATION_SQL[item.kind], [orgId, userId]);
            item.count = Number(row?.n) || 0;
        } catch (e) {
            if (e && (e.code === '42P01' || e.code === '42703')) continue;
            item.count = null;
            unknown = true;
        }
    }
    return { count: unknown ? null : items.reduce((n, i) => n + (i.count ?? 0), 0), items };
}

module.exports = { PROJECT_PARTICIPATION_SQL, scanProjectParticipation };
