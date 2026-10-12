/**
 * The run history lists JOURNEYS, not run rows.
 *
 * An automation that pauses on a form is continued by a child run, so one visitor
 * answering three questions produced four rows — three of which said nothing
 * but "Resumed from the form — see child run …". `root_run_id` names the
 * journey they belong to; the list shows its head and reads the outcome off
 * whichever leg ran LAST.
 *
 * That overlay is the part with teeth: get it wrong and a half-answered form
 * reports "Finished", because the head row genuinely IS successful — it
 * succeeded at handing off.
 *
 * Pure — `../db` is mocked, so this pins the SQL the store emits and the shape
 * it maps rows into, without needing Postgres.
 */

const test = require('node:test');
const assert = require('node:assert');

let nextRows = [];
const queries = [];
function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
mock('../db', {
    run: async () => ({ rowCount: 0, rows: [] }),
    getOne: async () => null,
    getAll: async (sql, params) => { queries.push({ sql, params }); return nextRows; },
    exec: async () => {},
    getClient: async () => ({}),
    pool: { query: async () => ({ rows: [] }) },
});

const store = require('./automationStore');

// The head of a three-leg journey, as the query returns it: the head's own
// columns, plus the last leg's outcome from the lateral join.
function headRow(overrides = {}) {
    return {
        id: 'head', automation_id: 'a1', version: 1, user_id: 'u1',
        trigger_kind: 'form', mode: 'live',
        status: 'success',                                   // the HEAD's own status
        summary: 'Resumed from the form — see child run leg3', // the HEAD's own summary
        started_at: '2026-08-18T14:37:50.150Z',
        finished_at: '2026-08-18T14:38:31.987Z',
        duration_ms: 41,
        root_run_id: 'head',
        automation_title: 'SEO-blogschrijver',
        journey_run_id: 'leg3',
        journey_status: 'awaiting_form',
        journey_finished_at: null,
        journey_summary: null,
        journey_error: null,
        journey_error_class: null,
        journey_handled_error_count: 0,
        journey_duration_ms: null,
        ...overrides,
    };
}

test('the listed row reports the last leg, not the head that handed off', async () => {
    nextRows = [headRow()];
    const { runs } = await store.listRunsForUser('u1', { automationId: 'a1' });
    assert.strictEqual(runs.length, 1, 'one journey, one row');
    const row = runs[0];
    assert.strictEqual(row.id, 'head', 'the row IS the head — links and detail open the journey');
    assert.strictEqual(row.status, 'awaiting_form', 'still waiting on the visitor');
    assert.strictEqual(row.journeyRunId, 'leg3', 'and this is the leg an action must address');
    assert.strictEqual(row.summary, null, 'the handoff note is never what a person reads');
});

test('a journey still going reports no duration rather than the head leg\'s', async () => {
    nextRows = [headRow()];
    const { runs } = await store.listRunsForUser('u1', {});
    assert.strictEqual(runs[0].durationMs, null, 'the table shows "…", not 41ms for a 4-minute journey');
    assert.strictEqual(runs[0].finishedAt, null);
});

test('a finished journey spans the head\'s start to the last leg\'s finish', async () => {
    nextRows = [headRow({
        journey_status: 'success',
        journey_finished_at: '2026-08-18T14:41:16.960Z',
        journey_summary: '**Trigger:** On trigger (form).',
        journey_duration_ms: '206810',   // pg returns numerics as strings
    })];
    const { runs } = await store.listRunsForUser('u1', {});
    assert.strictEqual(runs[0].status, 'success');
    assert.strictEqual(runs[0].durationMs, 206810, 'a number, whatever the driver hands back');
    assert.match(runs[0].summary, /On trigger \(form\)/);
});

test('the query lists heads only and joins the journey', async () => {
    queries.length = 0;
    nextRows = [];
    await store.listRunsForUser('u1', {});
    const { sql } = queries[0];
    assert.match(sql, /LEFT JOIN LATERAL/, 'the outcome comes from the newest leg');
    assert.match(sql, /r\.root_run_id IS NULL OR r\.root_run_id = r\.id/, 'continuations are folded away');
    // The keyset still orders on the HEAD's start, so cursor pagination is
    // untouched by the collapse — a journey never moves in the list because a
    // later leg finished.
    assert.match(sql, /ORDER BY r\.started_at DESC NULLS LAST, r\.id DESC/);
});

test('a row written before the column existed is its own journey', async () => {
    // Legacy rows carry root_run_id NULL. They must keep listing exactly as
    // they did, which is what every COALESCE(root_run_id, id) is there for.
    nextRows = [headRow({ id: 'legacy', root_run_id: null, journey_run_id: 'legacy', journey_status: 'error', journey_summary: 'Failed: boom' })];
    const { runs } = await store.listRunsForUser('u1', {});
    assert.strictEqual(runs[0].rootRunId, 'legacy', 'it roots itself');
    assert.strictEqual(runs[0].status, 'error');
});

test('the facet counts are taken from the journey status too', async () => {
    queries.length = 0;
    nextRows = [{ status: 'awaiting_form', trigger_kind: 'form', automation_id: 'a1', error_class: null }];
    const facets = await store.getRunFacetsForUser('u1', {});
    assert.match(queries[0].sql, /COALESCE\(j\.status, r\.status\) AS status/,
        'chips that counted head statuses would disagree with the rows they filter');
    assert.strictEqual(facets.status.awaiting_form, 1);
});
