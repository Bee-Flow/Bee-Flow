// @typecheck
/**
 * Knowledge Bases Store — Multi-KB management
 * 
 * Tables: knowledge_bases, documents
 * Chunks are managed by the search-service (kb_chunks table).
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl, CODES } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');
const crypto = require('crypto');
const log = require('../telemetry/log');

// `knowledge_bases.id` and `documents.id` are both `UUID PRIMARY KEY DEFAULT
// gen_random_uuid()` — no insert anywhere supplies an explicit id — so a
// value that is not shaped like a UUID can never be a real row. Without this
// guard, getKB/getDocument handed such a value straight to Postgres, which
// refuses the cast ("invalid input syntax for type uuid") and turns every
// route's `if (!kb) return 404` into an uncaught 500 instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── A project's files base is not governed by this ACL ──────────────
// `source_kind = 'project_files'` is the knowledge base a collaborative
// project's uploaded files live in (projects/projectFiles.js). It carries the
// project's organisation (the privacy shield and the org's embedding settings
// read it), but it is NOT an organisation base: who may read it is decided by
// PROJECT MEMBERSHIP (core/kb/projectFilesKb.js, routes/projects/workspace.js),
// and who may add or remove a file by the project role ladder. So:
//   read    its owner (the project's owner) and a super admin only; never an
//           org admin, never "published to the org", never a group
//   manage  nobody through the generic knowledge-base routes
//   list    never in somebody else's organisation listing
// The same literal as core/kb/projectFilesKb.PROJECT_FILES_SOURCE_KIND (a
// store may not require from core/).
const PROJECT_FILES_KIND = 'project_files';

// ── Document status model (K1) ──────────────────────────────────────
// A documents row is no longer "exists ⇒ indexed". Every ingest attempt can
// leave a row behind so a source shows "38 files · 36 processed":
//   processed  — chunked + embedded, searchable
//   redacted   — same, but the stored text is the PII-tokenised version (K4)
//   skipped    — not indexed on purpose (too short, blocked by the shield, …)
//   error      — extraction/embedding failed; status_reason says why
//   duplicate  — alias of another row (duplicate_of), no chunks of its own
// Only ACTIVE_DOC_STATUSES count as content: dedup lookups, document_count
// and total_chunks all filter on it — otherwise a failed row would 409 as its
// own duplicate on retry and inflate every counter.
const DOC_STATUSES = Object.freeze(['processed', 'redacted', 'skipped', 'error', 'duplicate']);
const ACTIVE_DOC_STATUSES = Object.freeze(['processed', 'redacted']);
const PII_STATUSES = Object.freeze(['none', 'found', 'redacted', 'unscanned']);
const ACTIVE_STATUS_SQL = `status IN ('processed','redacted')`;

// Projection for list/detail reads: everything EXCEPT original_content. The
// full text is large and personal; it is read only by the reindex path and
// the dedicated content endpoint, never by a list.
const DOCUMENT_COLUMNS = [
    'id', 'tenant_id', 'knowledge_base_id', 'title', 'source_type', 'source_uri', 'lang',
    'content_hash', 'chunk_count', 'created_at', 'metadata', 'duplicate_of', 'simhash',
    'source_id', 'status', 'status_reason', 'updated_at', 'source_modified_at', 'external_id',
    'size_bytes', 'page_count', 'sheet_count', 'mime', 'extract_summary', 'pii_status',
    'pii_categories', 'overlaps_document_id', 'created_by',
];
const DOC_SELECT = DOCUMENT_COLUMNS.join(', ');

// KB row + counters. document_count / total_chunks count ACTIVE rows only;
// document_count_all is every row (the "38 files" half of "38 files · 36
// processed"). Shared by listKBs, its system-KB union and listSystemKBs so the
// three can never drift.
const KB_COUNTS_SELECT = `
            SELECT kb.*,
                   COALESCE(d.doc_count, 0) AS document_count,
                   COALESCE(d.doc_count_all, 0) AS document_count_all,
                   COALESCE(d.total_chunks, 0) AS total_chunks
            FROM knowledge_bases kb
            LEFT JOIN (
                SELECT knowledge_base_id,
                       COUNT(*) FILTER (WHERE ${ACTIVE_STATUS_SQL}) AS doc_count,
                       COUNT(*) AS doc_count_all,
                       SUM(chunk_count) FILTER (WHERE ${ACTIVE_STATUS_SQL}) AS total_chunks
                FROM documents
                GROUP BY knowledge_base_id
            ) d ON d.knowledge_base_id = kb.id`;

function toIntOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

/**
 * WHERE clauses shared by listDocuments / countDocuments. Legacy metadata
 * filters (sender, threadId, …) plus the K1 status/source/pii/q filters.
 */
function buildDocumentFilters(kbId, filters = {}) {
    const clauses = [`knowledge_base_id = $1`];
    const vals = [kbId];
    const add = (sql, val) => { vals.push(val); clauses.push(sql.replace('?', `$${vals.length}`)); };
    if (filters.sender) add(`metadata->>'from' ILIKE ?`, `%${filters.sender}%`);
    if (filters.threadId) add(`metadata->>'threadId' = ?`, filters.threadId);
    if (filters.hasAttachment) clauses.push(`(metadata->>'hasAttachments')::boolean = true`);
    if (filters.dateFrom) add(`(metadata->>'date')::timestamptz >= ?`, filters.dateFrom);
    if (filters.dateTo) add(`(metadata->>'date')::timestamptz <= ?`, filters.dateTo);
    if (filters.sourceType) add(`source_type = ?`, filters.sourceType);
    if (filters.sourceId) add(`source_id = ?`, filters.sourceId);
    // Rows no source owns — those predating the source model, or ingested
    // through a wrapper before the backfill ran. A separate key rather than
    // `sourceId: null`, because null is falsy and would silently match
    // EVERY document instead of the handful that have no source.
    if (filters.noSource) clauses.push(`source_id IS NULL`);
    if (filters.status) {
        const list = (Array.isArray(filters.status) ? filters.status : String(filters.status).split(','))
            .map(s => String(s).trim()).filter(s => DOC_STATUSES.includes(s));
        if (list.length > 0) add(`status = ANY(?)`, list);
    }
    if (filters.pii) {
        if (filters.pii === 'found') clauses.push(`pii_status IN ('found','redacted')`);
        else if (PII_STATUSES.includes(filters.pii)) add(`pii_status = ?`, filters.pii);
    }
    if (filters.q) add(`title ILIKE ?`, `%${String(filters.q).replace(/[%_\\]/g, '\\$&')}%`);
    return { clauses, vals };
}

const initDB = makeStoreInit('KnowledgeBases', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS knowledge_bases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            kb_version INT DEFAULT 1,
            embedding_model TEXT DEFAULT 'bge-m3',
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id)`);
    // Losse migratiebestanden: nog steeds niet-fataal (de store moet kunnen
    // starten), maar een falende migratie hoort in de log — de oude
    // /* tolerate */ liet ook een timeout of dode verbinding stil passeren.
    // Drop the deprecated per-KB default_lang column on existing deployments
    // (no-op once applied). Idempotent.
    try { await require('../migrations/drop-kb-default-lang').up(); } catch (e) { log.error('[KnowledgeBases] migratie drop-kb-default-lang gefaald:', e.message); }
    // Add usage_contexts + source_kind columns and backfill auto-created KBs.
    try { await require('../migrations/add-kb-usage-contexts').up(); } catch (e) { log.error('[KnowledgeBases] migratie add-kb-usage-contexts gefaald:', e.message); }
    // UITGEZET (Track Z): de migratie `add-nl-kb-usage-translations` zaaide NL-waarden
    // voor de zeven sleutels kb_detail.usage_label / .usage_agents / .usage_agents_hint /
    // .usage_direct_chat / .usage_direct_chat_hint / .usage_webpages / .usage_webpages_hint.
    // Die zijn in Track Z uit BEIDE Engelse woordenboeken verwijderd (agent-hub/src/i18n/
    // en-defaults.js en server/i18n/defaults/en.js kennen de hele kb_detail-namespace niet
    // meer), dus de migratie schreef bij elke boot DB-rijen voor sleutels die niet bestaan.
    // Het migratiebestand blijft bewust op schijf staan zodat replay van de migratiereeks
    // mogelijk blijft; alleen de aanroep is weg. Komen die sleutels ooit terug, zet dan
    // deze regel weer aan (zie migrations/add-nl-kb-usage-translations.test.js, die rood
    // wordt zodra een van de zeven weer in een woordenboek opduikt).
    // Give every agent-usable KB the 'ai_step' context BEFORE the link-time
    // check starts demanding it — otherwise every existing routine fails its
    // next activation on a base nobody changed.
    try { await require('../migrations/add-kb-ai-step-context').up(); } catch (e) { log.error('[KnowledgeBases] migratie add-kb-ai-step-context gefaald:', e.message); }

    await exec(`
        CREATE TABLE IF NOT EXISTS documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id TEXT NOT NULL,
            knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            title TEXT,
            source_type TEXT DEFAULT 'text',
            source_uri TEXT,
            lang TEXT DEFAULT 'unknown',
            content_hash TEXT,
            chunk_count INT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(knowledge_base_id, content_hash)`);

    // ── Column migrations ──
    // Via runDdl (stores/lib/_ddl.js): fouten per statement luid verzameld
    // i.p.v. stil ingeslikt als "column already exists".
    await runDdl('knowledgeBases', [
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS organization_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_kb_org ON knowledge_bases(organization_id) WHERE organization_id IS NOT NULL`,
    ]);
    // Publish lifecycle (mirrors agents.is_published / agents.shared_groups)
    // pg_attribute lookup so we know whether to backfill below; the probe
    // itself never throws for a missing column — a real error must surface.
    const existingPublished = await getOne(`SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'knowledge_bases' AND column_name = 'is_published'`);
    const publishedColumnIsNew = !existingPublished;
    await runDdl('knowledgeBases', [
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]'`,
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS category_id TEXT`,
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS icon TEXT`,
        // System-managed KBs (Bee Flow-provided content like Dutch legal sources).
        // `system_slug` ties the KB row to a beta-feature id; the listKBs filter
        // surfaces it to orgs whose beta toggle matches. NULL on user-created KBs.
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS system_slug TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_system_slug ON knowledge_bases(system_slug) WHERE system_slug IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_kb_org_published ON knowledge_bases(organization_id, is_published) WHERE is_published = TRUE`,
    ]);
    // First-deploy backfill: org KBs that already existed before the publish flow
    // were visible to the whole org; preserve that by marking them published.
    // Personal KBs (organization_id IS NULL) stay as drafts.
    if (publishedColumnIsNew) {
        try {
            await exec(`UPDATE knowledge_bases SET is_published = TRUE WHERE organization_id IS NOT NULL AND is_published = FALSE`);
            log.info('[KnowledgeBases] Backfilled is_published=TRUE for existing org KBs');
        } catch (e) { log.warn('[KnowledgeBases] Backfill failed:', e.message); }
    }
    // ── KB versioning ──
    // Two-tier history: kb_versions captures full metadata snapshots of the
    // KB row on every meaningful edit (publish, rename, shared-group change);
    // kb_document_versions captures document content right before a delete so
    // an accidental drop can be recovered. Neither table is on the hot read
    // path — they're written from mutation handlers and read only from
    // admin/restore UIs.
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            version_number INT NOT NULL,
            snapshot JSONB NOT NULL,
            changed_by TEXT,
            change_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await runDdl('knowledgeBases', [
        `CREATE INDEX IF NOT EXISTS idx_kb_versions_kb ON kb_versions(kb_id, version_number DESC)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_versions_unique ON kb_versions(kb_id, version_number)`,
    ]);

    await exec(`
        CREATE TABLE IF NOT EXISTS kb_document_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id UUID NOT NULL,
            knowledge_base_id UUID NOT NULL,
            tenant_id TEXT NOT NULL,
            title TEXT,
            source_type TEXT,
            source_uri TEXT,
            content_hash TEXT,
            payload JSONB,
            deleted_by TEXT,
            deleted_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await runDdl('knowledgeBases', [
        `CREATE INDEX IF NOT EXISTS idx_kb_doc_versions_kb ON kb_document_versions(knowledge_base_id, deleted_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_kb_doc_versions_doc ON kb_document_versions(document_id)`,
    ]);

    // Org-level KB categories (mirrors agent_categories)
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_categories (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '📚',
            color TEXT DEFAULT '#6366f1',
            created_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await runDdl('knowledgeBases', [
        `CREATE INDEX IF NOT EXISTS idx_kb_categories_org ON kb_categories(organization_id)`,
        // Rich metadata on documents (sender, threadId, attachments, simhash, …)
        `ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`,
        // Duplicate tracking for content-hash / simhash dedup
        `ALTER TABLE documents ADD COLUMN IF NOT EXISTS duplicate_of UUID`,
        `ALTER TABLE documents ADD COLUMN IF NOT EXISTS simhash BIGINT`,
        // GIN index for metadata lookups (sender/threadId filters)
        `CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN (metadata jsonb_path_ops)`,
    ]);

    // ── Sources (K1) ──
    // kb_sources references knowledge_bases (exists by now) and documents
    // references kb_sources, so the source table must exist before the
    // source_id column below. The kb_sources store never waits on us during
    // its ensureSchema(), so there is no init deadlock.
    await require('./kbSources').ensureSchema();
    // "Updated 2 min ago" on the overview — bumped by bumpKBVersion (every
    // content change) and by the source-refresh engine; NOT by updateKB /
    // setPublished, which are metadata edits.
    // Per-document status + provenance (see DOC_STATUSES at the top).
    const docColumns = [
        // Historically added by localKBIngest.ensureKBChunksTable; owned here
        // too so getDocumentOriginalContent works before the first local ingest.
        `original_content TEXT`,
        `source_id UUID REFERENCES kb_sources(id) ON DELETE CASCADE`,
        `status TEXT DEFAULT 'processed'`,
        `status_reason TEXT`,
        `updated_at TIMESTAMPTZ DEFAULT now()`,
        `source_modified_at TIMESTAMPTZ`,
        `external_id TEXT`,
        `size_bytes INT`,
        `page_count INT`,
        `sheet_count INT`,
        `mime TEXT`,
        `extract_summary TEXT`,
        `pii_status TEXT DEFAULT 'unscanned'`,
        `pii_categories JSONB`,
        `overlaps_document_id UUID`,
        `created_by TEXT`,
    ];
    await runDdl('knowledgeBases', [
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS last_content_at TIMESTAMPTZ`,
        ...docColumns.map((col) => `ALTER TABLE documents ADD COLUMN IF NOT EXISTS ${col}`),
        // CHECK constraints can't be added IF NOT EXISTS; guard on pg_constraint.
        // Legacy-rijen die de check schenden mogen db:migrate niet breken
        // (tolerate 23514) — al het andere is een echte, luide fout.
        {
            sql: `DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_status_check') THEN
                    ALTER TABLE documents ADD CONSTRAINT documents_status_check
                        CHECK (status IN ('processed','redacted','skipped','error','duplicate'));
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_pii_status_check') THEN
                    ALTER TABLE documents ADD CONSTRAINT documents_pii_status_check
                        CHECK (pii_status IN ('none','found','redacted','unscanned'));
                END IF;
            END $$`,
            tolerate: CODES.CHECK_VIOLATION,
            reden: 'legacy-rijen schenden de check — app-laag houdt nieuwe waarden al tegen',
        },
        `CREATE INDEX IF NOT EXISTS idx_documents_kb_source ON documents(knowledge_base_id, source_id)`,
        // Refresh-in-place looks a document up by (source, external id). Duplicate
        // alias rows share the external id of their canonical row, so keep them
        // out of the index that answers "is this file already here?".
        `CREATE INDEX IF NOT EXISTS idx_documents_source_external ON documents(source_id, external_id) WHERE status <> 'duplicate'`,
    ]);

    // Per-user KB favorites (replaces client-side localStorage `kb_favorites`)
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_favorites (
            user_id TEXT NOT NULL,
            kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, kb_id)
        )
    `);
    await runDdl('knowledgeBases', [
        `CREATE INDEX IF NOT EXISTS idx_kb_favorites_user ON kb_favorites(user_id)`,
    ]);

    log.info('[KnowledgeBases] Tables initialized');
}

/**
 * The writable columns of a document, in the order they have always been
 * written. An unlisted key is ignored — `id`, `knowledge_base_id` and
 * `source_id` are not something a content refresh may move.
 */
const DOC_CONTENT_COLUMNS = {
    title: 'title',
    contentHash: 'content_hash',
    simhash: 'simhash',
    // A row that gets content of its own stops being an alias of another.
    // Only when the caller says so (`duplicateOf: null`); a patch that does
    // not mention it leaves the pointer alone.
    duplicateOf: { col: 'duplicate_of', cast: 'uuid', transform: v => v || null },
    chunkCount: { col: 'chunk_count', transform: toIntOrNull },
    sizeBytes: { col: 'size_bytes', transform: toIntOrNull },
    pageCount: { col: 'page_count', transform: toIntOrNull },
    sheetCount: { col: 'sheet_count', transform: toIntOrNull },
    mime: 'mime',
    sourceModifiedAt: 'source_modified_at',
    externalId: { col: 'external_id', transform: v => (v == null ? null : String(v)) },
    status: { col: 'status', transform: v => (DOC_STATUSES.includes(v) ? v : 'processed') },
    statusReason: { col: 'status_reason', transform: v => (v ? String(v).slice(0, 500) : null) },
    extractSummary: 'extract_summary',
    piiStatus: { col: 'pii_status', transform: v => (PII_STATUSES.includes(v) ? v : 'unscanned') },
    piiCategories: { col: 'pii_categories', cast: 'jsonb', transform: v => (v ? JSON.stringify(v) : null) },
    overlapsDocumentId: 'overlaps_document_id',
    metadata: { col: 'metadata', cast: 'jsonb', transform: v => (v ? JSON.stringify(v) : '{}') },
};

const KnowledgeBasesStore = {
    DOC_STATUSES,
    ACTIVE_DOC_STATUSES,
    PII_STATUSES,
    DOCUMENT_COLUMNS,
    /** Resolves once the schema is initialised. Used by dependent stores (kbSources). */
    whenReady: () => initDB(),

    // ── KB CRUD ─────────────────────────────────────────────────────────

    /**
     * Create a new KB.
     * @param {string} tenantId - Owner user ID
     * @param {string} name
     * @param {string} description
     * @param {string|null} organizationId - Organization this KB belongs to (null = personal)
     * @param {object} extra - Optional { categoryId, icon, sourceKind, usageContexts }
     *   - sourceKind: 'manual' | 'webpage_auto' | 'notebook_auto' (default 'manual')
     *   - usageContexts: array of 'agent' | 'direct_chat' | 'webpage' (default all three)
     */
    createKB: async (tenantId, name, description = '', organizationId = null, extra = {}) => {
        await initDB();
        const sourceKind = extra.sourceKind || 'manual';
        // Default for manual KBs: studio-managed contexts only. Webpage-owned KBs
        // pass usageContexts=['webpage'] explicitly via their auto-create paths.
        const usageContexts = Array.isArray(extra.usageContexts)
            ? extra.usageContexts
            : ['agent', 'direct_chat'];
        const isPublished = extra.isPublished === true || sourceKind === 'system_managed';
        const row = await getOne(
            `INSERT INTO knowledge_bases (tenant_id, name, description, organization_id, category_id, icon, source_kind, usage_contexts, system_slug, is_published)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
             RETURNING *`,
            [tenantId, name, description, organizationId || null, extra.categoryId || null, extra.icon || null, sourceKind, JSON.stringify(usageContexts), extra.systemSlug || null, isPublished]
        );
        return row;
    },

    /**
     * Look up a system-managed KB by its `system_slug`.
     * Returns the row or null. Used by the ingest script for idempotent upserts
     * and by the chat layer to resolve enabled-beta-feature → KB id.
     */
    getSystemKBBySlug: async (slug) => {
        await initDB();
        if (!slug) return null;
        return getOne(
            `SELECT * FROM knowledge_bases
             WHERE source_kind = 'system_managed' AND system_slug = $1
             LIMIT 1`,
            [slug]
        );
    },

    /**
     * List every seeded system-managed KB. Cheap — at most a handful of rows.
     * Used by the admin status panel and by the chat KB resolver.
     */
    listSystemKBs: async () => {
        await initDB();
        return getAll(
            `${KB_COUNTS_SELECT}
             WHERE kb.source_kind = 'system_managed'
             ORDER BY kb.name`
        );
    },

    /** Lightweight predicate for guarding write paths in routes. */
    isSystemKB: (kb) => !!(kb && kb.source_kind === 'system_managed'),

    /** Is this a project's files base (see PROJECT_FILES_KIND)? */
    isProjectFilesKB: (kb) => !!(kb && kb.source_kind === PROJECT_FILES_KIND),

    /**
     * List KBs accessible to the user.
     * @param {string} tenantId - The user's ID
     * @param {Set|null} orgIds - User's org IDs from resolveUserOrgIds().
     *   null = super admin (see all), Set with values = org member, empty Set = no org
     * @param {object} [opts]
     * @param {string|string[]|null} [opts.sourceKind='manual'] - Filter by source kind.
     *   Pass a string for one kind, an array for several, or null to include all kinds.
     * @param {string|null} [opts.usageContext=null] - When set, only KBs whose `usage_contexts`
     *   array contains this value are returned ('agent' | 'direct_chat' | 'webpage').
     * @param {string|null} [opts.excludeContext=null] - Inverse of `usageContext`. KBs whose
     *   `usage_contexts` array contains this value are excluded.
     * @param {string[]} [opts.systemSlugs=null] - When provided, system-managed KBs whose
     *   `system_slug` is in this list are included in addition to the normal personal/org
     *   results. Used by the chat layer to surface system KBs whose beta feature is enabled
     *   for the requesting user's org.
     * @param {boolean} [opts.isOrgAdmin] - server-resolved; org admins also see draft org KBs.
     */
    listKBs: async (tenantId, orgIds = undefined, opts = {}) => {
        await initDB();

        const sourceKindOpt = opts.sourceKind === undefined ? 'manual' : opts.sourceKind;
        const sourceKindList = sourceKindOpt === null
            ? null
            : (Array.isArray(sourceKindOpt) ? sourceKindOpt : [sourceKindOpt]);
        const usageContext = opts.usageContext || null;
        const excludeContext = opts.excludeContext || null;
        const systemSlugs = Array.isArray(opts.systemSlugs) ? opts.systemSlugs : null;

        // Build optional filter clauses + their bound params. Each branch below
        // appends these so the marketplace, agent and direct-chat pickers all
        // narrow the same way.
        const buildFilters = (startIdx) => {
            const conds = [];
            const params = [];
            let idx = startIdx;
            if (sourceKindList && sourceKindList.length > 0) {
                conds.push(`kb.source_kind = ANY($${idx++})`);
                params.push(sourceKindList);
            }
            if (usageContext) {
                conds.push(`kb.usage_contexts ? $${idx++}`);
                params.push(usageContext);
            }
            if (excludeContext) {
                conds.push(`NOT (kb.usage_contexts ? $${idx++})`);
                params.push(excludeContext);
            }
            return { sql: conds.length > 0 ? ' AND ' + conds.join(' AND ') : '', params };
        };

        // System-managed KBs ride alongside personal + org-published results.
        // They are filtered by an explicit allow-list of system_slugs from the
        // caller (resolved from the org's enabled beta features). We OR them
        // into the visibility predicate AFTER the sourceKind/usageContext
        // filters so the same slug list always applies regardless of the kind
        // filter.
        const buildSystemUnion = (startIdx) => {
            if (!systemSlugs || systemSlugs.length === 0) return { sql: '', params: [] };
            const conds = [`kb.source_kind = 'system_managed'`, `kb.system_slug = ANY($${startIdx})`];
            /** @type {Array<string|string[]>} */
            const params = [systemSlugs];
            let idx = startIdx + 1;
            if (usageContext) {
                conds.push(`kb.usage_contexts ? $${idx++}`);
                params.push(usageContext);
            }
            if (excludeContext) {
                conds.push(`NOT (kb.usage_contexts ? $${idx++})`);
                params.push(excludeContext);
            }
            return { sql: ` UNION ${KB_COUNTS_SELECT}
                WHERE ${conds.join(' AND ')}`, params };
        };

        const baseSelect = KB_COUNTS_SELECT;

        // Legacy fallback: if orgIds not provided, show only user's own KBs
        if (orgIds === undefined) {
            const f = buildFilters(2);
            const u = buildSystemUnion(2 + f.params.length);
            return getAll(
                `${baseSelect} WHERE kb.tenant_id = $1${f.sql}${u.sql}
                 ORDER BY created_at DESC`,
                [tenantId, ...f.params, ...u.params]
            );
        }

        // Super admin — see all KBs. When the caller has narrowed by
        // sourceKind (e.g. 'manual' for the picker), system KBs whose slug is
        // on the systemSlugs allow-list are unioned back in so super admins
        // get the same chat UX as regular users.
        if (orgIds === null) {
            const f = buildFilters(1);
            const where = f.sql ? ' WHERE ' + f.sql.replace(/^ AND /, '') : '';
            const u = buildSystemUnion(1 + f.params.length);
            return getAll(
                `${baseSelect}${where}${u.sql} ORDER BY created_at DESC`,
                [...f.params, ...u.params]
            );
        }

        const orgIdArray = Array.from(orgIds);

        if (orgIdArray.length === 0) {
            // No org membership — only personal KBs (+ enabled system KBs, if any)
            const f = buildFilters(2);
            const u = buildSystemUnion(2 + f.params.length);
            return getAll(
                `${baseSelect} WHERE kb.tenant_id = $1${f.sql}${u.sql}
                 ORDER BY created_at DESC`,
                [tenantId, ...f.params, ...u.params]
            );
        }

        // Org member — personal KBs (any state) + PUBLISHED KBs from user's org(s)
        // + enabled system-managed KBs.
        // Group restriction (shared_groups) is applied in JS by callers via filterByGroupAccess.
        const f = buildFilters(3);
        const u = buildSystemUnion(3 + f.params.length);
        // Org admins see every KB in their org (drafts included); regular
        // members see only PUBLISHED org KBs. Owner KBs always included.
        // (isOrgAdmin is a server-resolved boolean, never user input.)
        const orgDraftClause = opts.isOrgAdmin ? '' : ' AND kb.is_published = TRUE';
        // A project's files base is never an org row, whoever asks (see
        // PROJECT_FILES_KIND): an org admin's ?includeAuto=1 listing must not
        // hand them the files of a project they are not a member of.
        return getAll(
            `${baseSelect}
             WHERE (kb.tenant_id = $1 OR (kb.organization_id = ANY($2) AND kb.source_kind IS DISTINCT FROM '${PROJECT_FILES_KIND}'${orgDraftClause}))${f.sql}${u.sql}
             ORDER BY created_at DESC`,
            [tenantId, orgIdArray, ...f.params, ...u.params]
        );
    },

    /**
     * Filter a KB list down to those the user is allowed to see based on
     * `shared_groups` group restrictions. Owner KBs (tenant_id = userId)
     * always pass. Drafts (is_published = false) always pass for the owner.
     *
     * @param {Array} kbs - Result of listKBs
     * @param {string} userId - The user's ID
     * @param {Array<string>} userGroups - Group IDs the user belongs to
     */
    filterByGroupAccess: (kbs, userId, userGroups = [], opts = {}) => {
        if (!Array.isArray(kbs)) return [];
        return kbs.filter(kb => KnowledgeBasesStore.canUserAccessKB(kb, userId, opts.orgIds, userGroups, { isOrgAdmin: opts.isOrgAdmin }));
    },

    /**
     * Single source of truth for "is this user allowed to read this KB?".
     * Used both by the list filter and by per-id route guards so the two
     * paths can never drift.
     *
     * @param {object} kb - Row from knowledge_bases
     * @param {string} userId - The requesting user's id
     * @param {Set|null|undefined} orgIds - User's org ids; null = super admin.
     *   When undefined, org membership is not considered (list-path callers
     *   already constrained the query by org, so only group rules need to run).
     * @param {Array<string>} userGroups - Group ids the user belongs to
     */
    canUserAccessKB: (kb, userId, orgIds = undefined, userGroups = [], opts = {}) => {
        if (!kb) return false;
        // System-managed KBs hold public reference content (e.g. Dutch
        // legislation). Read access is granted to any authenticated user; the
        // beta-feature toggle gates whether they appear in pickers / chat,
        // not whether the underlying public text is reachable.
        if (kb.source_kind === 'system_managed') return true;
        // A project's files base: its owner and a super admin, nobody else.
        // Members reach it through the project (see PROJECT_FILES_KIND); an
        // org admin or a "published" flag must not.
        if (kb.source_kind === PROJECT_FILES_KIND) return kb.tenant_id === userId || orgIds === null;
        // Owner always has access
        if (kb.tenant_id === userId) return true;
        // Super admin
        if (orgIds === null) return true;
        // Org admins always see every KB in their organisation — including
        // unpublished drafts and group-restricted KBs (read access). Scoped to
        // the admin's own org(s); a member's personal (no-org) KB stays private.
        if (opts.isOrgAdmin && kb.organization_id && orgIds instanceof Set && orgIds.has(kb.organization_id)) {
            return true;
        }
        // Direct-fetch path: must be in the KB's org
        if (orgIds instanceof Set) {
            if (!kb.organization_id || !orgIds.has(kb.organization_id)) return false;
        }
        // Drafts hidden from non-owners
        if (!kb.is_published) return false;
        // shared_groups restriction
        let groups = [];
        try { groups = JSON.parse(kb.shared_groups || '[]'); } catch { groups = []; }
        if (!Array.isArray(groups) || groups.length === 0) return true;
        return groups.some(g => userGroups.includes(g));
    },

    /**
     * "Is this user allowed to MANAGE this KB's settings?" (BFSF-214).
     * Deliberately separate from canUserAccessKB: draft status gates READING
     * content, not managing settings. Non-owner managers must belong to the
     * KB's org AND hold manage_knowledge (checked by the caller via
     * hasPermission and passed in as a boolean so this stays pure/testable).
     *
     * @param {object} kb - Row from knowledge_bases
     * @param {string} userId - Requesting user's id
     * @param {Set|null} orgIds - resolveUserOrgIds(req) result; null = super admin
     * @param {boolean} hasManagePermission - hasPermission(userId,'manage_knowledge')
     */
    canUserManageKB: (kb, userId, orgIds, hasManagePermission) => {
        if (!kb) return false;
        // A project's files are added and removed through the project, by its
        // role ladder; the generic routes manage nothing in that base.
        if (kb.source_kind === PROJECT_FILES_KIND) return false;
        if (kb.tenant_id === userId) return true;          // owner
        if (orgIds === null) return true;                  // super admin
        if (!kb.organization_id) return false;             // personal KB of someone else
        if (!(orgIds instanceof Set) || !orgIds.has(kb.organization_id)) return false; // must share org
        return !!hasManagePermission;
    },

    getKB: async (id) => {
        if (!id || !UUID_RE.test(String(id))) return null;
        await initDB();
        return getOne('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    },

    /**
     * `organizationId` is ONE-WAY on purpose: a value moves a personal KB into
     * an organisation, and there is no way to move it back out. Un-setting it
     * on a base colleagues may already have attached to their agents would
     * revoke their access with nothing to say so — so COALESCE is exactly the
     * right operator here, and a null means "leave as-is", never "clear".
     * The route decides WHO may set it (owner only, via assertUserCanUseOrg);
     * this only guarantees the direction.
     */
    updateKB: async (id, { name, description, categoryId, icon, usageContexts, organizationId }) => {
        await initDB();
        const usageJson = Array.isArray(usageContexts) ? JSON.stringify(usageContexts) : null;
        // categoryId: undefined = leave as-is, explicit null = clear back to
        // NULL (BFSF-214) — COALESCE alone can't express the clear, so a
        // boolean flag drives a CASE for that column.
        const clearCategory = categoryId === null;
        return getOne(
            `UPDATE knowledge_bases
             SET name = COALESCE($2, name),
                 description = COALESCE($3, description),
                 category_id = CASE WHEN $7 THEN NULL ELSE COALESCE($4, category_id) END,
                 icon = COALESCE($5, icon),
                 usage_contexts = COALESCE($6::jsonb, usage_contexts),
                 organization_id = COALESCE($8, organization_id),
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, name, description, categoryId, icon, usageJson, clearCategory, organizationId || null]
        );
    },

    /**
     * Toggle publish state and (optionally) shared groups. Owner-only operation
     * enforced at the route layer.
     *
     * When `sharedGroups` is undefined, the existing DB value is preserved —
     * a toggle-publish call without an explicit groups payload must NOT
     * silently flip a group-restricted KB to entire-org visibility. Mirrors
     * the same fix in agentCrud.setAgentPublished.
     */
    setPublished: async (id, isPublished, sharedGroups) => {
        await initDB();
        if (sharedGroups === undefined) {
            return getOne(
                `UPDATE knowledge_bases
                 SET is_published = $2,
                     updated_at = now()
                 WHERE id = $1
                 RETURNING *`,
                [id, !!isPublished]
            );
        }
        const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
        return getOne(
            `UPDATE knowledge_bases
             SET is_published = $2,
                 shared_groups = $3,
                 updated_at = now()
             WHERE id = $1
             RETURNING *`,
            [id, !!isPublished, groupsJson]
        );
    },

    // ── KB Categories (org-level, mirrors agent_categories) ─────────────

    listKBCategories: async (organizationId) => {
        await initDB();
        if (!organizationId) {
            return getAll(`SELECT * FROM kb_categories WHERE organization_id IS NULL ORDER BY name`);
        }
        return getAll(
            `SELECT * FROM kb_categories WHERE organization_id = $1 ORDER BY name`,
            [organizationId]
        );
    },

    createKBCategory: async ({ id, organizationId, name, icon, color }) => {
        await initDB();
        return getOne(
            `INSERT INTO kb_categories (id, organization_id, name, icon, color)
             VALUES ($1, $2, $3, COALESCE($4, '📚'), COALESCE($5, '#6366f1'))
             RETURNING *`,
            [id, organizationId || null, name, icon, color]
        );
    },

    deleteKBCategory: async (id) => {
        await initDB();
        // Detach any KBs from this category, then remove it
        await run(`UPDATE knowledge_bases SET category_id = NULL WHERE category_id = $1`, [id]);
        await run(`DELETE FROM kb_categories WHERE id = $1`, [id]);
        return true;
    },

    deleteKB: async (id) => {
        await initDB();
        // Documents cascade-delete; chunks must be deleted via search-service.
        // Also scrub this KB from any project's knowledge_base_ids so projects
        // don't carry dangling references after the KB row is gone.
        try {
            await run(
                `UPDATE projects
                 SET knowledge_base_ids = COALESCE(
                     (SELECT jsonb_agg(elem) FROM jsonb_array_elements_text(knowledge_base_ids) elem WHERE elem <> $1),
                     '[]'::jsonb
                 )
                 WHERE knowledge_base_ids @> to_jsonb($1::text)`,
                [id]
            );
        } catch (e) { /* projects table may not exist yet on first boot */ }
        await run('DELETE FROM knowledge_bases WHERE id = $1', [id]);
        return true;
    },

    /**
     * Content changed (ingest, replace, delete): bump the version the search
     * caches key on and stamp last_content_at — the "Updated 2 min ago" pill.
     * Metadata edits (updateKB/setPublished) deliberately do NOT touch it.
     */
    bumpKBVersion: async (id) => {
        await initDB();
        return getOne(
            `UPDATE knowledge_bases SET kb_version = kb_version + 1, updated_at = now(), last_content_at = now()
             WHERE id = $1 RETURNING kb_version, last_content_at`,
            [id]
        );
    },

    // ── Document CRUD ───────────────────────────────────────────────────

    /**
     * Insert a documents row.
     *
     * The first nine params are the legacy positional signature (routes/templates.js
     * still uses it). `extra` carries the K1 provenance/status columns:
     *   { sourceId, externalId, sourceModifiedAt, sizeBytes, pageCount, sheetCount,
     *     mime, createdBy, status, statusReason, extractSummary, piiStatus,
     *     piiCategories, overlapsDocumentId }
     */
    createDocument: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount = 0, metadata = null, simhash = null, extra = {}) => {
        await initDB();
        const x = extra || {};
        const status = DOC_STATUSES.includes(x.status) ? x.status : 'processed';
        const piiStatus = PII_STATUSES.includes(x.piiStatus) ? x.piiStatus : 'unscanned';
        const row = await getOne(
            `INSERT INTO documents (
                tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count, metadata, simhash,
                source_id, external_id, source_modified_at, size_bytes, page_count, sheet_count, mime, created_by,
                status, status_reason, extract_summary, pii_status, pii_categories, overlaps_document_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
                     $10, $11, $12, $13, $14, $15, $16, $17,
                     $18, $19, $20, $21, $22::jsonb, $23)
             RETURNING ${DOC_SELECT}`,
            [tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount, metadata ? JSON.stringify(metadata) : '{}', simhash,
             x.sourceId || null, x.externalId != null ? String(x.externalId) : null, x.sourceModifiedAt || null,
             toIntOrNull(x.sizeBytes), toIntOrNull(x.pageCount), toIntOrNull(x.sheetCount), x.mime || null, x.createdBy || null,
             status, x.statusReason ? String(x.statusReason).slice(0, 500) : null, x.extractSummary || null,
             piiStatus, x.piiCategories ? JSON.stringify(x.piiCategories) : null, x.overlapsDocumentId || null]
        );
        return row;
    },

    /**
     * Record a duplicate relationship: the new row is an alias for `canonicalId`.
     * No new chunks are embedded — the row just points to the canonical doc,
     * carries status 'duplicate' and never counts as content.
     */
    recordDuplicate: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata = null, extra = {}) => {
        await initDB();
        const x = extra || {};
        return getOne(
            `INSERT INTO documents (tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count, duplicate_of, metadata,
                                    status, status_reason, source_id, external_id, created_by, size_bytes, mime)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8::jsonb, 'duplicate', $9, $10, $11, $12, $13, $14)
             RETURNING ${DOC_SELECT}`,
            [tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata ? JSON.stringify(metadata) : '{}',
             x.statusReason ? String(x.statusReason).slice(0, 500) : null,
             x.sourceId || null, x.externalId != null ? String(x.externalId) : null, x.createdBy || null,
             toIntOrNull(x.sizeBytes), x.mime || null]
        );
    },

    /**
     * Find a near-duplicate by simhash within a given Hamming distance among
     * ACTIVE documents (a skipped/failed/duplicate row is never a canonical).
     * Returns { id, title, simhash, source_id } or null. `distance` defaults to 3.
     */
    findNearDuplicateBySimhash: async (kbId, simhash, distance = 3) => {
        await initDB();
        if (simhash == null) return null;
        // Count set bits in the XOR to compute Hamming distance.
        return getOne(
            `SELECT id, title, simhash, source_id FROM documents
             WHERE knowledge_base_id = $1
               AND ${ACTIVE_STATUS_SQL}
               AND simhash IS NOT NULL
               AND length(replace((($2::bigint # simhash)::bit(64))::text, '0', '')) <= $3
             ORDER BY created_at DESC
             LIMIT 1`,
            [kbId, simhash, distance]
        );
    },

    /**
     * Mark a row's outcome without touching its content columns — the
     * onFailure:'record' path and "process again" use it.
     * @param {string} docId
     * @param {object} p - { status, statusReason?, chunkCount? }
     */
    updateDocumentStatus: async (docId, { status, statusReason, chunkCount } = {}) => {
        await initDB();
        if (!DOC_STATUSES.includes(status)) throw new Error(`Invalid document status: ${status}`);
        return getOne(
            `UPDATE documents
                SET status = $2,
                    status_reason = $3,
                    chunk_count = COALESCE($4, chunk_count),
                    updated_at = now()
              WHERE id = $1
              RETURNING ${DOC_SELECT}`,
            [docId, status, statusReason ? String(statusReason).slice(0, 500) : null, toIntOrNull(chunkCount)]
        );
    },

    /**
     * Refresh-in-place: the row (and therefore documents.id, citations and
     * version history) is kept; only the content fingerprint and the
     * bookkeeping columns change. The caller has already replaced the chunks
     * (kbIngestionHelpers.reingestDocument). `undefined` keeps a stored
     * value, so a partial patch never blanks a column.
     */
    replaceDocumentContent: async (docId, patch = {}) => {
        await initDB();
        const built = buildUpdate({
            table: 'documents',
            updates: patch || {},
            columnMap: DOC_CONTENT_COLUMNS,
            extraSet: ['updated_at = now()'],
            where: [{ col: 'id', value: docId }],
            returning: DOC_SELECT,
        });
        // An empty patch has always still stamped the row and returned it —
        // the re-ingest path calls this to say "checked, unchanged", and a
        // document whose updated_at stopped moving reads as abandoned.
        if (!built) {
            return getOne(
                `UPDATE documents SET updated_at = now() WHERE id = $1 RETURNING ${DOC_SELECT}`,
                [docId]
            );
        }
        return getOne(built.sql, built.params);
    },

    /**
     * Documents of a source keyed by the external system's id (Nextcloud
     * fileid, datatable row id, transcription id, URL). Duplicate alias rows
     * are excluded — they share the canonical row's external id.
     */
    findDocumentsBySourceExternalId: async (sourceId, externalId) => {
        await initDB();
        if (!sourceId || externalId == null) return [];
        return getAll(
            `SELECT ${DOC_SELECT} FROM documents
             WHERE source_id = $1 AND external_id = $2 AND status <> 'duplicate'
             ORDER BY created_at DESC`,
            [sourceId, String(externalId)]
        );
    },

    findDocumentBySourceExternalId: async (sourceId, externalId) => {
        const rows = await KnowledgeBasesStore.findDocumentsBySourceExternalId(sourceId, externalId);
        return rows[0] || null;
    },

    /**
     * Per-source status counters for the Sources tab:
     * { [sourceId]: { documentCount, processedCount, redactedCount, skippedCount, errorCount, duplicateCount, piiFoundCount } }
     * `documentCount` counts every row (the "38 files" half of "38 files · 36 processed").
     */
    countsBySource: async (sourceIds) => {
        await initDB();
        const ids = Array.from(new Set((sourceIds || []).filter(Boolean)));
        const out = {};
        if (ids.length === 0) return out;
        const rows = await getAll(
            `SELECT source_id,
                    COUNT(*)::int AS document_count,
                    COUNT(*) FILTER (WHERE status = 'processed')::int AS processed_count,
                    COUNT(*) FILTER (WHERE status = 'redacted')::int AS redacted_count,
                    COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count,
                    COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
                    COUNT(*) FILTER (WHERE status = 'duplicate')::int AS duplicate_count,
                    COUNT(*) FILTER (WHERE pii_status IN ('found','redacted'))::int AS pii_found_count,
                    COALESCE(SUM(chunk_count) FILTER (WHERE ${ACTIVE_STATUS_SQL}), 0)::int AS total_chunks
               FROM documents
              WHERE source_id = ANY($1::uuid[])
              GROUP BY source_id`,
            [ids]
        );
        for (const r of rows || []) {
            out[r.source_id] = {
                documentCount: Number(r.document_count) || 0,
                processedCount: Number(r.processed_count) || 0,
                redactedCount: Number(r.redacted_count) || 0,
                skippedCount: Number(r.skipped_count) || 0,
                errorCount: Number(r.error_count) || 0,
                duplicateCount: Number(r.duplicate_count) || 0,
                piiFoundCount: Number(r.pii_found_count) || 0,
                totalChunks: Number(r.total_chunks) || 0,
            };
        }
        return out;
    },

    /**
     * KB-level counters with the same status semantics as listKBs:
     * { documentCount (active), documentCountAll, totalChunks }.
     */
    countDocumentsByStatus: async (kbId) => {
        await initDB();
        const r = await getOne(
            `SELECT COUNT(*) FILTER (WHERE ${ACTIVE_STATUS_SQL})::int AS document_count,
                    COUNT(*)::int AS document_count_all,
                    COALESCE(SUM(chunk_count) FILTER (WHERE ${ACTIVE_STATUS_SQL}), 0)::int AS total_chunks
               FROM documents WHERE knowledge_base_id = $1`,
            [kbId]
        );
        return {
            documentCount: Number(r?.document_count) || 0,
            documentCountAll: Number(r?.document_count_all) || 0,
            totalChunks: Number(r?.total_chunks) || 0,
        };
    },

    /**
     * List documents of a KB — PROJECTED (never original_content).
     *
     * @param {string} kbId
     * @param {object} [opts]
     * @param {number} [opts.limit=200]
     * @param {number} [opts.offset=0]
     * @param {object} [opts.filters] - sender, threadId, hasAttachment, dateFrom, dateTo,
     *   sourceType (legacy metadata filters) plus K1: sourceId, status (string|string[]),
     *   pii ('found' = found|redacted, or an exact pii_status), q (title ILIKE)
     */
    listDocuments: async (kbId, opts = {}) => {
        await initDB();
        const { limit = 200, offset = 0, filters = {} } = opts;
        const { clauses, vals } = buildDocumentFilters(kbId, filters);
        vals.push(limit); const limitIdx = vals.length;
        vals.push(offset); const offsetIdx = vals.length;
        return getAll(
            `SELECT ${DOC_SELECT} FROM documents
             WHERE ${clauses.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            vals
        );
    },

    countDocuments: async (kbId, filters = {}) => {
        await initDB();
        const { clauses, vals } = buildDocumentFilters(kbId, filters);
        const row = await getOne(`SELECT COUNT(*)::int AS n FROM documents WHERE ${clauses.join(' AND ')}`, vals);
        return row?.n || 0;
    },

    /**
     * Return distinct threadIds + sibling counts for a KB — for the thread explorer UI.
     */
    listThreads: async (kbId, opts = {}) => {
        await initDB();
        const { limit = 100 } = opts;
        return getAll(
            `SELECT metadata->>'threadId' AS thread_id,
                    COUNT(*)::int AS message_count,
                    MAX(created_at) AS latest
             FROM documents
             WHERE knowledge_base_id = $1
               AND metadata ? 'threadId'
               AND metadata->>'threadId' IS NOT NULL
             GROUP BY thread_id
             ORDER BY latest DESC
             LIMIT $2`,
            [kbId, limit]
        );
    },

    listDocumentsByThread: async (kbId, threadId) => {
        await initDB();
        return getAll(
            `SELECT ${DOC_SELECT} FROM documents
             WHERE knowledge_base_id = $1 AND metadata->>'threadId' = $2
             ORDER BY (metadata->>'date')::timestamptz NULLS LAST, created_at`,
            [kbId, threadId]
        );
    },

    /** One document, projected (no original_content). */
    getDocument: async (id) => {
        if (!id || !UUID_RE.test(String(id))) return null;
        await initDB();
        return getOne(`SELECT ${DOC_SELECT} FROM documents WHERE id = $1`, [id]);
    },

    /**
     * The stored full text of a document (the reindex path and the content
     * endpoint). Kept separate from getDocument on purpose: nothing that
     * renders a list should ever be handed the body.
     */
    getDocumentOriginalContent: async (id) => {
        await initDB();
        const row = await getOne('SELECT original_content FROM documents WHERE id = $1', [id]);
        return row ? (row.original_content ?? null) : null;
    },

    deleteDocument: async (id, { deletedBy = null, skipSnapshot = false } = {}) => {
        await initDB();
        // Snapshot first so the row can be recovered via listDeletedDocuments.
        // The route handlers used to do this themselves; moving the call here
        // guarantees the snapshot also runs for background callers (reindex
        // cleanup, legacy bulk paths). Pass skipSnapshot:true when the caller
        // has already snapshotted to avoid double-writes.
        if (!skipSnapshot) {
            try {
                await KnowledgeBasesStore.snapshotDocumentVersion(id, deletedBy);
            } catch (e) {
                log.warn('[KnowledgeBases] deleteDocument: snapshot failed', e.message);
            }
        }
        await run('DELETE FROM documents WHERE id = $1', [id]);
        return true;
    },

    /**
     * Change a document's source_uri — used by transactional category_merge
     * swap: ingest new under a temp uri, then rename to the canonical uri
     * once the embeddings land.
     */
    updateDocumentSourceUri: async (id, newSourceUri) => {
        await initDB();
        return run(
            `UPDATE documents SET source_uri = $2 WHERE id = $1`,
            [id, newSourceUri]
        );
    },

    /**
     * Check if ACTIVE content with the same hash already exists in this KB
     * (deduplication). A skipped/error/duplicate row never blocks a retry.
     * Returns the canonical document id or null.
     */
    hasContentHash: async (kbId, contentHash) => {
        const row = await KnowledgeBasesStore.findDocumentByContentHash(kbId, contentHash);
        return row ? row.id : null;
    },

    /**
     * Same lookup, but returns { id, title, source_id, status } so the ingest
     * funnel can tell a same-source duplicate (refuse) from a cross-source
     * overlap (annotate).
     */
    findDocumentByContentHash: async (kbId, contentHash) => {
        await initDB();
        if (!kbId || !contentHash) return null;
        return getOne(
            `SELECT id, title, source_id, status FROM documents
             WHERE knowledge_base_id = $1 AND content_hash = $2 AND ${ACTIVE_STATUS_SQL}
             ORDER BY created_at ASC
             LIMIT 1`,
            [kbId, contentHash]
        );
    },

    /**
     * Find the most recent document in a KB with a given source_uri. Used by the
     * support→KB routine to UPDATE (replace chunks) rather than duplicate when a
     * ticket is re-resolved. Returns the (projected) row or null.
     */
    findDocumentBySourceUri: async (kbId, sourceUri) => {
        await initDB();
        if (!kbId || !sourceUri) return null;
        return getOne(
            `SELECT ${DOC_SELECT} FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2 ORDER BY id DESC LIMIT 1`,
            [kbId, sourceUri]
        );
    },

    /**
     * Update chunk count for a document after ingestion.
     */
    updateChunkCount: async (docId, chunkCount) => {
        await initDB();
        return run('UPDATE documents SET chunk_count = $2, updated_at = now() WHERE id = $1', [docId, chunkCount]);
    },

    /**
     * Compute content hash for deduplication.
     */
    hashContent: (content) => {
        return crypto.createHash('sha256').update(content).digest('hex');
    },

    // ── KB Favorites ────────────────────────────────────────────────────
    listFavorites: async (userId) => {
        await initDB();
        const rows = await getAll(
            `SELECT kb_id FROM kb_favorites WHERE user_id = $1 ORDER BY created_at ASC`,
            [userId]
        );
        return rows.map(r => r.kb_id);
    },
    addFavorite: async (userId, kbId) => {
        await initDB();
        await run(
            `INSERT INTO kb_favorites (user_id, kb_id) VALUES ($1, $2)
             ON CONFLICT (user_id, kb_id) DO NOTHING`,
            [userId, kbId]
        );
    },
    removeFavorite: async (userId, kbId) => {
        await initDB();
        await run(
            `DELETE FROM kb_favorites WHERE user_id = $1 AND kb_id = $2`,
            [userId, kbId]
        );
    },

    // ── KB Versioning ───────────────────────────────────────────────────
    // Snapshot the current state of a KB into kb_versions. Returns the new
    // version number, or null on failure. Best-effort: a failed snapshot
    // must never block the caller's mutation.
    snapshotKBVersion: async (kbId, changedBy, changeReason = null) => {
        await initDB();
        try {
            const kb = await getOne(`SELECT * FROM knowledge_bases WHERE id = $1`, [kbId]);
            if (!kb) return null;
            const next = await getOne(
                `SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM kb_versions WHERE kb_id = $1`,
                [kbId]
            );
            const versionNumber = next?.v || 1;
            await run(
                `INSERT INTO kb_versions (kb_id, version_number, snapshot, changed_by, change_reason)
                 VALUES ($1, $2, $3, $4, $5)`,
                [kbId, versionNumber, JSON.stringify(kb), changedBy || null, changeReason || null]
            );
            return versionNumber;
        } catch (e) {
            log.warn('[KnowledgeBases] snapshotKBVersion failed:', e.message);
            return null;
        }
    },

    listKBVersions: async (kbId, { limit = 50, offset = 0 } = {}) => {
        await initDB();
        return getAll(
            `SELECT id, version_number, changed_by, change_reason, created_at
             FROM kb_versions WHERE kb_id = $1
             ORDER BY version_number DESC LIMIT $2 OFFSET $3`,
            [kbId, limit, offset]
        );
    },

    getKBVersion: async (kbId, versionNumber) => {
        await initDB();
        return getOne(
            `SELECT * FROM kb_versions WHERE kb_id = $1 AND version_number = $2`,
            [kbId, versionNumber]
        );
    },

    // Snapshot a document BEFORE its row is deleted so a re-ingest can
    // recover the original metadata. Chunks themselves live in the
    // search-service; we record what's needed to reconstruct a re-ingest
    // request (title, source URI, content hash). Best-effort.
    //
    // The payload is the PROJECTED row: never original_content. This table
    // has no erasure path of its own, so a full-text copy here would outlive
    // every retention rule and every "delete my data" request.
    snapshotDocumentVersion: async (documentId, deletedBy = null) => {
        await initDB();
        try {
            const doc = await getOne(`SELECT ${DOC_SELECT} FROM documents WHERE id = $1`, [documentId]);
            if (!doc) return null;
            const { original_content: _omit, ...payload } = doc;
            await run(
                `INSERT INTO kb_document_versions
                    (document_id, knowledge_base_id, tenant_id, title, source_type,
                     source_uri, content_hash, payload, deleted_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    doc.id, doc.knowledge_base_id, doc.tenant_id,
                    doc.title, doc.source_type, doc.source_uri,
                    doc.content_hash, JSON.stringify(payload), deletedBy,
                ]
            );
            return doc.id;
        } catch (e) {
            log.warn('[KnowledgeBases] snapshotDocumentVersion failed:', e.message);
            return null;
        }
    },

    /**
     * Retention for kb_document_versions: keep the newest `keepPerDoc`
     * snapshots per document AND drop anything older than `maxAgeDays`.
     * K3's tick calls this. Returns the number of rows removed.
     */
    pruneDocumentVersions: async (keepPerDoc = 3, maxAgeDays = 30) => {
        await initDB();
        const keep = Math.max(0, parseInt(keepPerDoc, 10) || 0);
        const days = Math.max(1, parseInt(maxAgeDays, 10) || 30);
        const r = await run(
            `DELETE FROM kb_document_versions v
              WHERE v.deleted_at < now() - ($2::int * INTERVAL '1 day')
                 OR v.id IN (
                    SELECT id FROM (
                        SELECT id, row_number() OVER (PARTITION BY document_id ORDER BY deleted_at DESC, id DESC) AS rn
                          FROM kb_document_versions
                    ) ranked
                     WHERE ranked.rn > $1
                 )`,
            [keep, days]
        );
        return (r && r.rowCount) || 0;
    },

    listDeletedDocuments: async (kbId, { limit = 100 } = {}) => {
        await initDB();
        return getAll(
            `SELECT id, document_id, title, source_type, source_uri, deleted_at, deleted_by
             FROM kb_document_versions WHERE knowledge_base_id = $1
             ORDER BY deleted_at DESC LIMIT $2`,
            [kbId, limit]
        );
    },
};

module.exports = KnowledgeBasesStore;

// Awaitbare init-ingang voor migrateDb.
module.exports.initDB = initDB;
