/**
 * A registration is a claim about the world, made once. This check goes back
 * and reads whether it is still true — and the five ways it stops being true
 * are the whole of the test.
 *
 * Run: node --test --test-force-exit compliance/checks/gdpr/art30-datatable-registrations.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const CHK = require('./art30-datatable-registrations');

const NOW = Date.parse('2026-09-16T12:00:00Z');
const FIELDS = [{ key: 'created_at', name: 'Created At' }, { key: 'supplier', name: 'Supplier' }];
const ROW = {
    id: 'tbl_1', name: 'Invoice BI Automator', scope_kind: 'org', scope_id: 'orgA',
    lawful_basis: 'contract', retention_days: 365, retention_field: 'created_at', subject_column: 'contact_person',
};
const ctx = (over = {}) => ({ fields: FIELDS, outside: 0, reviewDays: 180, lastReviewed: NOW - 10 * 86400000, now: NOW, ...over });

test('it passes only when the registration still describes the table', () => {
    const ok = CHK._verdict(ROW, ctx());
    assert.equal(ok.status, 'pass');
    assert.match(ok.details, /contract, kept 365 days from "created_at"/);
    assert.equal(ok.evidence.rows_outside_window, 0);
});

test('a legal basis that is gone, or was never one of the six', () => {
    assert.equal(CHK._verdict({ ...ROW, lawful_basis: null }, ctx()).status, 'fail');
    const junk = CHK._verdict({ ...ROW, lawful_basis: 'because we felt like it' }, ctx());
    assert.equal(junk.status, 'fail');
    assert.match(junk.details, /not one of the six/);
});

test('a retention period the clean-up can never act on', () => {
    // No column at all: the number is on record and nothing is ever deleted.
    const noField = CHK._verdict({ ...ROW, retention_field: null }, ctx());
    assert.equal(noField.status, 'fail');
    assert.match(noField.details, /records no date to count from/);
    // The column was there and is not any more.
    const gone = CHK._verdict({ ...ROW, retention_field: 'deleted_column' }, ctx());
    assert.equal(gone.status, 'fail');
    assert.match(gone.details, /no longer in the table/);
    // A table whose columns could not be read is not accused of anything.
    assert.equal(CHK._verdict({ ...ROW, retention_field: 'deleted_column' }, ctx({ fields: [] })).status, 'pass');
});

test('rows older than the window mean the clean-up is not running, whatever the register says', () => {
    const late = CHK._verdict(ROW, ctx({ outside: 3 }));
    assert.equal(late.status, 'warn');
    assert.match(late.details, /3 row\(s\) are older than that/);
    assert.equal(late.evidence.rows_outside_window, 3);
});

test('a basis with no period, and a registration nobody has looked at since the interval', () => {
    const noDays = CHK._verdict({ ...ROW, retention_days: null }, ctx());
    assert.equal(noDays.status, 'warn');
    assert.match(noDays.details, /no retention period/);

    const stale = CHK._verdict(ROW, ctx({ lastReviewed: NOW - 200 * 86400000 }));
    assert.equal(stale.status, 'warn');
    assert.match(stale.details, /last confirmed 200 days ago and your interval is 180/);
    // The interval is the organisation's own, not a constant in here.
    assert.equal(CHK._verdict(ROW, ctx({ lastReviewed: NOW - 200 * 86400000, reviewDays: 365 })).status, 'pass');
    // Never reviewed is not held against a registration made yesterday.
    assert.equal(CHK._verdict(ROW, ctx({ lastReviewed: null })).status, 'pass');
});

test('it reports one result per registered table, and forgets one that has left the register', async () => {
    const deps = {
        getAll: async () => [ROW, { ...ROW, id: 'tbl_2', name: 'Second' }],
        getTableMeta: async () => ({ fields: FIELDS }),
        countOutside: async () => 0,
        now: () => NOW,
    };
    const subjects = await CHK.listSubjects('orgA', deps);
    assert.deepEqual(subjects, [
        { id: 'datatable:tbl_1', label: 'Invoice BI Automator' },
        { id: 'datatable:tbl_2', label: 'Second' },
    ]);
    const gone = await CHK.evaluate('orgA', { id: 'datatable:tbl_ghost' }, deps);
    assert.equal(gone.status, 'not_applicable');
    assert.equal((await CHK.evaluate('orgA', null, deps)).status, 'not_applicable');
});

test('a register that cannot be read is not "no longer in the register"', async () => {
    // not_applicable drops the table out of the score, so a transient read
    // error between listSubjects and evaluate used to hide a failing table.
    // Only the SQLSTATE travels, never the error message.
    const deps = {
        getAll: async () => { throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }); },
        getTableMeta: async () => ({ fields: FIELDS }),
        countOutside: async () => 0,
        now: () => NOW,
    };
    const v = await CHK.evaluate('orgA', { id: 'datatable:tbl_1' }, deps);
    assert.equal(v.status, 'warn');
    assert.equal(v.evidence.sqlstate, '57P01');
    assert.equal(v.evidence.datatable_id, 'tbl_1');
    assert.ok(!JSON.stringify(v).includes('terminating connection'), 'the raw error message stays out of the evidence');
});

test('the subject list is the whole register, so a table that left it is retired', async () => {
    // Without this the runner never marks the list complete, and the last
    // warning of a table taken out of the register stays in the score.
    const { _asListing } = require('../../runner');
    const deps = { getAll: async () => [ROW], getTableMeta: async () => ({ fields: FIELDS }), countOutside: async () => 0, now: () => NOW };
    assert.equal(_asListing(CHK, await CHK.listSubjects('orgA', deps)).complete, true);
    assert.equal(typeof CHK.retiredDetails, 'string');
});

test('the registry gets a check it will accept', () => {
    assert.equal(CHK.regulation, 'GDPR');
    assert.equal(CHK.article, '30');
    assert.equal(CHK.scope, 'per-source');
    assert.equal(typeof CHK.listSubjects, 'function');
    assert.equal(typeof CHK.evaluate, 'function');
    assert.ok(['automated', 'attestation', 'hybrid'].includes(CHK.verification));
    assert.equal(CHK.remediationLink, 'admin/compliance/ropa');
});

// ── coverage: the tables this check never opened ─────────────────────────
//
// Everything above only ever judges a table someone already recorded
// something about. That made the Compliance Center answer confidently about
// the registered handful and say nothing whatsoever about the rest — so an
// organisation that had registered none of its tables saw the score of the
// other checks, and the less anyone had looked, the better it read.
// listCoverage() is the other half of the answer: the whole population, and
// the part of it that is outside everything said above, by name.

const ALL = [
    { id: 'tbl_1', name: 'Invoice BI Automator', lawful_basis: 'contract', retention_days: 365 },
    { id: 'tbl_2', name: 'Retention only', lawful_basis: null, retention_days: 90 },
    { id: 'tbl_3', name: 'Leads 2024', lawful_basis: null, retention_days: null },
    { id: 'tbl_4', name: null, lawful_basis: null, retention_days: null },
];
const allDeps = (rows = ALL) => ({ getAll: async () => rows, getTableMeta: async () => ({ fields: FIELDS }), countOutside: async () => 0, now: () => NOW });

test('it reports the whole table population and names the ones nobody has recorded', async () => {
    const cov = await CHK.listCoverage('orgA', allDeps());
    assert.equal(cov.kind, 'datatable');
    assert.equal(cov.total, 4);
    assert.equal(cov.examined, 2, 'a legal basis OR a retention period is a registration');
    assert.deepEqual(cov.unexamined, [
        { id: 'tbl_3', label: 'Leads 2024' },
        // A table with no name is still named by something clickable.
        { id: 'tbl_4', label: 'tbl_4' },
    ]);
    assert.equal(cov.link, 'admin/compliance/ropa', 'the row points at the register, which is where the gap is closed');
});

test('"registered" is the RoPA\'s definition, not a second one invented here', async () => {
    // routes/compliance/ropa.js pushes compliance/ropa/datatableActivities'
    // rows into the Art. 30 record, and that module selects a table once it
    // has a lawful_basis or a retention_days. Coverage has to be measured
    // against THAT register: a table counted as registered here but absent
    // from the document (or the reverse) would make the product answer for
    // two different registers.
    assert.equal(CHK.isRegistered({ lawful_basis: 'contract', retention_days: null }), true);
    assert.equal(CHK.isRegistered({ lawful_basis: null, retention_days: 90 }), true);
    assert.equal(CHK.isRegistered({ lawful_basis: 'contract', retention_days: 365 }), true);
    assert.equal(CHK.isRegistered({ lawful_basis: null, retention_days: null }), false);
    assert.equal(CHK.isRegistered({}), false);

    // …and the SQL half of the same sentence still says it.
    let sql = '';
    await CHK._registeredTables('orgA', { getAll: async (q) => { sql = q; return []; } });
    assert.match(sql, /lawful_basis IS NOT NULL OR retention_days IS NOT NULL/);
});

test('the coverage query is not filtered — that is the whole point of it', async () => {
    let sql = '';
    await CHK._allTables('orgA', { getAll: async (q) => { sql = q; return []; } });
    assert.ok(!/lawful_basis IS NOT NULL/.test(sql), 'filtering here would hide exactly the tables being counted');
    assert.match(sql, /FROM datatables/);
    assert.match(sql, /organization_id = \$1/);
});

test('a table list that cannot be read is never reported as "no tables"', async () => {
    // Swallowing a read failure here would claim the workspace holds no
    // tables at all — "there is nothing we failed to look at" — which is the
    // false reassurance this whole function exists to prevent. The error goes
    // up, and the runner records the run as covering an unknown share.
    const boom = { getAll: async () => { throw new Error('relation "datatables" does not exist'); } };
    await assert.rejects(() => CHK.listCoverage('orgA', boom), /relation "datatables" does not exist/);
    // The register throws too: its list retires vanished slots, so an empty
    // register read off a failed query would retire every table.
    await assert.rejects(() => CHK._registeredTables('orgA', boom));
    await assert.rejects(() => CHK.listSubjects('orgA', boom));
});

test('an organisation with no tables reports an empty population, not a gap', async () => {
    const cov = await CHK.listCoverage('orgA', allDeps([]));
    assert.equal(cov.total, 0);
    assert.equal(cov.examined, 0);
    assert.deepEqual(cov.unexamined, []);
});

test('the runner can find the coverage contract on the module', () => {
    assert.equal(typeof CHK.listCoverage, 'function');
});

test('the sentence an admin actually reads names the tables and where to go', async () => {
    // The two halves composed: this check supplies the population and the
    // words for its own domain, compliance/runner.js turns them into the row.
    // Asserted end to end because the whole point of the row is that a person
    // reads it and knows what to click.
    const { _coverageVerdict } = require('../../runner');
    const row = _coverageVerdict(CHK, await CHK.listCoverage('orgA', allDeps()));

    assert.equal(row.status, 'warn', 'two of the four were registered — incomplete, not empty');
    assert.match(row.details, /2 of this organisation's 4 studio tables have never been recorded in the processing register/);
    assert.match(row.details, /the score covers only the other 2/);
    assert.match(row.details, /"Leads 2024", "tbl_4"/);
    assert.match(row.details, /Open Compliance → Processing register/);

    // And with nothing registered at all: the verdicts above are about nothing.
    const none = _coverageVerdict(CHK, await CHK.listCoverage('orgA', allDeps(ALL.map(r => ({ ...r, lawful_basis: null, retention_days: null })))));
    assert.equal(none.status, 'fail');
    assert.match(none.details, /this check examined nothing at all/);
});
