// @typecheck
/**
 * The run history lists JOURNEYS, not run rows, against a real Postgres (the
 * boot ladder's schema on PGlite, testUtils/pgliteTemplate.js ladderPglite,
 * behind db.js's pool).
 *
 * An automation that pauses on a form is continued by a child run, so one
 * visitor answering three questions produced four rows, three of which said
 * nothing but "Resumed from the form — see child run …". `root_run_id` names
 * the journey they belong to; the list shows its head and reads the outcome
 * off whichever leg ran LAST. Get that overlay wrong and a half-answered form
 * reports "Finished", because the head row genuinely IS successful: it
 * succeeded at handing off.
 *
 * Run: cd server && node --test stores/automationStore.journey.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./automationStore');

test.before(async () => {
    await pg.query(`INSERT INTO automations (id, user_id, title, definition_json) VALUES ('a1', 'u1', 'SEO-blogschrijver', '{}'), ('a2', 'u1', 'Legacy', '{}')`);
});
test.after(close);
test.beforeEach(() => pg.exec('DELETE FROM automation_runs'));

/** @param {Record<string, unknown>} row */
async function run(row) {
    const r = { automation_id: 'a1', version: 1, user_id: 'u1', trigger_kind: 'form', mode: 'live', ...row };
    const cols = Object.keys(r);
    await pg.query(`INSERT INTO automation_runs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
}

/** A three-leg form journey: the head handed off, the last leg waits on the visitor or is done. */
async function journey(lastLeg = {}) {
    await run({ id: 'head', root_run_id: 'head', status: 'success', summary: 'Resumed from the form — see child run leg2',
        started_at: '2026-08-18T14:37:50.150Z', finished_at: '2026-08-18T14:38:31.987Z', duration_ms: 41 });
    await run({ id: 'leg2', root_run_id: 'head', status: 'success', summary: 'Resumed from the form — see child run leg3',
        started_at: '2026-08-18T14:39:00Z', finished_at: '2026-08-18T14:39:01Z', duration_ms: 30 });
    await run({ id: 'leg3', root_run_id: 'head', status: 'awaiting_form', summary: null, started_at: '2026-08-18T14:40:00Z', ...lastLeg });
}

test('one journey lists as one row: the head, reporting the last leg', async () => {
    await journey();
    const { runs } = await store.listRunsForUser('u1', { automationId: 'a1' });
    assert.strictEqual(runs.length, 1, 'continuations are folded away');
    const [row] = runs;
    assert.strictEqual(row.id, 'head', 'the row IS the head: links and detail open the journey');
    assert.strictEqual(row.status, 'awaiting_form', 'still waiting on the visitor');
    assert.strictEqual(row.journeyRunId, 'leg3', 'and this is the leg an action must address');
    assert.strictEqual(row.summary, null, 'the handoff note is never what a person reads');
});

test("a journey still going reports no duration rather than the head leg's", async () => {
    await journey();
    const { runs } = await store.listRunsForUser('u1', {});
    assert.strictEqual(runs[0].durationMs, null, 'the table shows "…", not 41ms for a 4-minute journey');
    assert.strictEqual(runs[0].finishedAt, null);
});

test("a finished journey reports the last leg's outcome and duration as a number", async () => {
    await journey({ status: 'success', finished_at: '2026-08-18T14:41:16.960Z', summary: '**Trigger:** On trigger (form).', duration_ms: 206810 });
    const { runs } = await store.listRunsForUser('u1', {});
    assert.strictEqual(runs[0].status, 'success');
    assert.strictEqual(runs[0].durationMs, 206810);
    assert.match(runs[0].summary, /On trigger \(form\)/);
});

test("the list orders journeys by the head's start, newest first, whatever a later leg did", async () => {
    await journey({ started_at: '2026-08-20T00:00:00Z' });
    await run({ id: 'other', root_run_id: 'other', status: 'success', started_at: '2026-08-19T00:00:00Z', finished_at: '2026-08-19T00:00:01Z' });
    const { runs } = await store.listRunsForUser('u1', {});
    assert.deepStrictEqual(runs.map((r) => r.id), ['other', 'head'], 'a journey never moves in the list because a later leg ran');
});

test('a row written before the column existed is its own journey', async () => {
    // Legacy rows carry root_run_id NULL and must keep listing exactly as they did.
    await run({ id: 'legacy', automation_id: 'a2', root_run_id: null, status: 'error', summary: 'Failed: boom', started_at: '2026-08-01T00:00:00Z' });
    const { runs } = await store.listRunsForUser('u1', {});
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].rootRunId, 'legacy', 'it roots itself');
    assert.strictEqual(runs[0].status, 'error');
});

test('the facet counts are taken from the journey status too', async () => {
    await journey();
    const facets = await store.getRunFacetsForUser('u1', {});
    assert.strictEqual(facets.status.awaiting_form, 1, 'chips that counted head statuses would disagree with the rows they filter');
    assert.ok(!facets.status.success, 'neither the head nor the middle leg counts as a finished run');
});
