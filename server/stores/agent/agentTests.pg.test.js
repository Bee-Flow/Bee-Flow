'use strict';

/**
 * The test-set store against a REAL Postgres (@electric-sql/pglite, in-process).
 *
 * ── WHY THIS SUITE AND NOT A FAKE `query()` ─────────────────────────
 * Every statement in agentTests.js names columns. A fake client that never
 * parses SQL passes a store that asks for a column the table has not got, and
 * the symptom in production is an empty Testen tab — the same wound the
 * knowledge-base scans took. So this runs the DDL THE APP ACTUALLY SHIPS,
 * lifted verbatim out of stores/agent/initSchema.js rather than retyped here:
 * a column renamed there without touching the store fails this file loudly.
 *
 * What it pins beyond "the SQL parses":
 *   • a test id from ANOTHER agent is unreachable through every accessor —
 *     the route's gate is on the agent, so the store must not be a way around
 *     it;
 *   • `passed` can never exceed `total`, on the way in or on the way out;
 *   • the prune keeps the newest runs and no more;
 *   • deleting the agent takes its tests and runs with it (the CASCADE that
 *     lets agentUsage leave both tables out of the delete guard).
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentTests.pg.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adapt(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command: String(sql).trim().split(/\s+/)[0].toUpperCase() };
}

async function q(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adapt(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adapt(await pg.exec(sql), sql);
    return adapt(await pg.query(sql), sql);
}
const db = { query: q };
const opts = { db };

const store = require('./agentTests');

const AGENT = 'agent-under-test';
const OTHER = 'some-other-agent';

/**
 * The shipped DDL for these two tables, read out of initSchema.js.
 *
 * Extracted rather than copied so this suite cannot drift away from the
 * schema the app boots with — which is the entire reason it exists. The
 * statements are plain template literals with no interpolation; anything with
 * a `${` in it would be a signal to stop doing this, so it is asserted.
 */
function shippedDdl() {
    const src = fs.readFileSync(path.join(__dirname, 'initSchema.js'), 'utf8');
    // De ALTERs horen erbij: `written_by` / `suggested_by` zijn kolommen die
    // `createTest` bij naam noemt, en `seq` op `agent_test_runs` is de
    // tiebreaker die `listTestRuns`/`getLastTestRun`/de prune gebruiken — een
    // suite die ze niet aanmaakt bewijst precies het tegenovergestelde van
    // waar hij voor bestaat.
    const found = [...src.matchAll(/`((?:CREATE TABLE IF NOT EXISTS agent_test|CREATE INDEX IF NOT EXISTS idx_agent_test|ALTER TABLE agent_test(?:s|_runs) )[\s\S]*?)`/g)]
        .map(m => m[1]);
    assert.ok(found.length >= 6, `expected the two tables, their indexes and the column ladder in initSchema.js, found ${found.length}`);
    for (const s of found) assert.ok(!s.includes('${'), 'the test-set DDL must stay literal');
    return found;
}

before(async () => {
    // Enough of `agents` for the foreign key; the rest of that table is not
    // this store's business.
    await q(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT)`);
    await q(`INSERT INTO agents (id, name) VALUES ($1,'A'), ($2,'B')`, [AGENT, OTHER]);
    for (const stmt of shippedDdl()) await q(stmt);
});

test('a test round-trips through the shipped schema', async () => {
    const created = await store.createTest(AGENT, {
        name: 'Opening hours',
        question: 'When are you open?',
        expect: { mustMention: ['nine'], mustNotMention: [], toolsExpected: [], rulesExpected: [], notes: '' },
        fromConversationId: 'conv-1',
    }, opts);

    assert.ok(created.id);
    assert.strictEqual(created.agentId, AGENT);
    assert.strictEqual(created.name, 'Opening hours');
    assert.deepStrictEqual(created.expect.mustMention, ['nine']);
    assert.strictEqual(created.fromConversationId, 'conv-1');
    assert.ok(created.createdAt, 'created_at comes back as an ISO string');

    const listed = await store.listTests(AGENT, opts);
    assert.deepStrictEqual(listed.map(t => t.id), [created.id]);
    assert.strictEqual(await store.countTests(AGENT, opts), 1);
    assert.strictEqual(await store.countTests(OTHER, opts), 0);
});

test('a test id from another agent is unreachable — read, write and delete', async () => {
    const mine = await store.createTest(AGENT, { name: 'Mine', question: 'q1' }, opts);

    assert.strictEqual(await store.getTest(OTHER, mine.id, opts), null);
    assert.strictEqual(await store.updateTest(OTHER, mine.id, { name: 'hijacked' }, opts), null);
    assert.strictEqual(await store.deleteTest(OTHER, mine.id, opts), false);

    // And nothing changed on the real one.
    const still = await store.getTest(AGENT, mine.id, opts);
    assert.strictEqual(still.name, 'Mine');
    assert.ok(await store.deleteTest(AGENT, mine.id, opts));
    assert.strictEqual(await store.getTest(AGENT, mine.id, opts), null);
});

test('a patch writes only the keys it carries', async () => {
    const t = await store.createTest(AGENT, {
        name: 'Before', question: 'q', expect: { mustMention: ['a'] },
    }, opts);

    const renamed = await store.updateTest(AGENT, t.id, { name: 'After' }, opts);
    assert.strictEqual(renamed.name, 'After');
    assert.strictEqual(renamed.question, 'q');
    assert.deepStrictEqual(renamed.expect.mustMention, ['a'], 'an absent expect must not be wiped');

    const rescoped = await store.updateTest(AGENT, t.id, { expect: { mustNotMention: ['x'] } }, opts);
    assert.deepStrictEqual(rescoped.expect, { mustNotMention: ['x'] });
    assert.strictEqual(rescoped.name, 'After');

    // An empty patch is a read, not a wipe.
    const untouched = await store.updateTest(AGENT, t.id, {}, opts);
    assert.strictEqual(untouched.name, 'After');
    await store.deleteTest(AGENT, t.id, opts);
});

test('an empty question is refused rather than stored', async () => {
    await assert.rejects(() => store.createTest(AGENT, { question: '  ' }, opts), /question is required/);
    await assert.rejects(() => store.createTest(null, { question: 'q' }, opts), /agentId is required/);
    // …and a patch that would blank it is ignored, not applied.
    const t = await store.createTest(AGENT, { question: 'keep me' }, opts);
    const after = await store.updateTest(AGENT, t.id, { question: '   ' }, opts);
    assert.strictEqual(after.question, 'keep me');
    await store.deleteTest(AGENT, t.id, opts);
});

test('passed is clamped into [0, total] on the way in and on the way out', async () => {
    const run = await store.recordTestRun({
        agentId: AGENT, version: 3, results: { items: [] }, passed: 99, total: 4,
    }, opts);
    assert.strictEqual(run.total, 4);
    assert.strictEqual(run.passed, 4);
    // The COLUMN, not just what mapRun hands back: a report, a dashboard or a
    // raw query does not go through the reader, so an impossible pair must
    // never reach the row in the first place.
    const stored = await q(`SELECT passed, total FROM agent_test_runs WHERE id = $1`, [run.id]);
    assert.strictEqual(Number(stored.rows[0].passed), 4, 'the stored column is clamped, not only the read');
    assert.strictEqual(Number(stored.rows[0].total), 4);

    const negative = await store.recordTestRun({
        agentId: AGENT, version: 0, results: {}, passed: -5, total: -2,
    }, opts);
    assert.strictEqual(negative.total, 0);
    assert.strictEqual(negative.passed, 0);
    const storedNeg = await q(`SELECT passed, total FROM agent_test_runs WHERE id = $1`, [negative.id]);
    assert.strictEqual(Number(storedNeg.rows[0].passed), 0);
    assert.strictEqual(Number(storedNeg.rows[0].total), 0);

    // A row written by hand is clamped by the reader too.
    await q(`UPDATE agent_test_runs SET passed = 50, total = 2 WHERE id = $1`, [run.id]);
    const reread = await q(`SELECT * FROM agent_test_runs WHERE id = $1`, [run.id]);
    assert.strictEqual(store.mapRun(reread.rows[0]).passed, 2);
});

test('the last run is the newest one, with its results intact', async () => {
    const last = await store.recordTestRun({
        agentId: AGENT, version: 7,
        results: { items: [{ testId: 't1', status: 'pass' }], source: 'published', agentRev: 12 },
        passed: 1, total: 1,
    }, opts);
    const read = await store.getLastTestRun(AGENT, opts);
    assert.strictEqual(read.id, last.id);
    assert.strictEqual(read.version, 7);
    assert.strictEqual(read.results.source, 'published');
    assert.deepStrictEqual(read.results.items, [{ testId: 't1', status: 'pass' }]);
    assert.strictEqual(await store.getLastTestRun(OTHER, opts), null);
});

test('the prune keeps the newest runs and only touches this agent', async () => {
    await q(`DELETE FROM agent_test_runs`);
    await store.recordTestRun({ agentId: OTHER, version: 1, results: {}, passed: 0, total: 1 }, opts);
    for (let i = 0; i < store.TEST_RUNS_KEEP + 5; i++) {
        await store.recordTestRun({ agentId: AGENT, version: i, results: { i }, passed: 0, total: 1 }, opts);
    }
    const mine = await q(`SELECT version FROM agent_test_runs WHERE agent_id = $1 ORDER BY version DESC`, [AGENT]);
    assert.strictEqual(mine.rows.length, store.TEST_RUNS_KEEP);
    assert.strictEqual(Number(mine.rows[0].version), store.TEST_RUNS_KEEP + 4, 'the newest run survives');
    const theirs = await q(`SELECT COUNT(*)::int AS n FROM agent_test_runs WHERE agent_id = $1`, [OTHER]);
    assert.strictEqual(theirs.rows[0].n, 1, 'another agent\'s runs are not pruned');
});

test('the run history is newest first, never longer than what is kept', async () => {
    await q(`DELETE FROM agent_test_runs`);
    await store.recordTestRun({ agentId: OTHER, version: 99, results: {}, passed: 0, total: 1 }, opts);
    for (let i = 0; i < 4; i++) {
        await store.recordTestRun({ agentId: AGENT, version: i, results: { i }, passed: i, total: 4 }, opts);
    }
    const all = await store.listTestRuns(AGENT, opts);
    assert.deepStrictEqual(all.map(r => r.version), [3, 2, 1, 0], 'newest first');
    assert.ok(all.every(r => r.agentId === AGENT), "another agent's runs stay out");

    assert.strictEqual((await store.listTestRuns(AGENT, { ...opts, limit: 2 })).length, 2);
    // Meer dan er bewaard wordt kan niet gevraagd worden: de prune gooit de
    // rest weg, dus een grotere limit zou een lijst beloven die per definitie
    // korter uitvalt.
    for (const silly of [0, -1, 'veel', null, 9999]) {
        const rows = await store.listTestRuns(AGENT, { ...opts, limit: silly });
        assert.strictEqual(rows.length, 4, String(silly));
    }
    assert.deepStrictEqual(await store.listTestRuns(null, opts), []);
});

test('BIJT — gelijke ran_at volgt de invoegvolgorde, niet de willekeurige id', async () => {
    // `id` is een uuidv4 — willekeurig, dus geen geldige tiebreaker. Deze ids
    // zijn met opzet zo gekozen dat ORDER BY id DESC precies de OMGEKEERDE
    // volgorde geeft van de invoegvolgorde: de rij die als eerste binnenkwam
    // krijgt de hoogste id, de laatst ingevoegde de laagste.
    await q(`DELETE FROM agent_test_runs`);
    const sameRanAt = new Date().toISOString();
    const n = 3;
    for (let i = 0; i < n; i++) {
        const id = `run-${String(n - 1 - i).padStart(3, '0')}`;
        await q(
            `INSERT INTO agent_test_runs (id, agent_id, version, results, passed, total, ran_at)
             VALUES ($1, $2, $3, '{}'::jsonb, 0, 1, $4)`,
            [id, AGENT, i, sameRanAt],
        );
    }
    const rows = await store.listTestRuns(AGENT, opts);
    assert.deepStrictEqual(rows.map(r => r.version), [2, 1, 0],
        'de laatst ingevoegde run eerst, ook al sorteren de ids precies andersom');

    const last = await store.getLastTestRun(AGENT, opts);
    assert.strictEqual(last.version, 2, 'getLastTestRun stemt overeen met de kop van listTestRuns');
    await q(`DELETE FROM agent_test_runs`);
});

test('BIJT — de prune bewaart de laatst ingevoegde rijen, niet de rijen met de hoogste id', async () => {
    await q(`DELETE FROM agent_test_runs`);
    const tieRanAt = new Date().toISOString();
    const n = store.TEST_RUNS_KEEP + 1; // 21 rijen, allemaal met dezelfde ran_at.
    for (let i = 0; i < n; i++) {
        // Zelfde omkering als hierboven: eerst ingevoegd = hoogste id.
        const id = `run-${String(n - 1 - i).padStart(3, '0')}`;
        await q(
            `INSERT INTO agent_test_runs (id, agent_id, version, results, passed, total, ran_at)
             VALUES ($1, $2, $3, '{}'::jsonb, 0, 1, $4)`,
            [id, AGENT, i, tieRanAt],
        );
    }
    // Eén run erna, met een echt latere ran_at, om de prune in recordTestRun
    // via de echte API te laten lopen.
    await store.recordTestRun({ agentId: AGENT, version: 999, results: {}, passed: 0, total: 1 }, opts);

    const kept = await q(`SELECT version FROM agent_test_runs WHERE agent_id = $1`, [AGENT]);
    const keptVersions = kept.rows.map(r => Number(r.version)).sort((a, b) => a - b);
    assert.strictEqual(keptVersions.length, store.TEST_RUNS_KEEP);
    assert.ok(!keptVersions.includes(0), 'de oudst ingevoegde run van de gelijktijdige groep overleeft de prune niet');
    assert.ok(!keptVersions.includes(1), 'de op-één-na-oudste run overleeft de prune niet');
    assert.ok(keptVersions.includes(n - 1), 'de laatst ingevoegde run van de gelijktijdige groep overleeft');
    assert.ok(keptVersions.includes(999), 'de nieuwe run overleeft');
    await q(`DELETE FROM agent_test_runs`);
});

test('BIJT — de limit wordt geklemd, ook als er méér rijen staan dan er bewaard worden', async () => {
    // De assertie hierboven kan de klem per constructie niet zien: met vier
    // rijen geeft een ONgeklemde `LIMIT 9999` net zo goed vier rijen. En de
    // klem is geen dode code — `recordTestRun` slikt zijn eigen prune-fout, en
    // de route geeft de `?limit=` van de client rechtstreeks door. Dus zetten
    // we hier meer rijen neer dan er bewaard worden, buiten `recordTestRun` om
    // (die zou meteen prunen), en vragen we er te veel op.
    await q(`DELETE FROM agent_test_runs`);
    const extra = store.TEST_RUNS_KEEP + 7;
    for (let i = 0; i < extra; i++) {
        await q(
            `INSERT INTO agent_test_runs (id, agent_id, version, results, passed, total, ran_at)
             VALUES ($1, $2, $3, '{}'::jsonb, 0, 1, NOW() - ($4 || ' seconds')::interval)`,
            [`run-${i}`, AGENT, i, String(extra - i)],
        );
    }
    assert.strictEqual(
        (await q(`SELECT COUNT(*)::int AS n FROM agent_test_runs WHERE agent_id = $1`, [AGENT])).rows[0].n,
        extra, 'aanname van deze test: er staan meer rijen dan er bewaard worden',
    );

    const rows = await store.listTestRuns(AGENT, { ...opts, limit: 9999 });
    assert.strictEqual(rows.length, store.TEST_RUNS_KEEP,
        'zonder klem zou de kaart honderden rijen tonen onder "Only the last 20 runs are kept."');
    assert.strictEqual((await store.listTestRuns(AGENT, opts)).length, store.TEST_RUNS_KEEP,
        'en zonder limit geldt dezelfde bovengrens');
    await q(`DELETE FROM agent_test_runs`);
});

test('de herkomst van een voorgestelde verwachting overleeft het opslaan', async () => {
    // Zonder deze twee kolommen is een regel die een model schreef na het
    // opslaan niet te onderscheiden van een die iemand zelf tikte — terwijl
    // elke run-uitslag die eruit volgt erop leunt.
    const proposed = await store.createTest(AGENT, {
        name: 'Voorgesteld', question: 'Wanneer zijn jullie open?',
        expect: { mustMention: ['negen uur'] },
        writtenBy: { mustMention: 'ai', toolsExpected: 'observed', notes: 'human' },
        suggestedBy: 'fast-model-1',
    }, opts);
    assert.deepStrictEqual(proposed.writtenBy, { mustMention: 'ai', toolsExpected: 'observed', notes: 'human' });
    assert.strictEqual(proposed.suggestedBy, 'fast-model-1');
    assert.deepStrictEqual((await store.getTest(AGENT, proposed.id, opts)).writtenBy, proposed.writtenBy);

    // En een test die een mens zelf tikte draagt GEEN herkomst. Null is hier
    // het eerlijke antwoord: geen etiket is beter dan een verkeerd etiket.
    const typed = await store.createTest(AGENT, { name: 'Zelf', question: 'q' }, opts);
    assert.strictEqual(typed.writtenBy, null);
    assert.strictEqual(typed.suggestedBy, null);

    await store.deleteTest(AGENT, proposed.id, opts);
    await store.deleteTest(AGENT, typed.id, opts);
});

test('deleting the agent takes its tests and runs with it', async () => {
    const doomed = 'agent-to-delete';
    await q(`INSERT INTO agents (id, name) VALUES ($1,'C')`, [doomed]);
    await store.createTest(doomed, { question: 'q' }, opts);
    await store.recordTestRun({ agentId: doomed, version: 1, results: {}, passed: 0, total: 1 }, opts);

    await q(`DELETE FROM agents WHERE id = $1`, [doomed]);
    assert.deepStrictEqual(await store.listTests(doomed, opts), []);
    assert.strictEqual(await store.getLastTestRun(doomed, opts), null);
});

test('an unreadable expect reads back as the empty document, never as junk', () => {
    assert.deepStrictEqual(store.mapTest({ id: 'x', agent_id: 'a', expect: 'not json' }).expect, {});
    assert.deepStrictEqual(store.mapTest({ id: 'x', agent_id: 'a', expect: '["a"]' }).expect, ['a']);
    assert.deepStrictEqual(store.mapTest({ id: 'x', agent_id: 'a', expect: null }).expect, {});
    assert.strictEqual(store.mapTest(null), null);
});

test('a missing id answers instead of querying', async () => {
    assert.deepStrictEqual(await store.listTests(null, opts), []);
    assert.strictEqual(await store.getTest(AGENT, null, opts), null);
    assert.strictEqual(await store.deleteTest(null, 'x', opts), false);
    assert.strictEqual(await store.updateTest(AGENT, null, {}, opts), null);
    assert.strictEqual(await store.countTests(null, opts), 0);
    assert.deepStrictEqual(await store.listTestRuns(null, opts), []);
    assert.strictEqual(await store.getLastTestRun(null, opts), null);
});
