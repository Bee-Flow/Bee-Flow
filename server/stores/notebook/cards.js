// @typecheck
/**
 * stores/notebook/cards.js — the notebook card listing's query and card shape
 * (overview grid and project listing); no database access. Split out of stores/notebookStore.js.
 */

// ── Card listing (overview grid) ───────────────────────────────────
// Separate from getNotebooks on purpose: the grid needs counts + cached
// preview but must NOT ship document bodies (up to 200 full documents per
// list call), while notebookCascade.js still relies on
// getNotebooks/mapNotebookRow returning them.

// Single source of truth for the card-list page cap. The route clamps to this
// too, so `hasMore` (length === limit) stays truthful — a route cap above the
// store cap silently truncated 201-500 requests with hasMore:false.
const MAX_CARD_LIMIT = 200;

// Whitelist maps — sort/filter input is looked up here, NEVER interpolated.
const CARD_SORTS = {
    activity: `COALESCE(n.last_activity_at, n.updated_at) DESC`,
    name: `LOWER(n.name) ASC`,
    created: `n.created_at DESC`,
    words: `(n.doc_word_count + (SELECT COALESCE(SUM(ns.word_count),0) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'ready')) DESC`,
};
const CARD_FILTERS = {
    all: null,
    pinned: `n.pinned_at IS NOT NULL`,
    sources: `(SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) > 0`,
    chat: `COALESCE((SELECT nc.message_count FROM notebook_conversations nc WHERE nc.notebook_id = n.id AND nc.user_id = n.user_id), 0) > 0`,
    empty: `(SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) = 0 AND n.doc_word_count = 0`,
    processing: `(SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'processing') > 0`,
};

/**
 * Pure query builder for the card listing (exported for unit tests).
 * @returns {{sql: string, params: any[]}}
 */
function buildListCardsQuery(userId, { limit = 50, offset = 0, type = 'notebook', search = '', sort = 'activity', filter = 'all' } = {}) {
    const params = [userId, type];
    let sql = `SELECT n.id, n.name, n.description, n.type, n.version, n.preview, n.doc_word_count,
            n.pinned_at, n.last_activity_at, n.last_activity_kind, n.last_edited_by, n.last_edited_at,
            n.created_at, n.updated_at,
            (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count,
            (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'processing') AS processing_count,
            (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'error') AS failed_count,
            (SELECT COALESCE(SUM(ns.word_count),0) FROM notebook_sources ns WHERE ns.notebook_id = n.id AND ns.status = 'ready') AS source_word_count,
            COALESCE((SELECT nc.message_count FROM notebook_conversations nc WHERE nc.notebook_id = n.id AND nc.user_id = n.user_id), 0) AS message_count
        FROM notebooks n
        WHERE n.user_id = $1 AND n.type = $2`;
    const q = String(search || '').trim();
    if (q) {
        // ILIKE wildcards in user input must match literally.
        params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
        const s = `$${params.length}`;
        sql += ` AND (n.name ILIKE ${s} ESCAPE '\\' OR n.description ILIKE ${s} ESCAPE '\\'`
            + ` OR n.document_md ILIKE ${s} ESCAPE '\\'`
            + ` OR EXISTS (SELECT 1 FROM notebook_sources ns2 WHERE ns2.notebook_id = n.id AND ns2.name ILIKE ${s} ESCAPE '\\'))`;
    }
    const filterSql = CARD_FILTERS[filter] || null;
    if (filterSql) sql += ` AND ${filterSql}`;
    sql += ` ORDER BY n.pinned_at DESC NULLS LAST, ${CARD_SORTS[sort] || CARD_SORTS.activity}`;
    params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_CARD_LIMIT), Math.max(parseInt(offset, 10) || 0, 0));
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    return { sql, params };
}

function mapNotebookCardRow(r) {
    return {
        id: r.id,
        name: r.name,
        description: r.description || '',
        type: r.type || 'notebook',
        // null = standalone (owner-only, today's behaviour); set = filed into a
        // project, and readable by its members.
        projectId: r.project_id || null,
        organizationId: r.organization_id || null,
        version: typeof r.version === 'number' ? r.version : (parseInt(r.version) || 0),
        sourceCount: parseInt(r.source_count) || 0,
        processingCount: parseInt(r.processing_count) || 0,
        failedCount: parseInt(r.failed_count) || 0,
        sourceWordCount: parseInt(r.source_word_count) || 0,
        docWordCount: parseInt(r.doc_word_count) || 0,
        messageCount: parseInt(r.message_count) || 0,
        preview: r.preview || '',
        pinned: !!r.pinned_at,
        pinnedAt: r.pinned_at ? new Date(r.pinned_at).toISOString() : null,
        lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
        lastActivityKind: r.last_activity_kind || null,
        // Who last changed the document (an id; the reader resolves the name).
        lastEditedBy: r.last_edited_by || null,
        lastEditedAt: r.last_edited_at ? new Date(r.last_edited_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = { MAX_CARD_LIMIT, buildListCardsQuery, mapNotebookCardRow };
