/**
 * The cowork payload: the fields that the Cowork screen newly reads, against a
 * stubbed db. This file pins the SQL and value contract; the real
 * Postgres round trip is in coworkStore.test.js and skips without a database,
 * so what is here runs everywhere.
 *
 * Three properties, each with its own wound:
 *
 *   - CW-13 `produced_output`. A run that had nothing to report is SUCCESSFUL, and
 *     that judgement should be made once (at closing) and stored — not
 *     guessed again each time from the result text.
 *     NULL is a third value: rows from before the column do not know, and reading
 *     them as "nothing produced" invents a statement about the past.
 *
 *   - CW-06 `currentRunStartedAt`. The source is the row that is open
 *     (`finished_at IS NULL`), not `last_status = 'running'`: those two drift apart
 *     as soon as reapStaleRuns cleans up a stuck attempt.
 *
 *   - CW-11 the aggregate. `failed` is "closed and not successful", so that a
 *     status name added later does not silently fall through the gap, and a running run
 *     counts in neither outcome.
 *
 * Run: cd server && node --test --test-reporter=tap stores/coworkStore.payload.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const runCalls = [];
const execCalls = [];
let getOneHandler = () => null;
let getAllHandler = () => [];

const restore = installResolveStub({
    '../db': {
        run: async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1, rows: [] }; },
        getOne: async (sql, params) => getOneHandler(sql, params),
        getAll: async (sql, params) => getAllHandler(sql, params),
        exec: async (sql) => { execCalls.push(sql); },
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    },
});

const coworkStore = require('./coworkStore');
const { deriveProducedOutput } = coworkStore;

function reset() {
    runCalls.length = 0;
    getOneHandler = () => null;
    getAllHandler = () => [];
}

/** De UPDATE waarmee _closeOpenRun een open run afsluit. */
function closingUpdate() {
    return runCalls.find(c => /UPDATE cowork_runs/.test(c.sql) && /finished_at = NOW\(\)/.test(c.sql));
}

/** Doe alsof er precies één open run klaarstaat om afgesloten te worden. */
function withOpenRun() {
    getOneHandler = (sql) => (/SELECT id, started_at FROM cowork_runs/.test(sql)
        ? { id: 'run-open', started_at: '2026-09-10T08:00:04.000Z' }
        : null);
}

// ── CW-13: het oordeel "was er iets te melden" ──────────────────────

test('leeg en de "geen tekstresultaat"-markering tellen als niets geproduceerd', () => {
    assert.strictEqual(deriveProducedOutput(null), false);
    assert.strictEqual(deriveProducedOutput(undefined), false);
    assert.strictEqual(deriveProducedOutput(''), false);
    assert.strictEqual(deriveProducedOutput('   \n  '), false);
    // De letterlijke vorm die aiTaskRunner neerzet als het model niets schreef.
    assert.strictEqual(
        deriveProducedOutput('_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_'),
        false);
    // Dezelfde vorm, andere taal/copy: de afleiding hangt aan de VORM, niet aan
    // de Nederlandse zin — anders breekt hij zodra iemand de tekst vertaalt.
    assert.strictEqual(deriveProducedOutput('_(Nothing to report.)_'), false);
});

test('een echt resultaat telt mee, ook als het cursief begint', () => {
    assert.strictEqual(deriveProducedOutput('3 offertes klaargezet'), true);
    assert.strictEqual(deriveProducedOutput('_(let op)_ en dan 3 offertes'), true,
        'een markering met tekst eromheen is gewoon een antwoord');
    assert.strictEqual(deriveProducedOutput('0'), true,
        'het cijfer nul is een uitkomst, geen leegte');
});

test('markCompleted schrijft het oordeel mee in dezelfde UPDATE die de run sluit', async () => {
    reset();
    withOpenRun();
    await coworkStore.markCompleted('cw-1', '3 offertes klaargezet');
    const upd = closingUpdate();
    assert.ok(upd, 'de sluitende UPDATE hoort te lopen');
    assert.match(upd.sql, /produced_output = \$4/);
    assert.strictEqual(upd.params[3], true);
});

test('"niets te melden" wordt een GESLAAGDE run met produced_output false', async () => {
    reset();
    withOpenRun();
    await coworkStore.markCompleted('cw-1', '_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_');
    const upd = closingUpdate();
    assert.strictEqual(upd.params[0], 'success', 'de status blijft geslaagd — dat is de hele bevinding');
    assert.strictEqual(upd.params[3], false);
});

test('een aanroeper die het zeker weet overstemt de afleiding', async () => {
    reset();
    withOpenRun();
    // The runner knows whether there was tool output; that knowledge may not be lost
    // to a text inference.
    await coworkStore.markCompleted('cw-1', 'ziet er leeg uit', { producedOutput: false });
    assert.strictEqual(closingUpdate().params[3], false);

    reset();
    withOpenRun();
    await coworkStore.markCompleted('cw-1', '', { producedOutput: true });
    assert.strictEqual(closingUpdate().params[3], true);
});

// HONESTLY: this test cannot fail on the contract it names. markError
// passes no `result`, so deriveProducedOutput(undefined) is already false —
// removing the explicit `producedOutput: false` in markError is an
// EQUIVALENT mutation and stays green. The test is worth the value assertion
// (produced_output = false on a failed row) but does not prove that the
// caller says so itself. Whoever wants to prove that needs a markError
// that carries a result, and that does not exist today.
test('een mislukte run heeft per definitie niets opgeleverd', async () => {
    reset();
    withOpenRun();
    await coworkStore.markError('cw-1', new Error('provider exploded'));
    const upd = closingUpdate();
    assert.strictEqual(upd.params[0], 'error');
    assert.strictEqual(upd.params[3], false);
});

test('een opgeruimde vastgelopen run wordt ook op false gezet', async () => {
    reset();
    await coworkStore.reapStaleRuns();
    const reap = runCalls.find(c => /UPDATE cowork_runs/.test(c.sql) && /finished_at IS NULL/.test(c.sql));
    assert.ok(reap);
    assert.match(reap.sql, /produced_output = FALSE/);
});

test('de kolom komt uit de runDdl-ladder van deze store, niet uit een stille catch', async () => {
    // A new column belongs in the idempotent boot DDL of its own store
    // (boot/bootMigrations.test.js explains that rule). IF NOT EXISTS carries the
    // idempotency, so every boot of every replica may run it again.
    const alter = execCalls.find(sql => /ADD COLUMN IF NOT EXISTS produced_output BOOLEAN/.test(sql));
    assert.ok(alter, `geen ALTER voor produced_output gezien; wel: ${execCalls.join(' | ')}`);
    assert.match(alter, /ALTER TABLE cowork_runs/);
});

test('listRuns geeft true, false en null door — null blijft null', async () => {
    reset();
    getAllHandler = () => [
        { id: 'r1', schedule_id: 'cw-1', status: 'success', produced_output: true },
        { id: 'r2', schedule_id: 'cw-1', status: 'success', produced_output: false },
        { id: 'r3', schedule_id: 'cw-1', status: 'success', produced_output: null },
    ];
    const runs = await coworkStore.listRuns('cw-1');
    assert.deepStrictEqual(runs.map(r => r.producedOutput), [true, false, null],
        'een rij van vóór de kolom weet het niet, en dat is geen "nee"');
});

// ── CW-06: de starttijd van de lopende run ──────────────────────────

test('de open run wordt gezocht op finished_at IS NULL, niet op een status', async () => {
    reset();
    let seen;
    getOneHandler = (sql, params) => { seen = { sql, params }; return { started_at: '2026-09-10T08:00:04.000Z' }; };
    const at = await coworkStore.getOpenRunStart('cw-1');
    assert.strictEqual(at, '2026-09-10T08:00:04.000Z');
    assert.match(seen.sql, /finished_at IS NULL/);
    // NO status column, in whatever spelling. The previous version of this
    // rule forbade only `last_status`, so `AND status = 'running'` —
    // precisely the error that the doc comment describes — slipped through unseen:
    // after a reap the row is open and the status is no longer 'running'.
    assert.ok(!/\bstatus\b/.test(seen.sql), 'een status in de WHERE loopt uiteen met de open rij');
    assert.deepStrictEqual(seen.params, ['cw-1']);
});

test('niets open → null, geen verzonnen tijd', async () => {
    reset();
    getOneHandler = () => null;
    assert.strictEqual(await coworkStore.getOpenRunStart('cw-1'), null);
});

test('de lijstvariant vraagt het in ÉÉN query voor de hele gebruiker', async () => {
    reset();
    let seen;
    getAllHandler = (sql, params) => {
        seen = { sql, params };
        return [{ schedule_id: 'cw-a', started_at: '2026-09-10T08:00:04.000Z' }];
    };
    const map = await coworkStore.getOpenRunStarts('u1');
    assert.deepStrictEqual(map, { 'cw-a': '2026-09-10T08:00:04.000Z' });
    assert.deepStrictEqual(seen.params, ['u1'], 'op user_id — de bestaande index');
    assert.match(seen.sql, /finished_at IS NULL/);
    assert.ok(!/\bstatus\b/.test(seen.sql), 'dezelfde bron als de losse variant: de open rij, geen status');
    assert.match(seen.sql, /GROUP BY schedule_id/);
});

// ── CW-11: het aggregaat ────────────────────────────────────────────

test('het aggregaat telt geslaagd apart en rekent "mislukt" als gesloten-en-niet-geslaagd', async () => {
    reset();
    let seen;
    getOneHandler = (sql, params) => {
        seen = { sql, params };
        return { total: 12, success: 10, failed: 2, avg_duration_ms: '71999.6' };
    };
    const stats = await coworkStore.getRunStats('cw-1');
    assert.deepStrictEqual(stats, { total: 12, success: 10, failed: 2, avgDurationMs: 72000 });
    assert.deepStrictEqual(seen.params, ['cw-1']);
    // Without a database, SQL text is the only thing that can be measured here, so these
    // three lines check the CONDITIONS and not the way of writing them: a
    // semantically identical SUM(CASE WHEN …) should not turn red, a
    // changed condition should. The real round trip belongs in
    // coworkStore.test.js and skips here without Postgres.
    assert.match(seen.sql, /success[\s\S]{0,80}status = 'success'|status = 'success'[\s\S]{0,80}success/);
    // Not a list of error statuses: 'needs_reauth' already exists and one more
    // will come someday. "Closed and not successful" covers all of them.
    assert.match(seen.sql, /finished_at IS NOT NULL AND status <> 'success'/);
    assert.ok(!/status = 'error'/.test(seen.sql), 'een lijst foutstatussen laat een nieuwe status wegvallen');
    // A running run has no duration yet; it should not dilute the average.
    assert.match(seen.sql, /AVG\(duration_ms\)[\s\S]{0,60}finished_at IS NOT NULL/);
});

test('nog nooit een poging afgerond geeft null, niet 0 ms', async () => {
    reset();
    getOneHandler = () => ({ total: 1, success: 0, failed: 0, avg_duration_ms: null });
    const stats = await coworkStore.getRunStats('cw-1');
    assert.strictEqual(stats.avgDurationMs, null, '"nog niets gemeten" is geen "gemiddeld 0 ms"');
    assert.strictEqual(stats.total, 1);
});

test('een GEMETEN 0 blijft 0 — de andere helft van dezelfde regel', async () => {
    // The distinction stood in three comment blocks and in zero fixtures: not a
    // single test ever passed 0, so `avg ? … : null` instead of a
    // null check stayed green everywhere. A run that rounds below a millisecond
    // IS finished, and 0 is then a measurement.
    reset();
    getOneHandler = () => ({ total: 3, success: 3, failed: 0, avg_duration_ms: '0' });
    const stats = await coworkStore.getRunStats('cw-1');
    assert.strictEqual(stats.avgDurationMs, 0);
    assert.notStrictEqual(stats.avgDurationMs, null);
});

test('een schema zonder historie geeft nullen terug in plaats van te vallen', async () => {
    reset();
    getOneHandler = () => null;
    assert.deepStrictEqual(await coworkStore.getRunStats('cw-1'),
        { total: 0, success: 0, failed: 0, avgDurationMs: null });
});

test.after(() => restore());
