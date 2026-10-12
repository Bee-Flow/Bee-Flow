/**
 * The hybrid-retrieval query BUILDER.
 *
 * Asserted at the SQL-string level on purpose. Every failure mode this guards
 * is silent at the JS level and only shows up as a slow query, a runtime
 * exception on the chat hot path, or — worst — a quietly wrong result set:
 *
 *   • A `vec` leg built with no embedding produces `NULL::vector`, which
 *     Postgres rejects mid-turn.
 *   • A `vec` leg whose literal length disagrees with the column's declared
 *     dimension raises "different vector dimensions", also mid-turn.
 *   • A `scope` CTE without `NOT MATERIALIZED` is materialised from PG12 on, so
 *     every leg linearly scans a temp result and the vector leg can never use
 *     an index.
 *   • The `base` leg disappearing would turn "no embedding provider" from
 *     degraded ranking into no memory at all.
 *
 * Pure — no database.
 *
 * Run: cd server && node --test stores/memoryRetrieval.sql.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    buildCandidateQuery, scopePredicate, art9OwnerOnlySql, LEG_LIMIT, VEC_MIN_COSINE, CANDIDATE_COLUMNS,
} = require('./memoryRetrieval');

const vec384 = Array.from({ length: 384 }, (_, i) => i / 384);

// ── the leg that must never disappear ────────────────────────────────

test('the base leg is present even with no embedding and no query text', () => {
    // This is the whole graceful-degradation story. pgvector missing, provider
    // down, table not backfilled — retrieval must still return the ordering
    // the system used before any of this existed.
    const { sql, legs } = buildCandidateQuery({ userId: 'u1' });
    assert.deepStrictEqual(legs, ['base']);
    assert.ok(sql.includes('importance DESC NULLS LAST, updated_at DESC'));
});

// ── the vec leg's preconditions ──────────────────────────────────────

test('no vec CTE without an embedding — nothing can emit NULL::vector', () => {
    const { sql, legs } = buildCandidateQuery({ userId: 'u1', queryText: 'hallo' });
    assert.ok(!legs.includes('vec'));
    assert.ok(!sql.includes('vec AS ('));
    assert.ok(!sql.includes('::vector'));
});

test('no vec CTE when the vector length disagrees with the dimension', () => {
    // Postgres would raise "different vector dimensions" at query time. The
    // caller derives both from one embedding, so this means a caller bug — and
    // dropping the leg degrades the turn instead of failing it.
    const { legs } = buildCandidateQuery({
        userId: 'u1', dim: 384, queryVector: [0.1, 0.2], queryText: 'hallo',
    });
    assert.deepStrictEqual(legs, ['fts', 'base']);
});

test('a hostile dimension cannot reach the interpolated column name', () => {
    const { sql, legs } = buildCandidateQuery({
        userId: 'u1', dim: '384"; DROP TABLE user_memories; --', queryVector: vec384,
    });
    assert.ok(!legs.includes('vec'));
    assert.ok(!sql.includes('DROP TABLE'));
});

test('a valid embedding produces a bound vector parameter, not an inlined one', () => {
    const { sql, params, legs } = buildCandidateQuery({
        userId: 'u1', dim: 384, queryVector: vec384, queryText: 'hallo',
    });
    assert.deepStrictEqual(legs, ['vec', 'fts', 'base']);
    assert.ok(sql.includes('"embedding_384" <=>'));
    // The literal is bound; only the column name is interpolated.
    assert.ok(params.some(p => typeof p === 'string' && p.startsWith('[0,')));
    assert.ok(!sql.includes('[0,0.0026'));
});

// ── the planner hint ─────────────────────────────────────────────────

test('the scope CTE is NOT MATERIALIZED', () => {
    const { sql } = buildCandidateQuery({ userId: 'u1', dim: 384, queryVector: vec384, queryText: 'x' });
    assert.ok(sql.includes('scope AS NOT MATERIALIZED'));
});

test('every leg is bounded', () => {
    const { sql } = buildCandidateQuery({ userId: 'u1', dim: 384, queryVector: vec384, queryText: 'x' });
    const limits = sql.match(new RegExp(`LIMIT ${LEG_LIMIT}`, 'g')) || [];
    assert.strictEqual(limits.length, 3, 'vec, fts and base each need their own LIMIT');
});

test('an out-of-range legLimit throws rather than building the query', () => {
    assert.throws(() => buildCandidateQuery({ userId: 'u1', legLimit: 0 }));
    assert.throws(() => buildCandidateQuery({ userId: 'u1', legLimit: 5000 }));
    assert.throws(() => buildCandidateQuery({ userId: 'u1', legLimit: '60' }));
});

// ── scope: the isolation rules the previous implementation had ───────

test('outside a project, only the user\'s own non-project rows are in scope', () => {
    const { sql, params } = buildCandidateQuery({ userId: 'u1' });
    assert.ok(sql.includes('user_id = $') && sql.includes('project_id IS NULL'));
    assert.ok(params.includes('u1'));
});

test('inside a project, project data is isolated but behaviour crosses', () => {
    // Project DATA must never leak to the user's global pool, but standing
    // instructions and preferences apply everywhere — the same rule the old
    // path implemented with a second query and a manual merge.
    const { sql } = buildCandidateQuery({ userId: 'u1', projectId: 'p1', includeGeneral: true });
    assert.ok(sql.includes('project_id = $'));
    assert.ok(sql.includes("type IN ('instruction', 'preference')"));
});

test('inside a project with includeGeneral off, nothing crosses the boundary', () => {
    const { sql } = buildCandidateQuery({ userId: 'u1', projectId: 'p1', includeGeneral: false });
    assert.ok(sql.includes('project_id = $'));
    assert.ok(!sql.includes("type IN ('instruction', 'preference')"));
});

test('expired and automation-coverage rows are excluded from every leg', () => {
    // Both filters live in `scope`, which every leg reads, so a new leg cannot
    // forget them. `schedule_coverage` rows render nothing and used to eat
    // candidate slots; expired rows used to stay in the prompt until the next
    // 24-hour sweep.
    const { sql, params } = buildCandidateQuery({ userId: 'u1' });
    assert.ok(sql.includes('(expires_at IS NULL OR expires_at > NOW())'));
    assert.ok(params.includes('schedule_coverage'));
});

test('an agent-scoped read without general memory excludes shared rows', () => {
    const scoped = buildCandidateQuery({ userId: 'u1', agentId: 'a1', includeGeneral: false });
    assert.ok(!scoped.sql.includes('agent_id IS NULL'));

    const shared = buildCandidateQuery({ userId: 'u1', agentId: 'a1', includeGeneral: true });
    assert.ok(shared.sql.includes('agent_id IS NULL'));
});

// ── user input never reaches the SQL text ────────────────────────────

test('the user message is bound, truncated, and never concatenated', () => {
    const nasty = `'; DROP TABLE user_memories; -- ${'x'.repeat(2000)}`;
    const { sql, params } = buildCandidateQuery({ userId: 'u1', queryText: nasty });
    assert.ok(!sql.includes('DROP TABLE'));
    const bound = params.find(p => typeof p === 'string' && p.includes('DROP TABLE'));
    assert.ok(bound, 'the message must be a bound parameter');
    assert.ok(bound.length <= 1000, 'and bounded, so one paste cannot blow up the query');
});

// ── PR2b: validity window, explicit columns, vector floor ────────────

test('only rows with an open validity window are in scope', () => {
    const { sql } = buildCandidateQuery({ userId: 'u1' });
    assert.ok(sql.includes("status = 'active'"));
    assert.ok(sql.includes('valid_to IS NULL'));
});

test('the result lists its columns: no vectors, no tsvector, no ciphertext reach JS', () => {
    const { sql } = buildCandidateQuery({ userId: 'u1', dim: 384, queryVector: vec384, queryText: 'x' });
    assert.ok(!/SELECT s\.\*/.test(sql));
    const select = sql.slice(sql.lastIndexOf('SELECT s.id'));
    for (const col of ['embedding', 'search_vector', 'embedding_enc', 'key_hash', 'embedding_384']) {
        assert.ok(!new RegExp(`s\\.${col}\\b`).test(select), `${col} stays in the database`);
    }
    for (const col of CANDIDATE_COLUMNS) assert.ok(select.includes(`s.${col}`));
});

test('the vec leg has a cosine floor so an orthogonal row cannot take rank 1', () => {
    const { sql } = buildCandidateQuery({ userId: 'u1', dim: 384, queryVector: vec384 });
    assert.ok(sql.includes(`>= ${VEC_MIN_COSINE}`));
    assert.ok(sql.includes('ORDER BY "embedding_384" <=>'), 'ordering by distance is kept so an index can serve it');
});

test('scopePredicate binds every value', () => {
    const params = [];
    const where = scopePredicate({ userId: 'u1', agentId: 'a1', projectId: 'p1' }, (v) => { params.push(v); return `$${params.length}`; });
    assert.ok(!where.includes('u1') && !where.includes('p1'));
    assert.deepStrictEqual(params.filter((p) => ['u1', 'a1', 'p1'].includes(p)).sort(), ['a1', 'p1', 'u1']);
});

test('art. 9 rows are excluded from the scope unless the caller opts in', () => {
    const closed = buildCandidateQuery({ userId: 'u1' });
    assert.ok(closed.sql.includes(`COALESCE(sensitivity, 'none') <> 'art9'`));
    const open = buildCandidateQuery({ userId: 'u1', includeSensitive: true });
    assert.ok(open.sql.includes(`(COALESCE(sensitivity, 'none') <> 'art9' OR user_id = $`), 'opted in: art9 only of the reading user');
    const ownerParam = open.sql.match(/OR user_id = \$(\d+)\)/)[1];
    assert.strictEqual(open.params[Number(ownerParam) - 1], 'u1');
});

test('art. 9 is owner-only even when the reader opted in and reads a project pool', () => {
    const pool = buildCandidateQuery({ userId: 'u1', projectId: 'p1', includeSensitive: true });
    const n = Number(pool.sql.match(/OR user_id = \$(\d+)\)/)[1]);
    assert.strictEqual(pool.params[n - 1], 'u1');
    assert.strictEqual(art9OwnerOnlySql(3), `(COALESCE(sensitivity, 'none') <> 'art9' OR user_id = $3)`);
    assert.strictEqual(art9OwnerOnlySql('$2', 'm'), `(COALESCE(m.sensitivity, 'none') <> 'art9' OR m.user_id = $2)`);
});
