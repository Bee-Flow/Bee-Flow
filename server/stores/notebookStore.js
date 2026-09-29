// @typecheck
/**
 * Notebook Store — PostgreSQL-backed notebook management.
 *
 * Three tables:
 *   • notebooks          — top-level notebook (name, instructions, KB links, settings)
 *   • notebook_sources   — individual sources within a notebook (PDF, DOCX, URL, text, etc.)
 *   • notebook_versions  — immutable content snapshots for version history
 *
 * Backwards-compatible: existing `word_templates` rows are migrated into notebooks on first access.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl, CODES } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');
const { tryHtmlToMarkdown, looksLikeHtml } = require('../core/markdown');
const { sanitizeDocumentHtml, htmlToPlainText } = require('../utils/htmlSanitizer');
const { countWords, stripMarkdownLite } = require('../utils/text');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');

const initDB = makeStoreInit('NotebookStore', _initDB);

async function _initDB() {

    // ── Notebooks table ──────────────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS notebooks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Notebook',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb,
            document_content TEXT DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(user_id);
        CREATE INDEX IF NOT EXISTS idx_notebooks_created ON notebooks(created_at DESC);
    `);

    // Kolommigraties via runDdl (stores/lib/_ddl.js): fouten per statement
    // luid verzameld i.p.v. stil ingeslikt — één catch om vier statements
    // verhulde bovendien wélke van de vier faalde.
    await runDdl('notebookStore', [
        // Migration: add document_content column if table already exists
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS document_content TEXT DEFAULT ''`,
        // Migration: add type column for proposals support
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'notebook'`,
        // Migration: canonical Markdown mirror + per-row source-of-truth format flag
        // (for the new editor's token-efficient AI path; document_content stays the
        // HTML mirror so export + the TipTap fallback keep working unchanged).
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS document_md TEXT DEFAULT NULL`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS document_format TEXT DEFAULT 'html'`,
        // Migration: optimistic-concurrency version counter. Bumped on every content
        // write; lets a caller pass `expectedVersion` to detect a lost-update race
        // (two tabs, or a tool-write vs a user autosave). Callers that don't pass it
        // keep today's last-writer-wins behaviour — the column is purely additive.
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`,
        // Migration: project membership.
        //
        // Notebooks were single-owner with no sharing mechanism at all — no
        // project_id and, unusually for this codebase, no organization_id either.
        // A NULL project_id keeps today's behaviour exactly (standalone, owner-only);
        // a set one means "this notebook belongs to a project", and access resolves
        // through project membership on top of ownership.
        //
        // organization_id is added alongside because without it the cross-tenant
        // guard other resources apply cannot be applied here — an owner could file a
        // notebook into a foreign-org project and there would be nothing to compare.
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS organization_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_notebooks_project ON notebooks(project_id)
            WHERE project_id IS NOT NULL`,
        // Soft reference, mirroring direct_conversations.project_id: a hard FK
        // would couple store-init ordering, and deleting a project must detach
        // its notebooks rather than delete them.
        {
            sql: `UPDATE notebooks SET project_id = NULL
                WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`,
            tolerate: CODES.UNDEFINED_TABLE,
            reden: 'projects table may not exist yet on a cold boot',
        },
        // Backfill organization_id from each owner. Cheap and idempotent — only
        // touches rows that have not been stamped yet.
        {
            sql: `UPDATE notebooks n SET organization_id = u."organizationId"
                    FROM users u
                   WHERE n.user_id = u.id AND n.organization_id IS NULL`,
            tolerate: [CODES.UNDEFINED_TABLE, CODES.UNDEFINED_COLUMN],
            reden: 'users table shape differs on some installs; non-fatal',
        },
        // Migration: PII token map (the {token → real value} dictionary the Privacy
        // Shield builds while tokenizing this notebook's chat/document/sources for
        // the LLM). Persisting it here lets dlpRunner restore `[person_1]` → real
        // values on reload / after a restart. dlpRunner reads & write-throughs this
        // column directly (keyed by notebook id), the same way it does for
        // agent_conversations / direct_conversations.
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS pii_token_map JSONB`,
        // Migration: card-overview metadata — pin flag, cached preview + document
        // word count (derived at write time so list calls never load bodies), and
        // the last-activity signal the grid sorts on.
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ DEFAULT NULL`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS preview TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS doc_word_count INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NULL`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS last_activity_kind TEXT DEFAULT NULL`,
    ]);

    // ── Notebook Sources table ───────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS notebook_sources (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            type TEXT NOT NULL DEFAULT 'text',
            name TEXT NOT NULL DEFAULT 'Untitled',
            storage_key TEXT,
            file_name TEXT,
            metadata JSONB DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'processing',
            error TEXT,
            word_count INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON notebook_sources(notebook_id);
        -- V2 source improvements: manual ordering, ingestion stage, and stored
        -- original text so pasted-text / meeting sources become retryable.
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS stage TEXT;
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS content_text TEXT;
    `);

    // One-off backfill: meeting-note sources were stored as generic 'text'
    // (wrong icon, not retryable). Reclassify by their canonical name prefix —
    // idempotent, so safe to run on every boot.
    await runDdl('notebookStore', [
        `UPDATE notebook_sources SET type = 'meeting' WHERE type = 'text' AND name LIKE 'Meeting Note: %'`,
    ]);

    // ── Notebook Versions table (immutable content snapshots) ────────
    await exec(`
        CREATE TABLE IF NOT EXISTS notebook_versions (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            content TEXT NOT NULL DEFAULT '',
            summary TEXT DEFAULT '',
            content_length INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notebook_versions_notebook ON notebook_versions(notebook_id, created_at DESC);
    `);
    log.info('[NotebookStore] PostgreSQL initialized');
}

// ── Notebook CRUD ──────────────────────────────────────────────────

async function createNotebook({ userId, name, description, instructions, knowledgeBaseIds, settings, type }) {
    await initDB();
    const id = crypto.randomUUID();
    const notebookType = type || 'notebook';
    await run(
        `INSERT INTO notebooks (id, user_id, name, description, instructions, knowledge_base_ids, settings, document_content, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, name || 'Untitled Notebook', description || '', instructions || '',
         JSON.stringify(knowledgeBaseIds || []), JSON.stringify(settings || {}), '', notebookType]
    );
    log.info(`[NotebookStore] Created ${notebookType} "${name}" for user ${userId}`);
    return {
        id, userId, name: name || 'Untitled Notebook', description: description || '',
        instructions: instructions || '', knowledgeBaseIds: knowledgeBaseIds || [],
        settings: settings || {}, documentContent: '', type: notebookType,
        createdAt: new Date().toISOString()
    };
}

/**
 * @param userId
 * @param {{ limit?: number, offset?: number, type?: string }} [opts]
 */
async function getNotebooks(userId, { limit = 50, offset = 0, type } = {}) {
    await initDB();
    // Correlated subquery — see getNotebook. The grouped-join form aggregated
    // every tenant's sources on each listing; this counts only the rows of the
    // notebooks actually returned.
    let query = `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
         FROM notebooks n
         WHERE n.user_id = $1`;
    const params = [userId];
    if (type) {
        query += ` AND n.type = $${params.length + 1}`;
        params.push(type);
    }
    query += ` ORDER BY n.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const rows = await getAll(query, params);
    return rows.map(mapNotebookRow);
}

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
            n.pinned_at, n.last_activity_at, n.last_activity_kind, n.created_at, n.updated_at,
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
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

async function listNotebookCards(userId, opts = {}) {
    await initDB();
    const { sql, params } = buildListCardsQuery(userId, opts);
    const rows = await getAll(sql, params);
    return rows.map(mapNotebookCardRow);
}

/**
 * The user's role on a notebook: 'owner' | 'editor' | 'viewer' | null.
 *
 * Ownership first, then project membership. Deliberately resolved HERE rather
 * than at each of the ~80 `notebookStore.*` call sites across notebooks.js,
 * notebookChat.js and notebookExport.js — changing every
 * signature to thread a role through was not viable, and spreading the policy
 * across four route files would guarantee the surfaces drift.
 */
async function resolveNotebookRole(id, userId) {
    if (!id || !userId) return null;
    const row = await getOne('SELECT user_id, project_id FROM notebooks WHERE id = $1', [id]);
    if (!row) return null;
    if (row.user_id === userId) return 'owner';
    if (!row.project_id) return null;          // standalone: owner-only, as before
    const { getProjectRole } = require('../auth/projectAccess');
    return await getProjectRole(userId, row.project_id);
}

/**
 * Read a notebook the user may see: their own, or one shared through a project.
 *
 * The predicate widens rather than the signature, so every existing caller
 * keeps working unchanged. A standalone notebook (project_id IS NULL) is still
 * strictly owner-only — project access is additive, never a downgrade of the
 * private case.
 */
async function getNotebook(id, userId) {
    await initDB();
    // Correlated subquery, not a LEFT JOIN over a grouped derived table: the
    // outer `n.id = $1` cannot be pushed through a GROUP BY, so the join form
    // aggregated the ENTIRE notebook_sources table — every tenant's rows — just
    // to count one notebook's sources.
    const r = await getOne(
        `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
         FROM notebooks n
         WHERE n.id = $1 AND n.user_id = $2`,
        [id, userId]
    );
    if (r) return mapNotebookRow(r);

    // Not theirs — it may still be a project notebook they can read. Kept as a
    // second query so the overwhelmingly common owner path stays a single
    // index lookup with no join.
    const role = await resolveNotebookRole(id, userId);
    if (!role) return null;
    const shared = await getOne(
        `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
         FROM notebooks n
         WHERE n.id = $1`,
        [id]
    );
    if (!shared) return null;
    return { ...mapNotebookRow(shared), projectRole: role };
}

const NOTEBOOK_COLUMNS = {
    name: 'name',
    description: 'description',
    instructions: 'instructions',
    knowledgeBaseIds: { col: 'knowledge_base_ids', transform: v => JSON.stringify(v) },
    settings: { col: 'settings', transform: v => JSON.stringify(v) },
    documentContent: 'document_content',
    documentMd: 'document_md',
    documentFormat: 'document_format',
    preview: 'preview',
    docWordCount: 'doc_word_count',
};

async function _updateNotebook(id, userId, updates) {
    await initDB();
    const write = {
        name: updates.name,
        description: updates.description,
        instructions: updates.instructions,
        knowledgeBaseIds: updates.knowledgeBaseIds,
        settings: updates.settings,
    };
    let contentChanged = false;
    if (updates.documentContent !== undefined) {
        contentChanged = true;
        // Sanitize at the single choke point every content write funnels
        // through — the PUT route, AI tool writes AND version restore — so
        // hostile markup never reaches the row or the mirror/preview below.
        const docContent = (updates.documentContent && looksLikeHtml(updates.documentContent))
            ? sanitizeDocumentHtml(updates.documentContent)
            : updates.documentContent;
        write.documentContent = docContent;
        // Keep the canonical Markdown mirror fresh. Three cases, in order:
        //
        //  1. The caller supplied documentMd — trust it (the Markdown-native
        //     callers do this, and they know better than we can infer).
        //  2. documentContent isn't HTML — it IS Markdown. Mirror it verbatim.
        //     Running htmlToMarkdown over Markdown escapes and flattens it
        //     ('# Title' → '\# Title', hard breaks collapsed), which corrupted
        //     the mirror the AI tools read and prefer.
        //  3. It is HTML — derive. If derivation FAILS, leave the existing
        //     mirror alone rather than persisting the lenient converter's '',
        //     which would read downstream as an emptied document. The content
        //     itself is still saved either way; losing the user's edit would be
        //     far worse than a stale mirror.
        let md = updates.documentMd;
        let derivedFormat;
        if (md === undefined) {
            const body = docContent;
            const isEmpty = !body || !String(body).trim();
            if (isEmpty) {
                md = body || '';                       // don't reclassify an emptied doc
            } else if (!looksLikeHtml(body)) {
                md = body;
                derivedFormat = 'markdown';
            } else {
                const r = tryHtmlToMarkdown(body);
                if (r.ok) { md = r.md; derivedFormat = 'html'; }
                else {
                    md = undefined;
                    log.warn(`[NotebookStore] document_md derivation failed for ${id} — content saved, mirror left unchanged: ${r.error && r.error.message}`);
                }
            }
        }
        write.documentMd = md;
        if (updates.documentFormat === undefined) write.documentFormat = derivedFormat;
        // Cached card fields: 300-char excerpt + a word count that matches the
        // editor's (empty → 0), derived once here so the list path never has
        // to load or parse document bodies.
        const plain = !String(docContent || '').trim() ? ''
            : looksLikeHtml(docContent) ? htmlToPlainText(docContent)
            : stripMarkdownLite(md !== undefined ? md : docContent);
        write.preview = plain.slice(0, 300);
        write.docWordCount = countWords(plain);
    }
    if (updates.documentFormat !== undefined) write.documentFormat = updates.documentFormat;

    const built = buildUpdate({ table: 'notebooks', updates: write, columnMap: NOTEBOOK_COLUMNS });
    const params = built ? built.params : [];
    // The clauses the builder cannot express: activity stamps, the version
    // bump and the pin, all of them verbatim SQL over the stored row.
    const setClauses = [];
    let idx = params.length + 1;
    if (contentChanged) setClauses.push(`last_activity_at = NOW()`, `last_activity_kind = 'edit'`);
    // Pin/unpin is a non-content clause: no version bump, no activity signal,
    // so pinning never masquerades as an edit.
    const clausesBeforePin = (built ? 1 : 0) + setClauses.length;
    if (updates.pinned !== undefined) {
        setClauses.push(updates.pinned ? `pinned_at = NOW()` : `pinned_at = NULL`);
    }

    if (!built && setClauses.length === 0) return { ok: false, conflict: false, noop: true };
    // Bump the version on any content-bearing write so a CAS caller can detect a
    // concurrent change.
    if (contentChanged) setClauses.push(`version = version + 1`);
    // A pin-only write must not bump updated_at either: legacy rows (NULL
    // last_activity_at) fall back to updated_at for recency, so pinning would
    // show "just now" and re-sort the cards.
    const pinOnly = updates.pinned !== undefined && clausesBeforePin === 0;
    if (!pinOnly) setClauses.push(`updated_at = NOW()`);
    // Write predicate: the owner, OR a project EDITOR (not a viewer — a
    // read-only member must not be able to rewrite a shared notebook's
    // document). `$${idx}` is the caller; the project clause is added only when
    // they actually hold editor, so the common owner-only path is unchanged.
    params.push(id, userId);
    const writerRole = await resolveNotebookRole(id, userId);
    const projectWriter = writerRole === 'editor' || writerRole === 'owner';
    let where = projectWriter
        ? `id = $${idx++} AND (user_id = $${idx++} OR project_id IS NOT NULL)`
        : `id = $${idx++} AND user_id = $${idx++}`;
    // Optimistic concurrency: when the caller passes the version it last read,
    // refuse the write if the row moved underneath it (lost-update guard).
    if (typeof updates.expectedVersion === 'number') {
        where += ` AND version = $${idx++}`;
        params.push(updates.expectedVersion);
    }
    const setSql = (built ? `${built.sql}, ` : 'UPDATE notebooks SET ') + setClauses.join(', ');
    const { rowCount, rows } = await run(
        `${setSql} WHERE ${where} RETURNING version`,
        params
    );
    if (rowCount > 0) return { ok: true, conflict: false, version: rows && rows[0] ? rows[0].version : undefined };
    if (typeof updates.expectedVersion !== 'number') return { ok: false, conflict: false };
    // rowCount 0 with a version predicate is ambiguous: either the row moved
    // under us (conflict) or it isn't ours at all (not found). Re-read to tell
    // them apart, so a caller can retry a conflict but must not retry a 404.
    const still = await getOne('SELECT version FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    return { ok: false, conflict: !!still };
}

/**
 * Update a notebook. Returns a plain BOOLEAN.
 *
 * This used to return `{ ok: false, conflict: true }` on a CAS conflict — an
 * OBJECT, which is truthy, so every caller written as `if (!ok)` read a
 * rejected write as a success. Callers that need to tell a conflict from a
 * missing notebook use updateNotebookCas() below instead.
 */
async function updateNotebook(id, userId, updates = {}) {
    const r = await _updateNotebook(id, userId, updates);
    return r.ok;
}

/**
 * Update a notebook, reporting WHY a write failed.
 * @returns {Promise<{ok: boolean, conflict: boolean, noop?: boolean, version?: number}>}
 *   — `conflict` is true only when `expectedVersion` was supplied and the row
 *   moved underneath the caller; `noop` marks a 0-clause call (nothing to
 *   write, so a route can 400 instead of 404); `version` is the row's version
 *   after a successful write (the CAS counter clients resync on).
 */
async function updateNotebookCas(id, userId, updates = {}) {
    return _updateNotebook(id, userId, updates);
}

/**
 * Attach an auto-created knowledge base, but only if the notebook has none yet.
 *
 * Resolves the first-ingest race: two sources uploaded together both saw an
 * empty `knowledge_base_ids`, both created a KB, and the second write clobbered
 * the first — leaving an orphaned KB whose source was silently unsearchable
 * forever (it reported "ready" and simply never matched a query).
 *
 * The emptiness test lives in the WHERE clause, so the database decides the
 * winner. Deliberately NOT a pg advisory lock: those are per-connection and
 * this store runs over a pool, so lock and unlock could land on different
 * sessions.
 *
 * @returns {Promise<string>} the kb id that is actually attached — the caller's
 *   own id if it won, otherwise the winner's (the caller should then discard
 *   the KB it created).
 */
async function attachKnowledgeBaseIfAbsent(id, userId, kbId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE notebooks
            SET knowledge_base_ids = $1, updated_at = NOW()
          WHERE id = $2 AND user_id = $3
            AND (knowledge_base_ids IS NULL
                 OR knowledge_base_ids = '[]'::jsonb
                 OR jsonb_array_length(knowledge_base_ids) = 0)`,
        [JSON.stringify([kbId]), id, userId]
    );
    if (rowCount > 0) return kbId;
    const row = await getOne('SELECT knowledge_base_ids FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    const existing = parseJSON(row && row.knowledge_base_ids, []);
    return existing[0] || kbId;
}

/**
 * Delete stays OWNER-ONLY, deliberately, even for a project notebook.
 *
 * Reading and editing are the collaboration; destroying a colleague's work is
 * not something "editor on the project" should buy. A project owner who needs a
 * notebook gone can ask, or remove it from the project. This mirrors the same
 * choice made for shared conversations — members post into them, only the owner
 * renames or deletes.
 */
async function deleteNotebook(id, userId) {
    await initDB();
    // Sources cascade-delete via FK.  Return notebook for caller to clean up KBs/storage.
    const r = await getOne('SELECT * FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return null;
    await run('DELETE FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    return mapNotebookRow(r);
}

// ── Project membership ──────────────────────────────────────────────

/**
 * File a notebook into a project, or take it out again (projectId = null).
 *
 * Owner-only: moving a notebook into a project exposes its contents to every
 * member, which is the owner's call to make. The caller is responsible for
 * checking the user has a role on the target project — this only enforces that
 * the notebook is theirs.
 */
async function setNotebookProject(id, userId, projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE notebooks SET project_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [projectId || null, id, userId]
    );
    return rowCount > 0;
}

/** Notebooks filed into a project. Card-shaped, so lists never load bodies. */
async function listProjectNotebooks(projectId, { limit = 50, offset = 0, type = 'notebook' } = {}) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT n.*,
                (SELECT COUNT(*) FROM notebook_sources ns WHERE ns.notebook_id = n.id) AS source_count
           FROM notebooks n
          WHERE n.project_id = $1 AND COALESCE(n.type, 'notebook') = $2
          ORDER BY COALESCE(n.last_activity_at, n.updated_at) DESC
          LIMIT $3 OFFSET $4`,
        [projectId, type, Math.min(Math.max(1, limit), 200), Math.max(0, offset)]
    );
    return rows.map(mapNotebookRow);
}

/**
 * How many notebooks each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectNotebooks(projectIds, { type = 'notebook' } = {}) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM notebooks
          WHERE project_id = ANY($1) AND COALESCE(type, 'notebook') = $2
          GROUP BY project_id`,
        [ids, type]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * Detach every notebook from a deleted project.
 *
 * project_id is a soft reference (no FK), so nothing clears it automatically.
 * Deleting a project must NOT delete its members' notebooks — they revert to
 * standalone, owned by whoever made them.
 */
async function clearProjectFromNotebooks(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE notebooks SET project_id = NULL WHERE project_id = $1',
        [projectId]
    );
    return rowCount;
}

// ── Source CRUD ─────────────────────────────────────────────────────

async function addSource({ notebookId, type, name, storageKey, fileName, metadata, wordCount, contentText, stage }) {
    await initDB();
    const id = crypto.randomUUID();
    // Append to the end of the manual order.
    const ord = await getOne('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM notebook_sources WHERE notebook_id = $1', [notebookId]);
    const sortOrder = ord?.next ?? 0;
    await run(
        `INSERT INTO notebook_sources (id, notebook_id, type, name, storage_key, file_name, metadata, status, word_count, content_text, stage, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9, $10, $11)`,
        [id, notebookId, type, name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0, contentText || null, stage || 'queued', sortOrder]
    );
    await touchActivity(notebookId, 'source');
    return { id, notebookId, type, name, storageKey, fileName, metadata: metadata || {}, status: 'processing', stage: stage || 'queued', wordCount: wordCount || 0, sortOrder };
}

async function getSources(notebookId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM notebook_sources WHERE notebook_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [notebookId]
    );
    return rows.map(mapSourceRow);
}

/** Full extracted text of a source (for the preview panel + text/meeting retry). */
async function getSourceContent(id) {
    await initDB();
    const r = await getOne('SELECT content_text FROM notebook_sources WHERE id = $1', [id]);
    return r ? (r.content_text || '') : null;
}

/** Persist a manual ordering (array of source ids in the desired order). */
async function reorderSources(notebookId, orderedIds) {
    await initDB();
    let i = 0;
    for (const sid of orderedIds) {
        await run('UPDATE notebook_sources SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND notebook_id = $3', [i++, sid, notebookId]);
    }
    return true;
}

async function getSource(id) {
    await initDB();
    const r = await getOne('SELECT * FROM notebook_sources WHERE id = $1', [id]);
    return r ? mapSourceRow(r) : null;
}

const SOURCE_COLUMNS = {
    status: 'status',
    error: 'error',
    wordCount: 'word_count',
    metadata: { col: 'metadata', transform: v => JSON.stringify(v) },
    name: 'name',
    stage: 'stage',
    contentText: 'content_text',
    sortOrder: 'sort_order',
};

async function updateSource(id, updates) {
    await initDB();
    const built = buildUpdate({
        table: 'notebook_sources',
        updates,
        columnMap: SOURCE_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

// Delete a source. When `notebookId` is supplied the lookup + delete are scoped
// to that notebook so a caller can't remove another tenant's source by guessing
// its id (defense in depth behind the route's ownership check). `notebook_sources`
// carries no user_id of its own, so the parent notebook is the only ownership
// anchor — always pass it from a route.
async function deleteSource(id, notebookId = null) {
    await initDB();
    const r = notebookId
        ? await getOne('SELECT * FROM notebook_sources WHERE id = $1 AND notebook_id = $2', [id, notebookId])
        : await getOne('SELECT * FROM notebook_sources WHERE id = $1', [id]);
    if (!r) return null;
    await run('DELETE FROM notebook_sources WHERE id = $1', [r.id]);
    await touchActivity(r.notebook_id, 'source');
    return mapSourceRow(r);
}

/**
 * Record notebook activity (source add/remove, chat turn). Deliberately NOT
 * called from updateSource — ingestion stage churn would spam recency.
 */
async function touchActivity(notebookId, kind) {
    await initDB();
    await run(
        `UPDATE notebooks SET updated_at = NOW(), last_activity_at = NOW(), last_activity_kind = $2 WHERE id = $1`,
        [notebookId, kind]
    );
}

/**
 * Watchdog: flip any `processing` source older than the given timeout to `error`
 * with a generic "timed out" message. Called opportunistically on list-sources so
 * users never see a yellow row stuck forever after an ingestion worker dies.
 *
 * Returns the number of rows transitioned so callers can decide whether to log.
 */
async function timeoutStuckSources(notebookId, { stuckMinutes = 10 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE notebook_sources
            SET status = 'error',
                error = 'Ingestion timed out — retry or re-upload.',
                updated_at = NOW()
          WHERE notebook_id = $1
            AND status = 'processing'
            AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')`,
        [notebookId, stuckMinutes]
    );
    return rowCount || 0;
}

// ── Row Mappers ─────────────────────────────────────────────────────


function mapNotebookRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        knowledgeBaseIds: parseJSON(r.knowledge_base_ids, []),
        settings: parseJSON(r.settings, {}),
        documentContent: r.document_content || '',
        documentMd: r.document_md != null ? r.document_md : null,
        documentFormat: r.document_format || 'html',
        type: r.type || 'notebook',
        // null = standalone (owner-only, today's behaviour); set = filed into a
        // project, and readable by its members.
        projectId: r.project_id || null,
        organizationId: r.organization_id || null,
        version: typeof r.version === 'number' ? r.version : (parseInt(r.version) || 0),
        sourceCount: parseInt(r.source_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function mapSourceRow(r) {
    return {
        id: r.id,
        notebookId: r.notebook_id,
        type: r.type,
        name: r.name,
        storageKey: r.storage_key,
        fileName: r.file_name,
        metadata: parseJSON(r.metadata, {}),
        status: r.status,
        stage: r.stage || null,
        error: r.error || null,
        wordCount: parseInt(r.word_count) || 0,
        sortOrder: parseInt(r.sort_order) || 0,
        // Flag (not the content) so the list payload stays small but the UI knows
        // a preview is available and whether a text/meeting source can be retried.
        hasContent: !!(r.content_text && r.content_text.length),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

// ── Version Control ─────────────────────────────────────────────────

// Auto-versioning snapshots notebook content on save with the 5-minute debounce
// below. At 200 versions that's ~16 hours of continuous editing before the oldest
// snapshot is pruned — plenty of recovery runway for accidental overwrites.
const MAX_VERSIONS_PER_NOTEBOOK = 200;
const AUTO_VERSION_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a version snapshot. Auto-prunes oldest versions beyond MAX.
 */
async function createVersion(notebookId, content, summary = 'Auto-save') {
    await initDB();
    const id = crypto.randomUUID();
    const contentLength = (content || '').length;
    await run(
        `INSERT INTO notebook_versions (id, notebook_id, content, summary, content_length)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, notebookId, content || '', summary, contentLength]
    );

    // Prune: keep only the newest MAX_VERSIONS_PER_NOTEBOOK versions
    await run(
        `DELETE FROM notebook_versions
         WHERE id IN (
             SELECT id FROM notebook_versions
             WHERE notebook_id = $1
             ORDER BY created_at DESC
             OFFSET $2
         )`,
        [notebookId, MAX_VERSIONS_PER_NOTEBOOK]
    );

    return { id, notebookId, summary, contentLength, createdAt: new Date().toISOString() };
}

/**
 * Get version list (metadata only — no content). Newest first.
 */
async function getVersions(notebookId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT id, notebook_id, summary, content_length, created_at
         FROM notebook_versions
         WHERE notebook_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [notebookId, limit, offset]
    );
    return rows.map(r => ({
        id: r.id,
        notebookId: r.notebook_id,
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

/**
 * Get a single version with full content.
 */
async function getVersion(versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM notebook_versions WHERE id = $1', [versionId]);
    if (!r) return null;
    return {
        id: r.id,
        notebookId: r.notebook_id,
        content: r.content || '',
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/**
 * Delete a specific version. When `notebookId` is supplied the lookup + delete
 * are scoped to that notebook so a caller can't remove another tenant's snapshot
 * by guessing its id (defense in depth behind the route's ownership check).
 * The sibling read path (getVersion) is guarded at the route; this closes the
 * write path the same way.
 */
async function deleteVersion(versionId, notebookId = null) {
    await initDB();
    if (notebookId) {
        const { rowCount } = await run(
            'DELETE FROM notebook_versions WHERE id = $1 AND notebook_id = $2',
            [versionId, notebookId]
        );
        return rowCount > 0;
    }
    const { rowCount } = await run('DELETE FROM notebook_versions WHERE id = $1', [versionId]);
    return rowCount > 0;
}

/**
 * Check whether an auto-version should be created.
 * Returns true if no version exists or the last one is > 5 minutes old.
 */
async function shouldAutoVersion(notebookId) {
    await initDB();
    const latest = await getOne(
        `SELECT created_at FROM notebook_versions
         WHERE notebook_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [notebookId]
    );
    if (!latest) return true;
    const elapsed = Date.now() - new Date(latest.created_at).getTime();
    return elapsed >= AUTO_VERSION_DEBOUNCE_MS;
}

module.exports = {
    // Notebooks
    MAX_CARD_LIMIT,
    createNotebook,
    getNotebooks,
    listNotebookCards,
    buildListCardsQuery,
    mapNotebookCardRow,
    getNotebook,
    updateNotebook,
    updateNotebookCas,
    touchActivity,
    attachKnowledgeBaseIfAbsent,
    deleteNotebook,
    // Project membership
    resolveNotebookRole,
    setNotebookProject,
    listProjectNotebooks,
    countProjectNotebooks,
    clearProjectFromNotebooks,
    // Sources
    addSource,
    getSources,
    getSource,
    getSourceContent,
    reorderSources,
    updateSource,
    deleteSource,
    timeoutStuckSources,
    // Versions
    createVersion,
    getVersions,
    getVersion,
    deleteVersion,
    shouldAutoVersion,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
