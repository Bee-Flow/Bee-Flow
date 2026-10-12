'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startFillPhase, refreshFillPhase } = require('./fillPhase');

const PB = { userId: 'u1' };
const TABLE = { datatableId: 'tbl_1', datatableScope: { kind: 'org', id: 'org1' } };

function deps({ automation, runs = {}, rowCount = 3, execute } = {}) {
    return {
        automationStore: { getAutomation: async (id) => (automation && automation.id === id ? automation : null), getRun: async (id) => runs[id] || null },
        datatableStore: { getDatatable: async () => ({ rowCount }) },
        runner: { executeAutomation: execute || (async (a, opts) => { opts.onRunCreated({ id: 'run_1', status: 'running' }); return { id: 'run_1', status: 'success' }; }) },
        timeoutMs: 50,
    };
}
const manual = { id: 'a1', userId: 'u1', isDraft: false, definition: { trigger: { kind: 'manual' } } };

test('runs the automation once: the run id arrives through onRunCreated, rowsBefore is read first, the run resolves in time', async () => {
    const seen = [];
    const r = await startFillPhase({ playbook: PB, automationId: 'a1', tableArtifacts: TABLE, onRunCreated: (run) => seen.push(run.id) }, deps({ automation: manual }));
    assert.equal(r.ok, true);
    assert.equal(r.runId, 'run_1');
    assert.equal(r.timedOut, false);
    assert.equal(r.rowsBefore, 3);
    assert.equal(r.run.status, 'success');
    assert.deepEqual(seen, ['run_1']);
});

test('refuses: no automation, another owner, an automation that does not start by hand', async () => {
    assert.equal((await startFillPhase({ playbook: PB, automationId: null, tableArtifacts: TABLE }, deps({ automation: manual }))).code, 'automation_missing');
    assert.equal((await startFillPhase({ playbook: PB, automationId: 'a1', tableArtifacts: TABLE }, deps({ automation: { ...manual, userId: 'u2' } }))).code, 'not_owner');
    const r = await startFillPhase({ playbook: PB, automationId: 'a1', tableArtifacts: TABLE }, deps({ automation: { ...manual, definition: { trigger: { kind: 'nextcloud_file' } } } }));
    assert.equal(r.code, 'trigger_not_manual');
    assert.match(r.error, /"nextcloud_file"/);
});

test('a run that outlives the guard is reported timedOut with the run id it already got', async () => {
    let resolveRun;
    const execute = async (a, opts) => { opts.onRunCreated({ id: 'run_slow' }); return new Promise((res) => { resolveRun = res; }); };
    const r = await startFillPhase({ playbook: PB, automationId: 'a1', tableArtifacts: TABLE }, deps({ automation: manual, execute }));
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, true);
    assert.equal(r.run, null);
    assert.equal(r.runId, 'run_slow');
    resolveRun({ id: 'run_slow', status: 'success' });
    assert.equal((await r.runPromise).status, 'success');
});

test('refreshFillPhase: a successful run → awaiting with the added-rows summary; an error run → failed; still running → the row count only; stale → failed', async () => {
    const phase = { key: 'fill', status: 'running', startedAt: new Date().toISOString(), artifacts: { ...TABLE, runId: 'run_1', rowsBefore: 3, rowCount: 3 } };
    const ok = await refreshFillPhase(phase, deps({ runs: { run_1: { id: 'run_1', status: 'success' } }, rowCount: 35 }));
    assert.equal(ok.status, 'awaiting');
    assert.equal(ok.artifacts.rowCount, 35);
    assert.equal(ok.artifacts.runStatus, 'success');
    assert.match(ok.summary, /32 rijen toegevoegd aan de tabel \(nu 35\)/);
    // An English playbook reports it in English.
    const en = await refreshFillPhase(phase, deps({ runs: { run_1: { id: 'run_1', status: 'success' } }, rowCount: 35 }), Date.now(), { locale: 'en' });
    assert.equal(en.summary, '32 rows added to the table (35 now).');
    const enFailed = await refreshFillPhase(phase, deps({ runs: { run_1: { id: 'run_1', status: 'error' } }, rowCount: 3 }), Date.now(), { locale: 'en' });
    assert.equal(enFailed.error, 'The automation ended with status "error".');
    const bad = await refreshFillPhase(phase, deps({ runs: { run_1: { id: 'run_1', status: 'error', error: 'PDF unreadable' } }, rowCount: 3 }));
    assert.equal(bad.status, 'failed');
    assert.equal(bad.error, 'PDF unreadable');
    const progress = await refreshFillPhase(phase, deps({ runs: { run_1: { id: 'run_1', status: 'running' } }, rowCount: 9 }));
    assert.equal(progress.status, 'running');
    assert.equal(progress.artifacts.rowCount, 9);
    assert.equal(await refreshFillPhase(phase, deps({ runs: { run_1: { id: 'run_1', status: 'running' } }, rowCount: 3 })), null, 'nothing changed');
    const stale = await refreshFillPhase({ ...phase, startedAt: new Date(Date.now() - 20 * 60_000).toISOString() }, deps({ runs: { run_1: { id: 'run_1', status: 'running' } }, rowCount: 3 }), Date.now(), { locale: 'en' });
    assert.equal(stale.status, 'failed');
    assert.match(stale.error, /15 minutes/);
    assert.equal(await refreshFillPhase({ ...phase, artifacts: { ...TABLE } }, deps({})), null, 'no run id yet');
});

// A run row that was never created is the case that used to hang for ever: the
// id check sat ABOVE the stale guard, so the phase was polled every two seconds
// with nothing to poll and no way to fail.
test('refreshFillPhase: a phase with no run id still fails once it is stale', async () => {
    const phase = { key: 'fill', status: 'running', startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), artifacts: { ...TABLE } };
    const out = await refreshFillPhase(phase, deps({}), Date.now(), { locale: 'en' });
    assert.equal(out.status, 'failed');
    assert.match(out.error, /did not start/);
    const fresh = await refreshFillPhase({ ...phase, startedAt: new Date().toISOString() }, deps({}), Date.now(), { locale: 'en' });
    assert.equal(fresh, null, 'a young phase with no run id is still just waiting');
});
