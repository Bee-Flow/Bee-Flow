/**
 * Runner — framework gating, the per-check wall clock, the score snapshot and
 * the restricted sweeps. The registry, the framework policy and the store are
 * doubles: what is under test is which checks run, what gets persisted and
 * what the snapshot carries — not any check's logic.
 *
 * Run: node --test --test-force-exit server/compliance/runner.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// A short wall clock so the timeout case runs in milliseconds. Read once at
// module load by runner.js, so it must be set before the require below.
process.env.COMPLIANCE_CHECK_TIMEOUT_MS = '40';

// ── doubles ──────────────────────────────────────────────────────────────

const checks = new Map();
const fakeRegistry = {
    register: (c) => checks.set(c.id, c),
    get: (id) => checks.get(id),
    getAll: () => Array.from(checks.values()),
};

let activeSet = new Set(['GDPR', 'AIA', 'ISO27001']);
const fakePolicy = {
    activeRegulations: async () => new Set(activeSet),
    UnknownFrameworkError: class UnknownFrameworkError extends Error {
        constructor(id) { super(`Unknown framework: ${id}`); this.code = 'unknown_framework'; }
    },
    EntitlementsUnavailableError: class EntitlementsUnavailableError extends Error {},
};

const store = { results: [], evidence: [], snapshots: [] };
const fakeStore = {
    recordCheckResult: async (row) => { store.results.push(row); },
    addEvidence: async (row) => { store.evidence.push(row); return { id: store.evidence.length, seq: store.evidence.length, hash: row.hash }; },
    recordScoreSnapshot: async (row) => { store.snapshots.push(row); },
};

const restore = installResolveStub({
    './registry': fakeRegistry,
    './frameworkPolicy': fakePolicy,
    '../stores/complianceStore': fakeStore,
});
const runner = require('./runner');
after(restore);

function check(id, regulation, overrides = {}) {
    return {
        id, regulation, article: overrides.article || '1', severity: 'high', scope: 'global', verification: 'automated',
        frameworks: [{ regulation, ref: overrides.article || '1' }],
        evaluate: async () => ({ status: 'pass', evidence: {}, details: null }),
        ...overrides,
    };
}

beforeEach(() => {
    checks.clear();
    store.results.length = 0;
    store.evidence.length = 0;
    store.snapshots.length = 0;
    activeSet = new Set(['GDPR', 'AIA', 'ISO27001']);
});

// ── runAll: gating ───────────────────────────────────────────────────────

test('runAll evaluates and persists only checks of active frameworks', async () => {
    let nis2Ran = false;
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR', { article: '32' }));
    fakeRegistry.register(check('NIS2-Art21(2)(j)-admin-mfa', 'NIS2', {
        article: '21(2)(j)',
        evaluate: async () => { nis2Ran = true; return { status: 'fail' }; },
    }));

    const results = await runner.runAll('org1');

    assert.strictEqual(nis2Ran, false, 'a disabled framework\'s check must never be evaluated');
    assert.deepStrictEqual(results.map(r => r.check_id), ['GDPR-Art32-x']);
    assert.deepStrictEqual(store.results.map(r => r.check_id), ['GDPR-Art32-x'], 'no rows for the inactive framework');
    assert.deepStrictEqual(store.evidence.map(r => r.check_id), ['GDPR-Art32-x'], 'no evidence for the inactive framework');
});

test('runAll includes a framework once it is active', async () => {
    activeSet.add('NIS2');
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    fakeRegistry.register(check('NIS2-Art21-y', 'NIS2'));

    const results = await runner.runAll('org1');
    assert.deepStrictEqual(results.map(r => r.check_id).sort(), ['GDPR-Art32-x', 'NIS2-Art21-y']);
    assert.strictEqual(store.results.length, 2);
});

test('runAll carries the check regulation on every result row', async () => {
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    const [r] = await runner.runAll('org1');
    assert.strictEqual(r.regulation, 'GDPR');
    assert.strictEqual(store.results[0].regulation, 'GDPR');
});

// ── runAll: wall clock ───────────────────────────────────────────────────

test('a check that exceeds the wall clock is recorded as fail with a timeout detail', async () => {
    fakeRegistry.register(check('GDPR-Art32-slow', 'GDPR', {
        // Resolves well after the 40 ms budget.
        evaluate: () => new Promise(resolve => setTimeout(() => resolve({ status: 'pass' }), 400)),
    }));
    fakeRegistry.register(check('GDPR-Art32-fast', 'GDPR'));

    const started = Date.now();
    const results = await runner.runAll('org1');
    assert.ok(Date.now() - started < 2000, 'the sweep must not wait for the hanging check');

    const slow = results.find(r => r.check_id === 'GDPR-Art32-slow');
    assert.strictEqual(slow.status, 'fail');
    assert.match(slow.details, /timed out after 40 ms/);
    assert.strictEqual(slow.evidence.error, 'timeout');
    assert.strictEqual(slow.evidence.timeout_ms, 40);

    // The sweep moved on: the next check still ran and was persisted.
    const fast = results.find(r => r.check_id === 'GDPR-Art32-fast');
    assert.strictEqual(fast.status, 'pass');
    assert.strictEqual(store.results.filter(r => r.check_id === 'GDPR-Art32-slow')[0].status, 'fail');
});

test('a throwing check is recorded as fail with the exception, not as a timeout', async () => {
    fakeRegistry.register(check('GDPR-Art32-boom', 'GDPR', { evaluate: async () => { throw new Error('db gone'); } }));
    const [r] = await runner.runAll('org1');
    assert.strictEqual(r.status, 'fail');
    assert.match(r.details, /Check raised an exception: db gone/);
    assert.deepStrictEqual(r.evidence, { error: 'db gone' });
});

// ── runAll: snapshot ─────────────────────────────────────────────────────

test('the snapshot carries scores per active framework id plus the legacy columns', async () => {
    activeSet.add('NIS2');
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR', { severity: 'high' }));          // pass
    fakeRegistry.register(check('AIA-Art50-y', 'AIA', { severity: 'high', evaluate: async () => ({ status: 'fail' }) }));
    fakeRegistry.register(check('NIS2-Art21-z', 'NIS2', { severity: 'medium', evaluate: async () => ({ status: 'warn' }) }));
    // No ISO check registered → ISO scores NULL, never 100.

    await runner.runAll('org1', { runType: 'scheduled' });

    assert.strictEqual(store.snapshots.length, 1);
    const snap = store.snapshots[0];
    assert.strictEqual(snap.organization_id, 'org1');
    assert.strictEqual(snap.run_type, 'scheduled');
    assert.deepStrictEqual(snap.scores, { gdpr: 100, aia: 0, iso27001: null, nis2: 50 });
    // Legacy columns are the same numbers under their old names.
    assert.strictEqual(snap.gdpr_score, 100);
    assert.strictEqual(snap.aia_score, 0);
    assert.strictEqual(snap.iso_score, null);
    // Counters over every row of the sweep.
    assert.strictEqual(snap.pass, 1);
    assert.strictEqual(snap.warn, 1);
    assert.strictEqual(snap.fail, 1);
    assert.strictEqual(snap.na, 0);
});

test('a shared check counts for every framework it is tagged with', async () => {
    fakeRegistry.register(check('GDPR-Art33-breach', 'GDPR', {
        article: '33',
        frameworks: [{ regulation: 'GDPR', ref: '33' }, { regulation: 'ISO27001', ref: 'A.5.24' }],
    }));
    await runner.runAll('org1');
    const snap = store.snapshots[0];
    assert.strictEqual(snap.scores.gdpr, 100);
    assert.strictEqual(snap.scores.iso27001, 100, 'the ISO score is fed by the GDPR check that also counts for A.5.24');
    assert.strictEqual(snap.scores.aia, null);
});

test('inactive frameworks are absent from the snapshot scores', async () => {
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    await runner.runAll('org1');
    const keys = Object.keys(store.snapshots[0].scores).sort();
    assert.deepStrictEqual(keys, ['aia', 'gdpr', 'iso27001'], 'only the active (core) frameworks are keyed');
});

test('a snapshot failure never fails the run', async () => {
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    const original = fakeStore.recordScoreSnapshot;
    fakeStore.recordScoreSnapshot = async () => { throw new Error('history table missing'); };
    try {
        const results = await runner.runAll('org1');
        assert.strictEqual(results.length, 1);
    } finally {
        fakeStore.recordScoreSnapshot = original;
    }
});

// ── runFramework ─────────────────────────────────────────────────────────

test('runFramework runs only that framework\'s checks and writes no snapshot', async () => {
    activeSet.add('NIS2');
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    fakeRegistry.register(check('NIS2-Art21-y', 'NIS2'));

    const results = await runner.runFramework('org1', 'nis2');
    assert.deepStrictEqual(results.map(r => r.check_id), ['NIS2-Art21-y']);
    assert.deepStrictEqual(store.results.map(r => r.check_id), ['NIS2-Art21-y']);
    assert.strictEqual(store.results[0].run_type, 'manual');
    assert.strictEqual(store.snapshots.length, 0, 'a partial sweep must not record a trend point with NULLs for every other framework');
});

test('runFramework on a framework that is not active runs nothing', async () => {
    fakeRegistry.register(check('NIS2-Art21-y', 'NIS2'));
    const results = await runner.runFramework('org1', 'nis2');
    assert.deepStrictEqual(results, []);
    assert.strictEqual(store.results.length, 0);
});

test('runFramework rejects an unknown framework id', async () => {
    await assert.rejects(() => runner.runFramework('org1', 'gdpr2'), (e) => e.code === 'unknown_framework');
});

// ── runOne ───────────────────────────────────────────────────────────────

test('runOne refuses a check whose framework is not active', async () => {
    let ran = false;
    fakeRegistry.register(check('NIS2-Art21-y', 'NIS2', { evaluate: async () => { ran = true; return { status: 'pass' }; } }));
    await assert.rejects(
        () => runner.runOne('org1', 'NIS2-Art21-y'),
        (e) => e instanceof runner.FrameworkDisabledError && e.code === 'framework_disabled' && e.body.framework === 'nis2',
    );
    assert.strictEqual(ran, false);
    assert.strictEqual(store.results.length, 0);
});

test('runOne runs a check of an active framework and persists one row', async () => {
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    const r = await runner.runOne('org1', 'GDPR-Art32-x');
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(store.results.length, 1);
    assert.strictEqual(store.results[0].run_type, 'manual');
    assert.strictEqual(store.snapshots.length, 0);
});

test('runOne on a per-source check scopes to one subject', async () => {
    fakeRegistry.register(check('GDPR-Art30-ps', 'GDPR', {
        scope: 'per-source',
        listSubjects: async () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        evaluate: async (_org, subj) => ({ status: subj.id === 'a' ? 'pass' : 'fail' }),
    }));
    const r = await runner.runOne('org1', 'GDPR-Art30-ps', { subjectId: 'b' });
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(store.results.length, 1);
    assert.strictEqual(store.results[0].scope_id, 'b');
});

test('runOne rejects an unknown check id', async () => {
    await assert.rejects(() => runner.runOne('org1', 'nope'), /Unknown check: nope/);
});

// ── per-source expansion in runAll ───────────────────────────────────────

test('a per-source check with no subjects yields one not_applicable row', async () => {
    fakeRegistry.register(check('GDPR-Art30-ps', 'GDPR', { scope: 'per-source', listSubjects: async () => [] }));
    const [r] = await runner.runAll('org1');
    assert.strictEqual(r.status, 'not_applicable');
    assert.strictEqual(r.scope, 'per-source');
    assert.strictEqual(store.results.length, 1);
    assert.strictEqual(store.results[0].scope_id, null);
    assert.strictEqual(store.snapshots[0].na, 1);
});

// ── coverage: the false green ────────────────────────────────────────────
//
// These pin the bug that made coverage a first-class part of a run. A
// per-source check only ever produces rows for the subjects it can SEE. An
// organisation that had registered none of its tables gave the Art. 30 check
// nothing to judge, so it wrote one `not_applicable` filler — which the score
// excludes from the denominator outright — and the Compliance Center showed
// that organisation the score of the checks that happened to run. 100 %, for
// an organisation whose personal data nobody had ever recorded anywhere. The
// worse the coverage, the greener the dashboard. A check that can enumerate
// its population now declares it, and the part it never examined is a row of
// its own: named, in the score, and on the snapshot.

/** A per-source check that can see `examined` subjects out of a population of `total`. */
function coveringCheck(id, { subjects = [], unexamined = [], total = 0, severity = 'high', ...rest } = {}) {
    return check(id, 'GDPR', {
        severity,
        scope: 'per-source',
        listSubjects: async () => subjects,
        evaluate: async () => ({ status: 'pass' }),
        listCoverage: async () => ({
            kind: 'datatable', label: 'Studio tables',
            total, examined: total - unexamined.length, unexamined,
            link: 'admin/compliance/ropa',
            examined_as: 'recorded in the processing register',
            next_step: 'Open Compliance → Processing register and record what each one holds.',
        }),
        ...rest,
    });
}

const TABLES = [
    { id: 'tbl_1', label: 'Leads 2024' },
    { id: 'tbl_2', label: 'HR intake' },
    { id: 'tbl_3', label: 'Klantcontact' },
];

test('an organisation whose tables are all outside the register cannot score 100', async () => {
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR', { severity: 'high' }));            // passes
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', { subjects: [], unexamined: TABLES, total: 3 }));

    const results = await runner.runAll('org1');

    // The old shape of this sweep: one pass + one not_applicable filler, and
    // 100 % — the three tables appeared nowhere at all.
    const cov = results.find(r => r.scope === 'coverage');
    assert.ok(cov, 'the check declared a population, so the sweep must report what it covered');
    assert.strictEqual(cov.status, 'fail', 'nothing at all was examined — that is not a warning, it is the verdicts being about nothing');
    assert.strictEqual(cov.evidence.total, 3);
    assert.strictEqual(cov.evidence.examined, 0);
    assert.strictEqual(cov.evidence.unexamined_count, 3);

    const snap = store.snapshots[0];
    assert.notStrictEqual(snap.overall_score, 100, 'a score of 100 over an examination of nothing is the bug');
    assert.strictEqual(snap.overall_score, 50, 'the passing check (weight 2) against the coverage failure (weight 2)');
    assert.strictEqual(snap.scores.gdpr, 50);
});

test('the unexamined tables are named, so the next click is obvious', async () => {
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', { subjects: [], unexamined: TABLES, total: 3 }));
    const [, cov] = await runner.runAll('org1');

    assert.match(cov.details, /"Leads 2024"/);
    assert.match(cov.details, /"HR intake"/);
    assert.match(cov.details, /"Klantcontact"/);
    assert.match(cov.details, /Processing register/, 'and where to go about them');
    assert.deepStrictEqual(cov.evidence.unexamined, TABLES, 'the drawer behind the row has the full list');
    assert.strictEqual(cov.evidence.link, 'admin/compliance/ropa');
});

test('the words for what "examined" means belong to the check, not to the runner', async () => {
    // The runner writes the row; it has no business knowing what a Studio
    // table is. A check that supplies no wording still gets a sentence that
    // is true, just a generic one.
    fakeRegistry.register(check('GDPR-Art30-bare', 'GDPR', {
        listCoverage: async () => ({ kind: 'thing', label: 'Widgets', total: 2, examined: 1, unexamined: [{ id: 'w2', label: 'Second widget' }] }),
    }));
    const [, cov] = await runner.runAll('org1');
    assert.match(cov.details, /1 of this organisation's 2 widgets have never been examined/);
    assert.ok(!/processing register/i.test(cov.details), 'the runner must not put a GDPR register in another check\'s sentence');
    assert.ok(cov.details.endsWith('"Second widget".'), 'no next step supplied, no dangling sentence');
});

test('a partly examined population is a warning that says how much of the score is unbacked', async () => {
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', {
        subjects: [{ id: 'datatable:tbl_9', label: 'Registered' }],
        unexamined: TABLES, total: 4,
    }));
    const results = await runner.runAll('org1');
    const cov = results.find(r => r.scope === 'coverage');

    assert.strictEqual(cov.status, 'warn', 'some of it WAS examined — this is incomplete, not empty');
    assert.match(cov.details, /3 of this organisation's 4 studio tables/);
    assert.match(cov.details, /the score covers only the other 1/);
    assert.strictEqual(store.snapshots[0].coverage.complete, false);
    assert.strictEqual(store.snapshots[0].coverage.unexamined, 3);
});

test('a fully examined population passes, and only then does the snapshot read complete', async () => {
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', {
        subjects: TABLES.map(t => ({ id: `datatable:${t.id}`, label: t.label })),
        unexamined: [], total: 3,
    }));
    const results = await runner.runAll('org1');
    const cov = results.find(r => r.scope === 'coverage');

    assert.strictEqual(cov.status, 'pass');
    assert.match(cov.details, /All 3 of this organisation's studio tables were recorded in the processing register/);
    assert.deepStrictEqual(store.snapshots[0].coverage, {
        total: 3, examined: 3, unexamined: 0, unknown_populations: 0, complete: true,
        populations: [{
            check_id: 'GDPR-Art30-datatables', kind: 'datatable', label: 'Studio tables',
            total: 3, examined: 3, unexamined: 0, link: 'admin/compliance/ropa', sample: [],
        }],
    });
});

test('an organisation with nothing to examine is not accused of anything', async () => {
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', { subjects: [], unexamined: [], total: 0 }));
    const results = await runner.runAll('org1');
    const cov = results.find(r => r.scope === 'coverage');

    assert.strictEqual(cov.status, 'not_applicable', 'no tables at all is a fact, not a failure');
    assert.match(cov.details, /no studio tables/);
    assert.strictEqual(store.snapshots[0].coverage.complete, true);
});

test('a population that cannot be read is unknown coverage, never a silent all-clear', async () => {
    fakeRegistry.register(check('GDPR-Art30-datatables', 'GDPR', {
        listCoverage: async () => { throw new Error('relation "datatables" does not exist'); },
    }));
    const results = await runner.runAll('org1');
    const cov = results.find(r => r.scope === 'coverage');

    assert.strictEqual(cov.status, 'warn', 'an unreadable population must not read as "nothing is missing"');
    assert.strictEqual(cov.evidence.unknown, true);
    assert.strictEqual(cov.evidence.total, null, 'not 0 — we do not know that it is 0');
    assert.match(cov.details, /unknown share/);
    const snapCoverage = store.snapshots[0].coverage;
    assert.strictEqual(snapCoverage.unknown_populations, 1);
    assert.strictEqual(snapCoverage.complete, false, 'a run with an unknown population is never complete');
});

test('a listCoverage that hangs is unknown coverage, and does not hold up the sweep', async () => {
    fakeRegistry.register(check('GDPR-Art30-datatables', 'GDPR', {
        // Resolves well after the 40 ms budget this file installs.
        listCoverage: () => new Promise(resolve => setTimeout(() => resolve({ kind: 'datatable', total: 0, examined: 0, unexamined: [] }), 400)),
    }));
    fakeRegistry.register(check('GDPR-Art32-fast', 'GDPR'));

    const started = Date.now();
    const results = await runner.runAll('org1');
    assert.ok(Date.now() - started < 2000, 'the sweep must not wait for a hanging listCoverage');

    const cov = results.find(r => r.scope === 'coverage');
    assert.strictEqual(cov.status, 'warn');
    assert.strictEqual(cov.evidence.unknown, true);
    assert.match(cov.evidence.error, /timed out after 40 ms/);
    assert.strictEqual(results.find(r => r.check_id === 'GDPR-Art32-fast').status, 'pass');
});

test('the coverage row gets its own slot and never overwrites a verdict', async () => {
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', { subjects: [], unexamined: TABLES, total: 3 }));
    await runner.runAll('org1');

    const rows = store.results.filter(r => r.check_id === 'GDPR-Art30-datatables');
    assert.strictEqual(rows.length, 2, 'the "no subjects" filler AND the coverage row — the score needs both');
    const [filler, cov] = rows;
    // The "no subjects" filler has been persisted in the `global` slot since
    // the runner was written (a subject-less row takes the global scope), and
    // that is left exactly as it is here — what matters is that the coverage
    // row does not land in the same slot and overwrite it.
    assert.deepStrictEqual([filler.scope_type, filler.scope_id], ['global', null]);
    // getLatestPerCheck keys on (check_id, scope_type, scope_id), so a constant
    // slot means the next sweep replaces this coverage claim instead of leaving
    // a stale one beside it.
    assert.deepStrictEqual([cov.scope_type, cov.scope_id], ['coverage', 'coverage']);
    assert.strictEqual(cov.severity, 'high', 'the coverage row carries the check\'s own weight');
    assert.strictEqual(cov.regulation, 'GDPR');

    const ev = store.evidence.filter(e => e.subject_type === 'coverage');
    assert.strictEqual(ev.length, 1, 'coverage is evidence too — Art. 5(2) covers what we did not look at');
    assert.strictEqual(ev[0].payload.evidence.unexamined_count, 3);
});

test('a check that declares no population is left exactly as it was', async () => {
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR'));
    const results = await runner.runAll('org1');
    assert.strictEqual(results.length, 1, 'no listCoverage, no coverage row');
    assert.strictEqual(store.results.length, 1);
    assert.strictEqual(store.snapshots[0].coverage, null, 'a sweep where nothing declared a population records no coverage, rather than claiming full coverage');
});

test('the organisation that did the work must not score worse than the one that did none', async () => {
    // Two organisations, same checks. The first registered none of its three
    // tables, so the Art. 30 check had nothing to judge. The second registered
    // all three and one of them needs attention. Before coverage existed the
    // first scored 100 and the second 88: the arithmetic rewarded never having
    // looked, which is the whole reason this row exists.
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR', { severity: 'high' }));
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', { subjects: [], unexamined: TABLES, total: 3 }));
    await runner.runAll('org-looked-at-nothing');
    const lookedAtNothing = store.snapshots[0].overall_score;

    checks.clear();
    store.snapshots.length = 0;
    fakeRegistry.register(check('GDPR-Art32-x', 'GDPR', { severity: 'high' }));
    fakeRegistry.register(coveringCheck('GDPR-Art30-datatables', {
        subjects: TABLES.map(t => ({ id: `datatable:${t.id}`, label: t.label })),
        unexamined: [], total: 3,
        // An honest register with one registration that has gone stale.
        evaluate: async (_org, subj) => ({ status: subj.id === 'datatable:tbl_3' ? 'warn' : 'pass' }),
    }));
    await runner.runAll('org-registered-everything');
    const registeredEverything = store.snapshots[0].overall_score;

    assert.ok(lookedAtNothing < registeredEverything,
        `looking at nothing (${lookedAtNothing}) must never score better than registering everything and having one thing to fix (${registeredEverything})`);
    assert.strictEqual(lookedAtNothing, 50);
    assert.strictEqual(registeredEverything, 90);
});

// ══════════════════════════════════════════════════════════════════════════
// runForSubject — the review one thing gets when it changes
//
// A routine switched on at 09:05 used to be judged by the 06:00 sweep, which
// could not have seen it. runForSubject is how activation gets a verdict the
// same minute instead of hours later, so what these pin is: only the checks
// that actually hold the subject run, nothing is written for the ones that do
// not, and no workspace-wide artefact (global verdict, score snapshot) is
// rewritten off the back of one toggle.
// ══════════════════════════════════════════════════════════════════════════

/** A per-source check over a fixed subject list. */
function subjectCheck(id, regulation, subjects, overrides = {}) {
    return check(id, regulation, {
        scope: 'per-source',
        listSubjects: async () => subjects,
        evaluate: async (_org, subj) => ({ status: 'fail', evidence: { subject: subj?.id }, details: `judged ${subj?.id}` }),
        ...overrides,
    });
}

test('runForSubject runs only the checks that hold the subject, and writes nothing for the rest', async () => {
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [
        { id: 'auto-1', label: 'Invoice mailer' },
        { id: 'auto-2', label: 'Something else' },
    ]));
    fakeRegistry.register(subjectCheck('GDPR-Art35-dpia', 'GDPR', [{ id: 'agent-9', label: 'An agent' }]));
    fakeRegistry.register(check('GDPR-Art32-encryption', 'GDPR'));   // global

    const out = await runner.runForSubject('org1', ['auto-1']);

    assert.deepStrictEqual(out.map(r => r.check_id), ['AIA-Art50-marking']);
    assert.deepStrictEqual(out.map(r => r.subject.id), ['auto-1'], 'and only the one subject, not its siblings');
    assert.deepStrictEqual(
        store.results.map(r => [r.check_id, r.scope_type, r.scope_id]),
        [['AIA-Art50-marking', 'per-source', 'auto-1']],
        'a check that never heard of this subject must not have a row written for it',
    );
});

test('a check that does not hold the subject keeps its own verdict — runOne would have blanked it', async () => {
    // THE REASON runForSubject EXISTS AS ITS OWN FUNCTION. runOne, handed a
    // subjectId a check does not have, filters its subjects to nothing and
    // persists `not_applicable` / "Subject not found." with NO subject — which
    // lands in that check's GLOBAL slot (scope_type 'global', scope_id NULL).
    // getLatestPerCheck takes the newest row per slot, so asking every check
    // about one routine through runOne would replace each unrelated check's
    // real finding with a shrug. One routine going live would have emptied the
    // dashboard. This test holds the two side by side so nobody ever
    // "simplifies" runForSubject into a loop over runOne.
    fakeRegistry.register(subjectCheck('GDPR-Art35-dpia', 'GDPR', [{ id: 'agent-9', label: 'An agent' }]));

    await runner.runOne('org1', 'GDPR-Art35-dpia', { subjectId: 'auto-1' });
    const viaRunOne = store.results.filter(r => r.check_id === 'GDPR-Art35-dpia');
    assert.strictEqual(viaRunOne.length, 1, 'runOne still behaves as it always has');
    assert.deepStrictEqual([viaRunOne[0].scope_type, viaRunOne[0].scope_id], ['global', null]);
    assert.strictEqual(viaRunOne[0].status, 'not_applicable');
    assert.match(viaRunOne[0].details, /Subject not found/);

    store.results.length = 0;
    store.evidence.length = 0;

    const out = await runner.runForSubject('org1', ['auto-1']);
    assert.deepStrictEqual(out, [], 'no check holds this subject');
    assert.deepStrictEqual(store.results, [], 'and so nothing is written — the global slot is left alone');
    assert.deepStrictEqual(store.evidence, [], 'no evidence row either');
});

test('runForSubject accepts every spelling of the same subject and unions them', async () => {
    // Two real checks hold a routine under two different ids: Art. 50 by its
    // bare id, the Machinery check as "<source>:<id>". Asking with one
    // spelling would review half of what applies and look like it worked.
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [{ id: 'auto-1', label: 'r' }]));
    fakeRegistry.register(subjectCheck('MACHINERY-Art18-assessment', 'MACHINERY', [{ id: 'automation:auto-1', label: 'r' }]));
    activeSet.add('MACHINERY');

    const out = await runner.runForSubject('org1', ['auto-1', 'automation:auto-1']);
    assert.deepStrictEqual(out.map(r => r.check_id).sort(), ['AIA-Art50-marking', 'MACHINERY-Art18-assessment']);
});

test('runForSubject writes no score snapshot — a trend point is a full sweep or nothing', async () => {
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [{ id: 'auto-1', label: 'r' }]));
    await runner.runForSubject('org1', ['auto-1']);
    assert.deepStrictEqual(store.snapshots, [],
        'one routine cannot produce a trend point: every framework it did not look at would be recorded as NULL');
});

test('runForSubject never runs a check whose framework is switched off', async () => {
    let ran = false;
    fakeRegistry.register(subjectCheck('NIS2-Art21-x', 'NIS2', [{ id: 'auto-1', label: 'r' }], {
        evaluate: async () => { ran = true; return { status: 'fail' }; },
    }));
    const out = await runner.runForSubject('org1', ['auto-1']);
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(store.results, [], 'a locked framework gets no rows from a toggle either');
});

test('one check that cannot list its population does not stop the others judging the routine', async () => {
    fakeRegistry.register(subjectCheck('GDPR-Art30-datatables', 'GDPR', null, {
        listSubjects: async () => { throw new Error('datatable store is down'); },
    }));
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [{ id: 'auto-1', label: 'r' }]));

    const out = await runner.runForSubject('org1', ['auto-1']);
    assert.deepStrictEqual(out.map(r => r.check_id), ['AIA-Art50-marking']);
    assert.ok(!store.results.some(r => r.check_id === 'GDPR-Art30-datatables'),
        'the broken check writes nothing — its previous row stands and the sweep will retry');
});

test('a check that throws while judging the subject is recorded as a failure, not lost', async () => {
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [{ id: 'auto-1', label: 'r' }], {
        evaluate: async () => { throw new Error('boom'); },
    }));
    const out = await runner.runForSubject('org1', ['auto-1']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].status, 'fail');
    assert.match(store.results[0].details, /raised an exception/);
});

test('runForSubject with no org or no subject is a no-op rather than a throw', async () => {
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [{ id: 'auto-1', label: 'r' }]));
    assert.deepStrictEqual(await runner.runForSubject('org1', []), []);
    assert.deepStrictEqual(await runner.runForSubject('org1', [null, '', '  ']), []);
    assert.deepStrictEqual(await runner.runForSubject(null, ['auto-1']), []);
    assert.deepStrictEqual(store.results, []);
});

test('the rows a subject review writes are marked run_type "event"', async () => {
    fakeRegistry.register(subjectCheck('AIA-Art50-marking', 'AIA', [{ id: 'auto-1', label: 'r' }]));
    await runner.runForSubject('org1', ['auto-1']);
    assert.strictEqual(store.results[0].run_type, 'event',
        'the check history has to show this verdict came from something happening, not from the 6-hourly clock');
    assert.strictEqual(store.evidence[0].payload.run_type, 'event');
});
