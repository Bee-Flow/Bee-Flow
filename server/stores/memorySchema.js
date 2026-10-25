// @typecheck strict
/**
 * stores/memorySchema.js — DDL, migrations and the v2 backfill of the memory
 * store (user_memories, memory_sources). stores/memoryStore wraps _initDB in
 * the store's one initDB memo. Split out of stores/memoryStore.js.
 */

const { exec } = require('../db');
const log = require('../telemetry/log');
const { dep } = require('./memoryDeps');
const memoryIndex = dep('memoryIndex');
const { ENVELOPE_LIKE } = dep('memoryCrypto');

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS user_memories (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            agent_id TEXT,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            subject TEXT,
            attribute TEXT,
            value TEXT,
            confidence REAL DEFAULT 1.0,
            status TEXT DEFAULT 'active',
            superseded_by TEXT,
            source_message_id TEXT,
            evidence_quote TEXT,
            last_confirmed_at TIMESTAMPTZ,
            summary TEXT,
            importance REAL DEFAULT 0.5,
            access_count INTEGER DEFAULT 0,
            last_accessed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            project_id TEXT
        )
    `);
    // Add embedding column if not present
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding JSONB`);
    // Add project_id column if not present from older migrations
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS project_id TEXT`);
    // R3: tag memories that came out of a Cowork schedule run as an agent, so
    // the system-prompt addendum can list "previously covered" topics for the
    // SAME schedule and we can prune them on a schedule.
    //
    // These were "routine" coverage memories before agent routines moved into
    // Cowork (2026-10): the column, its index and the type value are renamed in
    // place, once, before anything reads them under the new names.
    // A database can hold BOTH names (the new column and index were created
    // before the rename ran): then the old rows are copied over and the old
    // index dropped, because renaming onto an existing index fails every init.
    await exec(`
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = 'user_memories' AND column_name = 'source_routine_id') THEN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = 'user_memories' AND column_name = 'source_schedule_id') THEN
                    ALTER TABLE user_memories RENAME COLUMN source_routine_id TO source_schedule_id;
                ELSE
                    UPDATE user_memories SET source_schedule_id = source_routine_id
                        WHERE source_schedule_id IS NULL AND source_routine_id IS NOT NULL;
                END IF;
            END IF;
            UPDATE user_memories SET type = 'schedule_coverage' WHERE type = 'routine_coverage';
            IF to_regclass('idx_memories_routine') IS NOT NULL THEN
                IF to_regclass('idx_memories_schedule') IS NULL THEN
                    ALTER INDEX idx_memories_routine RENAME TO idx_memories_schedule;
                ELSE
                    DROP INDEX idx_memories_routine;
                END IF;
            END IF;
        END $$`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS source_schedule_id TEXT`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_schedule ON user_memories(source_schedule_id) WHERE source_schedule_id IS NOT NULL`);
    // Provenance, validity window, blind index and usage columns (memory v2).
    // See the status/origin/sensitivity notes at the top of this file, and
    // stores/memoryCrypto.js for key_hash and embedding_enc.
    // origin is added WITHOUT its default, like valid_from: the backfill below
    // sets the origin of every legacy row (NULL = "existed before this column"),
    // and only then is the default attached for new rows.
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS origin TEXT`);
    // Pending row that conflicts with an explicit memory: the id it replaces on approval.
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS replaces_id TEXT`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS sensitivity TEXT DEFAULT 'none'`);
    // valid_from is added WITHOUT its default first: ADD COLUMN ... DEFAULT NOW()
    // would stamp every existing row with the upgrade time. The backfill below
    // sets it from created_at, then the default is attached for new rows.
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS source_conversation_id TEXT`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS key_hash TEXT`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding_dim INTEGER`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embedding_enc TEXT`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS use_count INTEGER DEFAULT 0`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    // When the LLM review pass (jobs/memoryConsolidation.js) judged the row; a user edit sets it too, so edited rows are never auto-archived.
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
    await exec(`
        CREATE TABLE IF NOT EXISTS memory_sources (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            message_content TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON user_memories(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON user_memories(agent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON user_memories(type)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_status ON user_memories(status)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_project ON user_memories(project_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON user_memories(user_id, type, subject, attribute)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memory_sources ON memory_sources(memory_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_key_hash ON user_memories(user_id, key_hash) WHERE status = 'active'`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_source_conv ON user_memories(source_conversation_id)`);
    await backfillMemoryColumns();
    // search_vector (trigger-maintained, NULL for sealed rows), the pgvector
    // probe and the embed bookkeeping columns. See stores/memoryIndex.js.
    await memoryIndex.ensureIndexSchema();
    // Phase 2: composite index for the hot retrieve path (user_id+status filter)
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_user_status_type ON user_memories(user_id, status, type)`);

    // Migration: FK constraint on project_id so deleting a project also
    // removes its memories (otherwise rows linger and stay queryable after
    // the access-check on /api/memories was tightened). Requires the
    // projects table to exist, so initialise projectStore first.
    try {
        const projectStore = require('./projectStore');
        if (typeof projectStore.initDB === 'function') await projectStore.initDB();

        await exec(`
            DELETE FROM user_memories
              WHERE project_id IS NOT NULL
                AND project_id NOT IN (SELECT id FROM projects);
        `);
        await exec(`
            DO $$ BEGIN
                ALTER TABLE user_memories
                  ADD CONSTRAINT user_memories_project_fk
                  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
    } catch (e) {
        log.warn('[MemoryStore] project_id FK migration skipped:', e.message);
    }
}


/**
 * One-time (idempotent) backfills for rows that predate the v2 columns. Run by
 * _initDB on every boot; a no-op once nothing is left to fill.
 */
async function backfillMemoryColumns() {
    // Everything here is additive and idempotent (each UPDATE is guarded by an
    // IS NULL), so an interrupted boot just continues next time and an older
    // build running against the upgraded schema is unaffected (new columns are
    // nullable or defaulted; nothing is renamed or dropped).
    // origin of legacy rows. The column is added without a default, so exactly
    // the rows that predate it are NULL here; rows written by this version
    // always carry an origin and are never touched (and once the default is
    // attached below, nothing is NULL again), which makes this one-time and
    // idempotent without a marker. Before this version only two things wrote a
    // row without extraction evidence AND without a canonical key: the Memory
    // panel and the remember tool, both the person's own words -> 'explicit'.
    // The extractor always stored an evidence_quote or a subject/attribute, so
    // the rest stays the honest 'inferred'. An interrupted boot just continues.
    // A row the extractor wrote always got a memory_sources row (its conversation),
    // even when an older extractor stored no evidence or subject: that is not the
    // person's own words, so it stays 'inferred' and the quality pass can judge it.
    await exec(`UPDATE user_memories m SET origin = CASE WHEN m.evidence_quote IS NULL AND m.subject IS NULL
                   AND NOT EXISTS (SELECT 1 FROM memory_sources s WHERE s.memory_id = m.id)
                 THEN 'explicit' ELSE 'inferred' END WHERE m.origin IS NULL`);
    await exec(`ALTER TABLE user_memories ALTER COLUMN origin SET DEFAULT 'inferred'`);
    await exec(`UPDATE user_memories SET valid_from = COALESCE(created_at, NOW()) WHERE valid_from IS NULL`);
    await exec(`ALTER TABLE user_memories ALTER COLUMN valid_from SET DEFAULT NOW()`);
    await exec(`UPDATE user_memories SET valid_to = updated_at WHERE status = 'superseded' AND valid_to IS NULL`);
    await exec(`
        UPDATE user_memories SET embedding_dim = jsonb_array_length(embedding)
         WHERE embedding_dim IS NULL AND embedding IS NOT NULL AND jsonb_typeof(embedding) = 'array'`);
    // Provenance: the oldest memory_sources row names the conversation.
    await exec(`
        UPDATE user_memories m SET source_conversation_id = s.conversation_id
          FROM (SELECT DISTINCT ON (memory_id) memory_id, conversation_id
                  FROM memory_sources ORDER BY memory_id, created_at ASC) s
         WHERE s.memory_id = m.id AND m.source_conversation_id IS NULL`);
    // Blind index for legacy PLAINTEXT rows: the plain digest of the canonical
    // key (same normalisation as memoryCrypto.canonicalKey). Sealed rows cannot
    // exist without a key_hash, so the NOT LIKE guard is belt and braces.
    await exec(`
        UPDATE user_memories
           SET key_hash = encode(sha256(convert_to(
                 regexp_replace(lower(btrim(type)), '\\s+', ' ', 'g') || '|' ||
                 regexp_replace(lower(btrim(subject)), '\\s+', ' ', 'g') || '|' ||
                 regexp_replace(lower(btrim(attribute)), '\\s+', ' ', 'g'), 'UTF8')), 'hex')
         WHERE key_hash IS NULL AND subject IS NOT NULL AND attribute IS NOT NULL
           AND subject NOT LIKE '${ENVELOPE_LIKE}'`);
}

module.exports = { _initDB, backfillMemoryColumns };
