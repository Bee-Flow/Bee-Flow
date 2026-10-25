// @typecheck strict
/**
 * The `kb_chunks` table: its bootstrap, its dimension reconcile, and the one
 * place that knows whether pgvector is available. The flags are module state;
 * read them through `isPgvectorAvailable()` so every caller sees the live
 * value after `ensureKBChunksTable` has run.
 */

const { exec, getAll, isSqlStateError } = require('../../db');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

// ── Database schema bootstrap ───────────────────────────────────────

let schemaInitialized = false;
let pgvectorAvailable = true;

/**
 * @param {number} [vectorDim]
 */
async function ensureKBChunksTable(vectorDim) {
    // Bootstrap-only call (no specific dim requested) returns once the
    // schema is known to exist. We still run the CREATE EXTENSION + initial
    // CREATE TABLE the first time to populate pgvectorAvailable.
    if (schemaInitialized && vectorDim == null) return;
    if (schemaInitialized && !pgvectorAvailable) return;

    if (!schemaInitialized) {
        // Only a SQL-level rejection proves the extension is unavailable. An
        // unreachable database must rethrow: the statements below can still
        // succeed once the pool recovers, and reaching `schemaInitialized =
        // true` with a wrongly-latched flag disables vector search for the
        // rest of the process. Throwing keeps the schema uninitialised so the
        // next call re-probes.
        try {
            await exec('CREATE EXTENSION IF NOT EXISTS vector');
            pgvectorAvailable = true;
        } catch (e) {
            if (!isSqlStateError(e)) throw e;
            log.warn('[LocalKBIngest] pgvector extension not available — vector search disabled, keyword search will still work. Install postgresql-XX-pgvector to enable.');
            pgvectorAvailable = false;
        }
    }

    // Dim reconcile — only when caller explicitly asked for a dim. Empty
    // tables can be ALTERed safely; non-empty ones with mismatched dim are
    // logged but NOT thrown — the INSERT will fail with a clearer pgvector
    // error if dim actually matters at write time, and reads can still try.
    if (pgvectorAvailable && schemaInitialized && vectorDim != null) {
        try {
            const dimRows = await getAll(`
                SELECT a.atttypmod AS typmod
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                WHERE c.relname = 'kb_chunks' AND a.attname = 'embedding' AND a.attnum > 0
            `);
            const currentDim = dimRows?.[0]?.typmod;
            if (currentDim && currentDim !== vectorDim) {
                const countRows = await getAll('SELECT COUNT(*)::int AS n FROM kb_chunks');
                const rows = countRows?.[0]?.n || 0;
                if (rows === 0) {
                    log.info(`[LocalKBIngest] kb_chunks dim mismatch (${currentDim} → ${vectorDim}), table is empty — ALTERing column`);
                    await exec(`ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE VECTOR(${vectorDim})`);
                    try { await exec(`DROP INDEX IF EXISTS idx_kb_chunks_embedding`); } catch (_) { bestEffort('core/kb/kbChunksSchema:ensureKBChunksTable', _); /* index absent or not droppable, it is recreated next */ }
                    try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`); } catch (_) { bestEffort('core/kb/kbChunksSchema:ensureKBChunksTable#2', _); /* hnsw index needs pgvector, search falls back to a scan */ }
                } else {
                    // A configured model switch is migrated before any ingest
                    // gets here (core/kb/embeddingMigration.js). What remains
                    // is a vector from a FALLBACK embedder (provider down →
                    // CPU/Azure): refusing it is right, it is not the model
                    // the stored vectors belong to.
                    log.warn(`[LocalKBIngest] kb_chunks dim mismatch (table=${currentDim}, requested=${vectorDim}) with ${rows} existing rows — the vectors did not come from the configured embedding model (provider unavailable?).`);
                    return { mismatch: { currentDim, vectorDim } };
                }
            }
        } catch (err) {
            log.warn(`[LocalKBIngest] dim reconcile check skipped: ${/** @type {Error} */ (err).message}`);
        }
        return;
    }

    // Create kb_chunks table matching the search-service schema. Default dim
    // for the *initial* table creation falls back to 1024 (mistral-embed) —
    // most common provider in current deployments. The actual provider's dim
    // will be reconciled on the next ingest call regardless of this default.
    const initialDim = vectorDim || 1024;
    if (pgvectorAvailable) {
        await exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id            BIGSERIAL PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                document_id   TEXT NOT NULL,
                chunk_id      INT NOT NULL,
                lang          TEXT,
                title         TEXT,
                content       TEXT NOT NULL,
                tsv           TSVECTOR,
                embedding     VECTOR(${initialDim}),
                source_uri    TEXT,
                chunk_type    TEXT DEFAULT 'content',
                created_at    TIMESTAMPTZ DEFAULT now()
            )
        `);
    } else {
        await exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id            BIGSERIAL PRIMARY KEY,
                tenant_id     TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                document_id   TEXT NOT NULL,
                chunk_id      INT NOT NULL,
                lang          TEXT,
                title         TEXT,
                content       TEXT NOT NULL,
                tsv           TSVECTOR,
                source_uri    TEXT,
                chunk_type    TEXT DEFAULT 'content',
                created_at    TIMESTAMPTZ DEFAULT now()
            )
        `);
    }

    // Create indexes
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tsv ON kb_chunks USING GIN (tsv)'); } catch (_) { log.warn('tsv index could not be created', _); }
    if (pgvectorAvailable) {
        try { await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`); } catch (_) { bestEffort('core/kb/kbChunksSchema:ensureKBChunksTable#3', _); /* hnsw index needs pgvector, search falls back to a scan */ }
    }
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb ON kb_chunks (tenant_id, knowledge_base_id)'); } catch (_) { log.warn('tenant_kb index could not be created', _); }
    try { await exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant_kb_doc ON kb_chunks (tenant_id, knowledge_base_id, document_id)'); } catch (_) { log.warn('tenant_kb_doc index could not be created', _); }

    // Ensure chunk_type column exists (safe migration for existing tables)
    try { await exec("ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS chunk_type TEXT DEFAULT 'content'"); } catch (_) { log.warn('chunk_type column could not be added', _); }

    // The page a chunk's text starts on, for a citation that can be checked
    // (K6). NULL for everything ingested before this existed — those bytes
    // were never kept, so the page cannot be recovered and the chip simply
    // says less. A source that re-fetches fills it in on its next refresh.
    try { await exec('ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_start INT'); } catch (_) { log.warn('page_start column could not be added', _); }

    // Issue #11: Ensure documents table has original_content column for reindexing
    try { await exec("ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_content TEXT"); } catch (_) { log.warn('original_content column could not be added', _); }

    schemaInitialized = true;
    log.info('[LocalKBIngest] kb_chunks table ensured');
}

function isPgvectorAvailable() {
    return pgvectorAvailable;
}

module.exports = { ensureKBChunksTable, isPgvectorAvailable };
