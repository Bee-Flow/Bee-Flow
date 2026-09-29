/**
 * The SQL fragments the memory vector path is built from.
 *
 * Two of these are security boundaries rather than sanity checks:
 *
 *   • `validateDim` guards an INTERPOLATED identifier. A pgvector column name
 *     (`"embedding_384"`) cannot be a bound parameter, so the number that
 *     builds it reaches a query string directly. Everything that is not a
 *     plain positive integer has to be refused here or nowhere.
 *
 *   • `tsqueryExpr` must emit `websearch_to_tsquery`. `to_tsquery` raises a
 *     syntax error on ordinary punctuation — an unbalanced quote, a colon, a
 *     stray `&` — and this expression is fed the user's chat message. With
 *     `to_tsquery` a message like `What's the status: A & B?` throws inside
 *     retrieval, on the hot path, for a perfectly normal sentence.
 *
 * Run: cd server && node --test stores/memoryVectors.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    validateDim, vectorColumn, vectorLiteral,
    tsvectorExpr, tsqueryExpr,
    setLexicalMultilingual, isLexicalMultilingual,
    MAX_VECTOR_DIM,
} = require('./memoryVectors');

// ── validateDim: the injection boundary ──────────────────────────────

test('validateDim accepts the dimensions providers actually return', () => {
    for (const dim of [384, 768, 1024, 1536]) {
        assert.strictEqual(validateDim(dim), true, `dim ${dim} should be valid`);
    }
});

test('validateDim refuses everything that is not a plain positive integer', () => {
    const hostile = [
        '384', '384; DROP TABLE user_memories', '384 OR 1=1',
        384.5, -384, 0, NaN, Infinity, null, undefined, {}, [], '1e3',
        MAX_VECTOR_DIM + 1,
    ];
    for (const value of hostile) {
        assert.strictEqual(validateDim(value), false, `${String(value)} must be rejected`);
    }
});

test('vectorColumn returns null rather than a column name for a bad dimension', () => {
    // The caller checks for null; returning a string would put the hostile
    // value straight into an identifier.
    assert.strictEqual(vectorColumn('384; --'), null);
    assert.strictEqual(vectorColumn(384), 'embedding_384');
});

// ── vectorLiteral ────────────────────────────────────────────────────

test('vectorLiteral renders the pgvector literal form', () => {
    assert.strictEqual(vectorLiteral([0.1, -0.2, 3]), '[0.1,-0.2,3]');
});

test('vectorLiteral refuses a vector containing NaN or Infinity', () => {
    // These serialise to text pgvector cannot parse, and the error would
    // surface far from the row that produced it.
    assert.strictEqual(vectorLiteral([1, NaN, 3]), null);
    assert.strictEqual(vectorLiteral([1, Infinity]), null);
    assert.strictEqual(vectorLiteral([1, '2']), null);
    assert.strictEqual(vectorLiteral([]), null);
    assert.strictEqual(vectorLiteral(null), null);
});

// ── the text-search expressions ──────────────────────────────────────

test('the query side uses websearch_to_tsquery, never to_tsquery', () => {
    const expr = tsqueryExpr('$1');
    assert.ok(expr.includes('websearch_to_tsquery'), 'must use the non-throwing parser');
    // `to_tsquery(` as a standalone call would be the throwing variant.
    assert.ok(!/[^_]to_tsquery\(/.test(expr), 'must not fall back to to_tsquery');
});

test('the stored side weights Dutch above English above simple', () => {
    const expr = tsvectorExpr('$1');
    // The product's users write Dutch; knowledgeStore's English-only tsvector
    // is why Dutch stems badly there. Order matters: A outranks B outranks C.
    const dutch = expr.indexOf("to_tsvector('dutch'");
    const english = expr.indexOf("to_tsvector('english'");
    const simple = expr.indexOf("to_tsvector('simple'");
    assert.ok(dutch >= 0 && english > dutch && simple > english);
    assert.ok(expr.includes("'A'") && expr.includes("'B'") && expr.includes("'C'"));
});

test('both expressions degrade to simple when the dictionaries are missing', (t) => {
    t.after(() => setLexicalMultilingual(true));

    setLexicalMultilingual(false);
    assert.strictEqual(isLexicalMultilingual(), false);

    // A stripped-down Postgres has no snowball dictionaries. 'simple' always
    // exists, so the lexical leg keeps working stemlessly instead of every
    // write throwing.
    assert.ok(!tsvectorExpr('$1').includes('dutch'));
    assert.ok(tsvectorExpr('$1').includes("'simple'"));
    assert.ok(tsqueryExpr('$1').includes('websearch_to_tsquery'));
    assert.ok(!tsqueryExpr('$1').includes('dutch'));
});

test('the placeholder is passed through, never inlined', () => {
    // A caller must be able to bind the value. If these built a literal from a
    // JS string the user's message would be concatenated into SQL.
    assert.ok(tsvectorExpr('$7').includes('$7'));
    assert.ok(tsqueryExpr('$3').includes('$3'));
});
