// @typecheck
/**
 * webpage_versions: the NUMBER, the MAKER and the LINE DIFFERENCE, against a
 * real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js). Object
 * storage is not configured, so only the rows move.
 *
 * "v14" has to mean something. Two things can break that:
 *
 *   1. TWO WRITERS, ONE NUMBER. The number is computed in the INSERT
 *      (`COALESCE(MAX(seq),0)+1`). Under READ COMMITTED two concurrent saves
 *      see the same maximum; the unique index (webpage_id, seq) turns the
 *      second into a 23505, and the store tries again with a fresh maximum.
 *      PGlite is one session, so the collision is raised by a trigger that
 *      fails the first N inserts with the real SQLSTATE; a sequence counts the
 *      attempts, because nextval survives the rolled-back statement.
 *   2. A NUMBER THAT MEASURES NOTHING. `line_delta`, `seq` and the maker are
 *      NULL on rows from before their columns; flattening them with `|| 0`
 *      would make the list say "v0" and "0 lines changed".
 *
 * Run: cd server && node --test stores/webpage/versions.seq.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const versions = require('./versions');
const { initDB } = require('./schema');

test.before(async () => {
    await initDB();
    await pg.exec(`
        CREATE SEQUENCE insert_attempts;
        CREATE TABLE insert_fault (fail_first INT NOT NULL, code TEXT NOT NULL);
        INSERT INTO insert_fault VALUES (0, '23505');
        CREATE FUNCTION insert_fault_fn() RETURNS trigger AS $$
        DECLARE n BIGINT := nextval('insert_attempts');
        DECLARE cfg insert_fault;
        BEGIN
            SELECT * INTO cfg FROM insert_fault;
            IF n <= cfg.fail_first THEN
                IF cfg.code = '23505' THEN
                    RAISE unique_violation USING MESSAGE = 'duplicate key value violates unique constraint';
                END IF;
                RAISE EXCEPTION 'connection terminated' USING ERRCODE = cfg.code;
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER insert_fault BEFORE INSERT ON webpage_versions FOR EACH ROW EXECUTE FUNCTION insert_fault_fn();
    `);
});
test.after(close);

let seq = 0;
async function page() {
    seq += 1;
    const id = `wp${seq}`;
    await pg.query('INSERT INTO webpages (id, user_id) VALUES ($1, $2)', [id, 'alice']);
    return id;
}

/** Fail the next `n` version INSERTs with `code`, and count attempts from zero. */
async function failNext(n, code = '23505') {
    await pg.query('UPDATE insert_fault SET fail_first = $1, code = $2', [n, code]);
    await pg.query('ALTER SEQUENCE insert_attempts RESTART');
}
const attempts = async () => Number((await pg.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM insert_attempts')).rows[0].n);

async function rowOf(id) {
    return (await pg.query('SELECT seq, source, actor_user_id, line_delta FROM webpage_versions WHERE id = $1', [id])).rows[0];
}

// ── 1. The number ─────────────────────────────────────────────────────

test('the number counts up per page, and createVersion returns the one it got', async () => {
    const a = await page();
    const b = await page();
    assert.deepStrictEqual([(await versions.createVersion('alice', a, 'x')).seq, (await versions.createVersion('alice', a, 'x')).seq], [1, 2]);
    const firstOfB = await versions.createVersion('alice', b, 'x');
    assert.strictEqual(firstOfB.seq, 1, 'the maximum is per PAGE: a fresh page starts at v1');
    assert.strictEqual((await rowOf(firstOfB.id)).seq, 1);
});

test('two saves at once both get a number, and not the same one', async () => {
    const id = await page();
    const [x, y] = await Promise.all([versions.createVersion('alice', id, 'x'), versions.createVersion('alice', id, 'y')]);
    assert.deepStrictEqual([x.seq, y.seq].sort(), [1, 2]);
});

test('a collision on the number is TRIED AGAIN, not passed on', async () => {
    const id = await page();
    await versions.createVersion('alice', id, 'x');
    await failNext(1);
    const v = await versions.createVersion('alice', id, 'x');
    await failNext(0);
    assert.strictEqual(v.seq, 2);
    assert.strictEqual((await rowOf(v.id)).seq, 2);
});

test('a collision that keeps colliding fails LOUDLY after five attempts instead of writing a row without a number', async () => {
    const id = await page();
    await failNext(100);
    await assert.rejects(() => versions.createVersion('alice', id, 'x'), /duplicate key/);
    const n = await attempts();
    await failNext(0);
    assert.strictEqual(n, 5, 'five attempts, then stop');
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM webpage_versions WHERE webpage_id = $1', [id])).rows[0].n, 0);
});

test('ANOTHER database error is not treated as a collision', async () => {
    const id = await page();
    await failNext(100, '08006');
    await assert.rejects(() => versions.createVersion('alice', id, 'x'), /connection terminated/);
    const n = await attempts();
    await failNext(0);
    assert.strictEqual(n, 1, 'retrying on a dead connection is only waiting longer');
});

test('the unique index on (webpage_id, seq) exists and is partial, so rows without a number never collide', async () => {
    const { rows } = await pg.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_webpage_versions_seq'");
    assert.strictEqual(rows.length, 1, 'without it the second writer writes a duplicate and nothing ever collides');
    const id = await page();
    await pg.query("INSERT INTO webpage_versions (id, webpage_id, seq) VALUES ('legacy-1', $1, NULL), ('legacy-2', $1, NULL)", [id]);
    await pg.query("INSERT INTO webpage_versions (id, webpage_id, seq) VALUES ('n-1', $1, 1)", [id]);
    await assert.rejects(() => pg.query("INSERT INTO webpage_versions (id, webpage_id, seq) VALUES ('n-1b', $1, 1)", [id]), (/** @type {any} */ e) => e.code === '23505');
});

// ── 2. The maker ──────────────────────────────────────────────────────

test('the maker defaults to the writing user; an explicit null stays null; another maker is kept as given', async () => {
    const id = await page();
    const byDefault = await versions.createVersion('alice', id, 'x');
    // "Said nothing" is not "nobody": a caller that knows it does not know records that.
    const unknown = await versions.createVersion('alice', id, 'x', null, 'manual', { actorUserId: null });
    const other = await versions.createVersion('alice', id, 'x', null, 'ai', { actorUserId: 'bob' });
    assert.strictEqual((await rowOf(byDefault.id)).actor_user_id, 'alice');
    assert.strictEqual((await rowOf(unknown.id)).actor_user_id, null);
    assert.deepStrictEqual([(await rowOf(other.id)).actor_user_id, (await rowOf(other.id)).source], ['bob', 'ai']);
});

// ── 3. The line difference ────────────────────────────────────────────

test('the line difference is stored as given, negative included; none is NULL, never 0', async () => {
    const id = await page();
    const neg = await versions.createVersion('alice', id, 'x', null, 'manual', { lineDelta: -12 });
    const none = await versions.createVersion('alice', id, 'x');
    assert.strictEqual((await rowOf(neg.id)).line_delta, -12);
    assert.strictEqual((await rowOf(none.id)).line_delta, null, '0 would read as "nothing changed", which is a claim');
});

test('a line difference that is not a number counts as not measured', async () => {
    const id = await page();
    for (const bad of [NaN, Infinity, '12', null]) {
        const v = await versions.createVersion('alice', id, 'x', null, 'manual', { lineDelta: /** @type {any} */ (bad) });
        assert.strictEqual((await rowOf(v.id)).line_delta, null, `${String(bad)} is not a measurement`);
    }
});

// ── 4. The vocabulary ─────────────────────────────────────────────────

test("'restore' is the fourth value of the one vocabulary, and is stored as such", async () => {
    assert.deepStrictEqual(versions.VERSION_SOURCES, ['manual', 'ai', 'published', 'restore']);
    const id = await page();
    const v = await versions.createVersion('alice', id, 'x', null, 'restore');
    assert.strictEqual((await rowOf(v.id)).source, 'restore');
});

test('a restore snapshot is NOT safe from the prune: only a publication is', async () => {
    const id = await page();
    await pg.query(
        `INSERT INTO webpage_versions (id, webpage_id, source, seq, created_at) VALUES
            ('old-restore', $1, 'restore', 1, NOW() - INTERVAL '30 days'),
            ('old-published', $1, 'published', 2, NOW() - INTERVAL '30 days')`,
        [id],
    );
    await pg.query(
        `INSERT INTO webpage_versions (id, webpage_id, source, seq, created_at)
         SELECT 'r' || g, $1, 'manual', 10 + g, NOW() - INTERVAL '1 day' FROM generate_series(1, 199) AS g`,
        [id],
    );
    await versions.createVersion('alice', id, 'x', null, 'restore');
    const left = new Set((await pg.query('SELECT id FROM webpage_versions WHERE webpage_id = $1', [id])).rows.map((r) => r.id));
    assert.ok(!left.has('old-restore'), 'a restore point is an ordinary point in time');
    assert.ok(left.has('old-published'));
});

// ── 5. Reading back ───────────────────────────────────────────────────

test('getVersionMeta reads number, maker and line difference back; a row from before them comes back null, not 0', async () => {
    const id = await page();
    await pg.query(
        `INSERT INTO webpage_versions (id, webpage_id, summary, source, seq, actor_user_id, line_delta) VALUES
            ('v-old', $1, 'Edited in code', 'manual', 7, 'alice', -3),
            ('v-legacy', $1, 'Auto-save', 'manual', NULL, NULL, NULL)`,
        [id],
    );
    const meta = await versions.getVersionMeta('v-old');
    assert.deepStrictEqual([meta.seq, meta.actorUserId, meta.lineDelta], [7, 'alice', -3]);
    const legacy = await versions.getVersionMeta('v-legacy');
    assert.deepStrictEqual([legacy.seq, legacy.actorUserId, legacy.lineDelta], [null, null, null], 'v0 does not exist');
});

test('the list carries number, maker and line difference, and orders by number within the same time', async () => {
    // created_at is transaction time: rows written together tie, and without
    // seq as the second key v15 could land under v14.
    const id = await page();
    await pg.query(
        `INSERT INTO webpage_versions (id, webpage_id, summary, source, seq, actor_user_id, line_delta, created_at) VALUES
            ('a-v14', $1, 'Edited in code', 'manual', 14, 'alice', -7, '2026-09-01T10:00:00Z'),
            ('z-v15', $1, 'Edited again', 'ai', 15, 'bob', 3, '2026-09-01T10:00:00Z'),
            ('v-legacy-list', $1, 'Published', 'published', NULL, NULL, NULL, '2026-08-01T10:00:00Z')`,
        [id],
    );
    const out = await versions.getVersions(id);
    assert.deepStrictEqual(out.map((v) => v.id), ['z-v15', 'a-v14', 'v-legacy-list']);
    assert.deepStrictEqual(out.map((v) => v.seq), [15, 14, null]);
    assert.deepStrictEqual(out.map((v) => v.actorUserId), ['bob', 'alice', null]);
    assert.deepStrictEqual(out.map((v) => v.lineDelta), [3, -7, null]);
    assert.deepStrictEqual(out.map((v) => v.source), ['ai', 'manual', 'published']);
});

test('shouldAutoVersion clocks per SOURCE, so the AI arm does not stop the manual clock', async () => {
    const id = await page();
    assert.strictEqual(await versions.shouldAutoVersion(id, 'manual'), true, 'no snapshot yet');
    await versions.createVersion('alice', id, 'turn', null, 'ai');
    assert.strictEqual(await versions.shouldAutoVersion(id, 'manual'), true,
        'an AI turn must not suppress the restore point of a hand edit');
    assert.strictEqual(await versions.shouldAutoVersion(id, 'ai'), false);
    assert.strictEqual(await versions.shouldAutoVersion(id), false, 'without a source any recent snapshot counts');
});
