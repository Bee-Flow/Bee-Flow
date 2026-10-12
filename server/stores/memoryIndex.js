// @typecheck
/**
 * memoryIndex — the search indexes on `user_memories`: the weighted tsvector
 * (`search_vector`), the pgvector columns (`embedding_<dim>`) and the
 * bookkeeping the embedding backfill needs (`embed_attempts`, `embed_failed_at`).
 *
 * ── Sealed rows are never indexed in the clear ──────────────────────────────
 * A sealed row (its `content` is an envelope) must not leak through an index:
 * a tsvector of the plaintext or a plaintext vector column would undo the
 * encryption. Three guards, so no single write path has to remember:
 *   • the tsvector is maintained by a trigger that leaves it NULL for an
 *     envelope (or NULL content), whichever statement wrote the row;
 *   • `writeVector` refuses a sealed row in SQL;
 *   • the backfill job scrubs any index left on a sealed row (`scrubSealedIndexes`).
 * Sealed rows keep their vector only in `embedding_enc`, scored in JS.
 *
 * ── pgvector is optional ────────────────────────────────────────────────────
 * Probed once (same rule as core/kb/localKBIngest: only a SQL-level rejection
 * proves the extension is absent; an unreachable database rethrows). Without
 * it the vector columns are never created and retrieval scores in JS.
 *
 * No `core/` imports: the embed function is passed in by memoryStore.
 */

const { run, getOne, getAll, exec, isSqlStateError } = require('../db');
const log = require('../telemetry/log');
const {
    validateDim, vectorColumn, vectorLiteral, tsvectorExpr, setLexicalMultilingual,
} = require('./memoryVectors');
const { ENVELOPE_LIKE } = require('./memoryCrypto');

/** @type {boolean|null} null = not probed yet */
let pgvector = null;
/** @type {Set<string>} typed vector columns that exist on user_memories */
const vectorCols = new Set();

function isPgvectorAvailable() { return pgvector === true; }

async function probePgvector() {
    if (pgvector !== null) return pgvector;
    try {
        await exec('CREATE EXTENSION IF NOT EXISTS vector');
        pgvector = true;
    } catch (e) {
        if (typeof isSqlStateError === 'function' && !isSqlStateError(e)) throw e;
        log.warn('[MemoryStore] pgvector not available — memory retrieval scores vectors in JS.');
        pgvector = false;
    }
    return pgvector;
}

/** Test seam: forget what was probed (a test swaps the database). */
function _resetForTests() { pgvector = null; vectorCols.clear(); }

/** Columns, tsvector trigger, GIN index; remembers which vector columns exist. */
async function ensureIndexSchema() {
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS search_vector tsvector`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embed_attempts INTEGER DEFAULT 0`);
    await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS embed_failed_at TIMESTAMPTZ`);

    const dict = await getOne(`SELECT (SELECT COUNT(*) FROM pg_ts_config WHERE cfgname IN ('dutch', 'english')) = 2 AS ok`);
    if (dict && typeof dict.ok === 'boolean') setLexicalMultilingual(dict.ok);

    await exec(`
        CREATE OR REPLACE FUNCTION user_memories_set_search_vector() RETURNS trigger AS $fn$
        BEGIN
            IF NEW.content IS NULL OR NEW.content LIKE '${ENVELOPE_LIKE}' THEN
                NEW.search_vector := NULL;
            ELSE
                NEW.search_vector := ${tsvectorExpr('NEW.content')};
            END IF;
            RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql`);
    await exec(`DROP TRIGGER IF EXISTS trg_user_memories_search_vector ON user_memories`);
    await exec(`
        CREATE TRIGGER trg_user_memories_search_vector
        BEFORE INSERT OR UPDATE OF content ON user_memories
        FOR EACH ROW EXECUTE FUNCTION user_memories_set_search_vector()`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_memories_search_vector ON user_memories USING gin(search_vector)`);

    if (await probePgvector()) {
        const cols = await getAll(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'user_memories'
                AND column_name ~ '^embedding_[0-9]+$'`);
        for (const c of cols || []) vectorCols.add(c.column_name);
    }
}

/** True when the typed vector column for `dim` exists. */
function hasVectorColumn(dim) {
    const col = vectorColumn(dim);
    return !!col && vectorCols.has(col);
}

function vectorColumnNames() { return [...vectorCols]; }

/**
 * Create `embedding_<dim>` (idempotent). False when pgvector is absent, the
 * dimension is unusable, or the DDL was refused. The HNSW index is NOT made
 * here: below the backfill job's threshold an exact scan is correct and an ANN
 * index applies the owner filter after the scan (see the job).
 */
async function ensureVectorColumn(dim) {
    if (!validateDim(dim) || !(await probePgvector())) return false;
    const col = /** @type {string} */ (vectorColumn(dim));
    if (vectorCols.has(col)) return true;
    try {
        await exec(`ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS "${col}" vector(${dim})`);
        vectorCols.add(col);
        return true;
    } catch (e) {
        log.warn(`[MemoryStore] could not create ${col}:`, e.message);
        return false;
    }
}

/**
 * Store a PLAINTEXT row's vector in the typed column (guarded in SQL against a
 * sealed row) and clear the other dimensions' stale vectors. Returns whether a
 * row was written.
 */
async function writeVector(memoryId, vector) {
    const literal = vectorLiteral(vector);
    if (!literal || !(await ensureVectorColumn(vector.length))) return false;
    const col = vectorColumn(vector.length);
    const stale = vectorColumnNames().filter(c => c !== col).map(c => `, "${c}" = NULL`).join('');
    const res = await run(
        `UPDATE user_memories SET "${col}" = $1::vector${stale}, embed_attempts = 0, embed_failed_at = NULL
          WHERE id = $2 AND embedding_enc IS NULL AND content NOT LIKE '${ENVELOPE_LIKE}'`,
        [literal, memoryId]);
    return (res?.rowCount || 0) > 0;
}

/** Null every plaintext index on rows that are sealed. Idempotent. */
async function scrubSealedIndexes() {
    const sets = ['search_vector = NULL', ...vectorColumnNames().map(c => `"${c}" = NULL`)];
    const anyIndexed = ['search_vector IS NOT NULL', ...vectorColumnNames().map(c => `"${c}" IS NOT NULL`)].join(' OR ');
    const res = await run(
        `UPDATE user_memories SET ${sets.join(', ')}
          WHERE content LIKE '${ENVELOPE_LIKE}' AND (${anyIndexed})`);
    return res?.rowCount || 0;
}

/** Count a failed embed so the backfill stops retrying a hopeless row. */
async function noteEmbedFailure(memoryId) {
    await run(
        `UPDATE user_memories SET embed_attempts = COALESCE(embed_attempts, 0) + 1, embed_failed_at = NOW() WHERE id = $1`,
        [memoryId]);
}

module.exports = {
    isPgvectorAvailable, probePgvector, ensureIndexSchema, ensureVectorColumn, hasVectorColumn,
    vectorColumnNames, writeVector, scrubSealedIndexes, noteEmbedFailure, _resetForTests,
};
