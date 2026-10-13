// @typecheck
/**
 * stores/kb/schema.js — the knowledge-base tables (knowledge_bases,
 * documents, kb_versions, kb_document_versions, kb_categories, kb_favorites),
 * their column migrations and the one-off migration files, in boot order.
 * Split out of stores/knowledgeBases.js; the barrel wraps the result in its
 * makeStoreInit memo.
 */

/**
 * The schema init over the barrel's db handle. `ensureSourcesSchema` is
 * kbSources' ensureSchema, resolved lazily by the barrel (kbSources requires
 * the barrel back).
 *
 * @param {{
 *   exec: (sql: string) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   runDdl: (tag: string, statements: any[]) => Promise<any>,
 *   CODES: Record<string, string>,
 *   log: any,
 *   ensureSourcesSchema: () => Promise<unknown>,
 * }} deps
 * @returns {() => Promise<void>}
 */
function makeSchemaInit({ exec, getOne, runDdl, CODES, log, ensureSourcesSchema }) {
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
        try { await require('../../migrations/drop-kb-default-lang').up(); } catch (e) { log.error('[KnowledgeBases] migratie drop-kb-default-lang gefaald:', e.message); }
        // Add usage_contexts + source_kind columns and backfill auto-created KBs.
        try { await require('../../migrations/add-kb-usage-contexts').up(); } catch (e) { log.error('[KnowledgeBases] migratie add-kb-usage-contexts gefaald:', e.message); }
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
        // check starts demanding it — otherwise every existing automation fails its
        // next activation on a base nobody changed.
        try { await require('../../migrations/add-kb-ai-step-context').up(); } catch (e) { log.error('[KnowledgeBases] migratie add-kb-ai-step-context gefaald:', e.message); }

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
        await ensureSourcesSchema();
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

    return _initDB;
}

module.exports = { makeSchemaInit };
