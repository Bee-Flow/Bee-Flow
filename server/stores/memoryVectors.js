// @typecheck
/**
 * memoryVectors — the small, DB-free pieces the memory vector path is built
 * from: dimension validation, vector literals, and the tsvector expression.
 *
 * Separate from `memoryStore` for one reason: everything here is a pure
 * function over strings and numbers, so it can be unit-tested without a
 * database. `memoryStore.js` had zero test coverage precisely because every
 * interesting line in it needed a live Postgres.
 *
 * ⚠️ `validateDim` is a SQL-injection boundary, not a sanity check. A vector
 * column name has to be interpolated (`"embedding_384"`) — Postgres has no
 * parameter form for an identifier — so the number that builds it must be
 * proven to be a number before it reaches a query string.
 */

/** Timeout for the retrieval-path embed call. */
// Retrieval runs before the first token of the reply, so it gets a fraction of
// the 30 s ingestion budget and degrades to lexical ranking rather than making
// the user wait on the embedding provider. The previous private chain in
// memoryStore used 8 s, which is long enough to be felt on every single turn.
const MEMORY_QUERY_EMBED_TIMEOUT_MS = 2500;

/** Upper bound on a stored vector, matching pgvector's own column limit. */
const MAX_VECTOR_DIM = 2000;

/**
 * True when `dim` is safe to interpolate into an identifier.
 *
 * Rejects non-integers, NaN, negatives, zero and anything above pgvector's
 * indexable maximum. Everything that builds an `embedding_<dim>` column name
 * must pass through here first.
 */
function validateDim(dim) {
    return Number.isInteger(dim) && dim > 0 && dim <= MAX_VECTOR_DIM;
}

/** Column name for a dimension, or null when the dimension is not usable. */
function vectorColumn(dim) {
    return validateDim(dim) ? `embedding_${dim}` : null;
}

/**
 * Render a JS number array as a pgvector literal.
 *
 * Passed as a bound parameter and cast with `::vector`, so this only has to
 * produce the right shape — but non-finite values are rejected because
 * `NaN`/`Infinity` serialise to text pgvector will not parse, and the
 * resulting error would surface far away from the row that caused it.
 */
function vectorLiteral(vector) {
    if (!Array.isArray(vector) || vector.length === 0) return null;
    for (const n of vector) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    }
    return `[${vector.join(',')}]`;
}

// Whether this Postgres has the Dutch and English snowball dictionaries.
// Probed once by memoryStore.initDB(); a build without them still gets a
// working (if stemless) lexical leg from 'simple'.
let lexicalMultilingual = true;
function setLexicalMultilingual(value) { lexicalMultilingual = !!value; }
function isLexicalMultilingual() { return lexicalMultilingual; }

/**
 * The weighted tsvector expression for a memory's content.
 *
 * Dutch A / English B / simple C, matching
 * `search-service/app/db/queries.py` — the product's users write Dutch, and
 * `knowledgeStore`'s English-only tsvector is why Dutch KB search stems badly.
 * Weighting rather than choosing means a document is searchable in either
 * language without anyone having to detect which one it is in.
 *
 * @param {string} placeholder a bound-parameter reference such as '$1'
 */
function tsvectorExpr(placeholder) {
    if (!lexicalMultilingual) {
        return `setweight(to_tsvector('simple', ${placeholder}), 'A')`;
    }
    return `(setweight(to_tsvector('dutch', ${placeholder}), 'A') || `
         + `setweight(to_tsvector('english', ${placeholder}), 'B') || `
         + `setweight(to_tsvector('simple', ${placeholder}), 'C'))`;
}

/**
 * The query-side counterpart.
 *
 * `websearch_to_tsquery`, never `to_tsquery`. A user's message is arbitrary
 * text — `to_tsquery` raises a syntax error on an unbalanced quote, a colon or
 * a stray ampersand, which in a retrieval path means an exception on a normal
 * sentence. `websearch_to_tsquery` cannot throw on user input.
 */
function tsqueryExpr(placeholder) {
    if (!lexicalMultilingual) {
        return `websearch_to_tsquery('simple', ${placeholder})`;
    }
    return `(websearch_to_tsquery('dutch', ${placeholder}) || `
         + `websearch_to_tsquery('english', ${placeholder}))`;
}

module.exports = {
    MEMORY_QUERY_EMBED_TIMEOUT_MS,
    MAX_VECTOR_DIM,
    validateDim,
    vectorColumn,
    vectorLiteral,
    tsvectorExpr,
    tsqueryExpr,
    setLexicalMultilingual,
    isLexicalMultilingual,
};
