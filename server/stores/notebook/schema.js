// @typecheck noImplicitAny
/**
 * stores/notebook/schema.js — DDL and migrations of the notebook store
 * (notebooks, notebook_sources, notebook_versions). The one initDB memo every
 * notebook module awaits. Split out of stores/notebookStore.js.
 */

const { dep } = require('./deps');
const { exec } = dep('db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl, CODES } = require('../lib/_ddl');
const log = require('../../telemetry/log');
const { sharingDdl } = dep('documentSharing');

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

    // Column migrations via runDdl (stores/lib/_ddl.js): errors are collected
    // per statement and reported loudly instead of swallowed silently; one
    // catch around four statements also hid which of the four failed.
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
        // Who last changed the DOCUMENT, and when: the project card's "Edited by
        // Anna · 5 min ago". An id only; names are resolved at read time with
        // the reader's access, never copied here.
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS last_edited_by TEXT DEFAULT NULL`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ DEFAULT NULL`,
        // A notebook is a document type: it is listed in the Documents
        // library next to pages and designed documents (stores/notebookLibrary.js)
        // and filed the same way there, in one of the owner's document folders
        // and under categories. Adding the columns is the whole upgrade: every
        // existing notebook is in the library from the first boot, unfiled.
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS folder_id TEXT DEFAULT NULL`,
        `ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]'::jsonb`,
        `CREATE INDEX IF NOT EXISTS idx_notebooks_user_updated ON notebooks(user_id, updated_at DESC)`,
    ]);

    await exec(sharingDdl('notebooks'));

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
        CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook_status ON notebook_sources(notebook_id, status);
        -- V2 source improvements: manual ordering, ingestion stage, and stored
        -- original text so pasted-text / meeting sources become retryable.
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS stage TEXT;
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS content_text TEXT;
        -- Which record a source was copied from (a meeting's id for type
        -- 'meeting'), so "what happens to this meeting" can name the notebooks
        -- that hold it instead of saying it could not check them. The partial
        -- index keeps meetingUsage's probe for older, ref-less meeting rows cheap.
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS source_ref_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_notebook_sources_ref ON notebook_sources(source_ref_id) WHERE source_ref_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_notebook_sources_meeting_noref ON notebook_sources(id) WHERE type = 'meeting' AND source_ref_id IS NULL;
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

    // The uniform version model shared with Studio documents: a version is the
    // state AFTER a checkpoint, numbered per notebook, with why it exists
    // (`source`), who made it and an optional name. Rows written before this
    // are "before" snapshots and keep source 'legacy'.
    await runDdl('notebookStore', [
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS seq INTEGER`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy'`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS name TEXT`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS created_by TEXT`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS contributors JSONB NOT NULL DEFAULT '[]'::jsonb`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS stats JSONB`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS content_hash TEXT`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS restored_from TEXT`,
        `ALTER TABLE notebook_versions ADD COLUMN IF NOT EXISTS content_md TEXT`,
        // Number the rows that have none yet, oldest first, after whatever the
        // notebook already numbered. Only touches NULL rows, so it is a no-op
        // on every boot after the first.
        {
            sql: `UPDATE notebook_versions v SET seq = s.base + s.rn
                    FROM (SELECT x.id,
                                 ROW_NUMBER() OVER (PARTITION BY x.notebook_id ORDER BY x.created_at, x.id) AS rn,
                                 COALESCE((SELECT MAX(m.seq) FROM notebook_versions m WHERE m.notebook_id = x.notebook_id), 0) AS base
                            FROM notebook_versions x
                           WHERE x.seq IS NULL) s
                   WHERE v.id = s.id AND v.seq IS NULL`,
            tolerate: CODES.UNIQUE_VIOLATION,
            reden: 'a version written concurrently during boot took the number; the next boot numbers the rest',
        },
        // Race-safe numbering: two writers computing MAX(seq)+1 at once collide
        // here; insertVersionRow serializes writers on the notebook lock.
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_notebook_versions_seq ON notebook_versions(notebook_id, seq) WHERE seq IS NOT NULL`,
    ]);
    log.info('[NotebookStore] PostgreSQL initialized');
}

module.exports = { initDB };
