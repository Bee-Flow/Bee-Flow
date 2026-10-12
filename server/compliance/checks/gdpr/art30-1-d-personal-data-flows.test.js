/**
 * Art. 30(1)(d) over what is ALREADY RUNNING: where each live automation's
 * personal data goes, and whether anything stands in front of the step that
 * sends it.
 *
 * What these tests hold in place is mostly the difference between three
 * answers that read alike on a dashboard and are not: "nothing personal leaves
 * this automation", "personal data can leave it", and "nothing here could tell".
 * The third one is a pass in every product that has this bug, and it is the
 * one this check refuses to give.
 *
 * Run: node --test --test-force-exit compliance/checks/gdpr/art30-1-d-personal-data-flows.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const CHK = require('./art30-1-d-personal-data-flows');
const dataFlow = require('../../../core/privacy/dataFlow');

const flowOf = (steps, personal, observed = null) =>
    dataFlow.mergeObserved(dataFlow.analyseFlow({ steps, personal }), observed);
const step = (type, over = {}) => ({ type, tool: null, datatableId: null, ...over });
const PERSONAL = [{ key: 'email', name: 'E-mail', kind: 'email', kinds: ['email'], by: 'names' }];
const SENDS = [step('datatable', { datatableId: 'tbl_1' }), step('integration_action', { tool: 'gmail_compose' })];

test('an automation that can send personal data with nothing in front of it is a warning that names the recipient', () => {
    const v = CHK._verdict('Klantmailer', flowOf(SENDS, PERSONAL));
    assert.equal(v.status, 'warn');
    assert.match(v.details, /can send email to gmail/);
    assert.match(v.details, /no Privacy Shield step stands in front/);
    // Art. 30(1)(d) asks for the categories of RECIPIENTS, and the evidence
    // carries them — 'integration_action' names none.
    assert.deepEqual(v.evidence.destinations, ['gmail']);
    assert.equal(v.evidence.exits_unshielded, 1);
});

test('a Privacy Shield is a POSITION: one at the end of the automation is not a pass', () => {
    // The playbook review's own finding is titled "no privacy check IN FRONT
    // OF IT" and was gated on "is there a privacy step anywhere in this
    // automation". A shield dropped after the step that sends protects nothing.
    const after = CHK._verdict('Klantmailer', flowOf([...SENDS, step('guard')], PERSONAL));
    assert.equal(after.status, 'warn');
    assert.equal(after.evidence.shields, 1, 'the shield is seen, it is just in the wrong place');

    const before = CHK._verdict('Klantmailer', flowOf([step('datatable', { datatableId: 'tbl_1' }), step('guard'), step('integration_action', { tool: 'gmail_compose' })], PERSONAL));
    assert.equal(before.status, 'pass');
    assert.match(before.details, /a Privacy Shield step stands in front of every step that sends/);
});

test('the egress log turns a risk into a record, and that is a failure', () => {
    // A definition says what CAN happen. The ledger says what did. Nothing in
    // a reading of a definition is as strong as a row saying an e-mail address
    // left through this automation last Tuesday.
    const seen = dataFlow.observedEgress([{ tool_name: 'gmail_compose', pii_categories_detected: 'Email,Person', calls: 12 }]);
    const v = CHK._verdict('Klantmailer', flowOf(SENDS, PERSONAL, seen));
    assert.equal(v.status, 'fail');
    assert.match(v.details, /has sent personal data \(name, email\) to gmail/);
    assert.match(v.details, /This is the egress log, not a reading of the definition/);
    assert.deepEqual(v.evidence.observed_kinds, ['name', 'email']);
    assert.equal(v.evidence.observed_calls, 12);
});

test('a silent ledger never acquits a definition', () => {
    // An empty ledger means the automation has not run — or that the PII scan was
    // off. Reading it as "nothing personal has left" is how an automation that
    // fires once a quarter passes every sweep in between.
    const empty = CHK._verdict('Klantmailer', flowOf(SENDS, PERSONAL, dataFlow.observedEgress([])));
    assert.equal(empty.status, 'warn');
    // And a shielded automation that really sent something is not failed for it.
    const seen = dataFlow.observedEgress([{ tool_name: 'gmail_compose', pii_categories_detected: 'Email', calls: 3 }]);
    const guarded = flowOf([step('guard'), ...SENDS], PERSONAL, seen);
    assert.equal(CHK._verdict('Klantmailer', guarded).status, 'pass');
});

test('"we could not tell" is never a pass', () => {
    // THE BUG CLASS THIS WHOLE CHECK IS ARRANGED AGAINST. An automation that sends
    // data out of the workspace and whose source nothing here could read is
    // not a clean automation; it is an unanswered question, and a compliance
    // product that answers it with a green tick is worse than one that says
    // nothing.
    const blind = CHK._verdict('Onbekend', flowOf([step('integration_action', { tool: 'gmail_compose' })], null));
    assert.equal(blind.status, 'warn');
    assert.match(blind.details, /nothing this check can read says whether personal data is among it/);
    assert.match(blind.details, /That is a gap in what is known, not a clean bill/);
    assert.equal(blind.evidence.carries, null, 'null is not an empty list');

    // Steps that could not be read at all, for an automation that is switched on.
    const unreadable = CHK._verdict('Kapot', flowOf([], null));
    assert.equal(unreadable.status, 'warn');
    assert.match(unreadable.details, /its steps could not be read/);
});

test('the ledger can answer what the definition could not', () => {
    // The one honest way out of the warning above: the automation really has been
    // sending, the PII scan was on, and nothing personal was in any of it.
    // Observed, not guessed — the same rule personalColumns applies when the
    // values can be read and the names cannot.
    const seen = dataFlow.observedEgress([{ tool_name: 'gmail_compose', pii_categories_detected: null, calls: 40, scanned: true }]);
    const v = CHK._verdict('Statusmail', flowOf([step('integration_action', { tool: 'gmail_compose' })], null, seen));
    assert.equal(v.status, 'pass');
    assert.match(v.details, /40 call\(s\) to gmail .* and no personal data in any of them/);
});

test('the ledger acquits only the exits it saw, and only calls that were scanned', () => {
    // A tool that only READS (gmail_search) is not an exit, and an HTTP
    // request never reaches the ledger at all: forty clean searches say
    // nothing about where the HTTP step sent its data.
    const readsOnly = dataFlow.observedEgress([{ tool_name: 'gmail_search', pii_categories_detected: null, calls: 40, scanned: true }]);
    const http = CHK._verdict('Zoeker', flowOf([step('integration_action', { tool: 'gmail_search' }), step('http_request')], null, readsOnly));
    assert.equal(http.status, 'warn');
    assert.doesNotMatch(http.details, /no personal data in any of them/);

    // An empty category column written while the PII scan was off means
    // nobody looked — not "nothing personal".
    const unscanned = dataFlow.observedEgress([{ tool_name: 'gmail_compose', pii_categories_detected: null, calls: 40, scanned: false }]);
    assert.equal(unscanned.unscanned_calls, 40);
    const blind = CHK._verdict('Statusmail', flowOf([step('integration_action', { tool: 'gmail_compose' })], null, unscanned));
    assert.equal(blind.status, 'warn');
    assert.doesNotMatch(blind.details, /no personal data in any of them/);
});

test('the ledger query says whether each group was scanned', async () => {
    let sql = '';
    await CHK._egressFor('orgA', 'aut_1', { getAll: async (q) => { sql = q; return []; } });
    assert.match(sql, /COALESCE\(pii_scan_enabled, FALSE\) AS scanned/);
    assert.match(sql, /GROUP BY tool_name, pii_categories_detected, COALESCE\(pii_scan_enabled, FALSE\)/);
    // A single-tenant install writes its ledger rows with no organisation,
    // and the scheduler sweeps it as 'default'.
    await CHK._egressFor('default', 'aut_1', { getAll: async (q) => { sql = q; return []; } });
    assert.match(sql, /organization_id IS NULL/);
});

test('an automation that sends nothing, and one whose columns hold nothing personal', () => {
    const contained = CHK._verdict('Rijen bijwerken', flowOf([step('datatable', { datatableId: 'tbl_1' })], PERSONAL));
    assert.equal(contained.status, 'pass');
    assert.match(contained.details, /Nothing in "Rijen bijwerken" leaves the workspace/);

    const clean = CHK._verdict('Totalenmail', flowOf(SENDS, []));
    assert.equal(clean.status, 'pass');
    assert.match(clean.details, /none of the columns it reads holds personal data/);
    assert.deepEqual(clean.evidence.carries, [], 'and [] is not null: these columns were read');
});

test('a category from the ledger is never re-spelled on the way in', () => {
    // The worst bug this side of the product has had: a private snake_case
    // squash of the guard's category ids meant an automation mailing out telephone
    // numbers, IBANs or BSNs reported "no personal data". Every spelling any
    // producer has ever written goes through piiCategories.normalizeCategory.
    for (const [wire, kinds] of [
        ['PhoneNumber', ['phone']],
        ['InternationalBankingAccountNumber', ['financial']],
        ['NationalIdentificationNumber', ['id_number']],
        ['MedicalCondition', ['health']],
        ['Phone Number, EU National ID / BSN', ['phone', 'id_number']],
    ]) {
        const seen = dataFlow.observedEgress([{ tool_name: 'gmail_compose', pii_categories_detected: wire, calls: 1 }]);
        const v = CHK._verdict('Klantmailer', flowOf(SENDS, PERSONAL, seen));
        assert.equal(v.status, 'fail', wire);
        assert.deepEqual(v.evidence.observed_kinds, kinds, wire);
    }
});

test('a step is projected through an allow-list, so its configuration cannot reach the evidence', () => {
    // BFSF-441. A step object is the automation's own configuration — a recipient
    // address, a subject line, a bound body — and everything that gets past
    // stepsOf() ends up in a compliance evidence record, which is the one
    // artifact in this product designed to be handed to an outsider.
    const steps = CHK.stepsOf({
        definition_json: {
            steps: [{
                id: 's1', type: 'integration_action', tool: 'gmail_compose', datatableId: 'tbl_1',
                to: 'jan.jansen@example.com', subject: 'Factuur Jansen BV', body: 'Beste Jan, …',
                config: { bcc: 'archief@example.com' },
            }],
        },
    });
    assert.deepEqual(steps, [{ type: 'integration_action', tool: 'gmail_compose', datatableId: 'tbl_1' }]);
    const blob = JSON.stringify(CHK._verdict('X', flowOf(steps, PERSONAL)));
    for (const secret of ['jan.jansen@example.com', 'Factuur Jansen BV', 'Beste Jan', 'archief@example.com']) {
        assert.ok(!blob.includes(secret), `${secret} reached the evidence`);
    }
    // A definition that cannot be read is empty, never half-read.
    assert.deepEqual(CHK.stepsOf({ definition_json: 'not json' }), []);
    assert.deepEqual(CHK.stepsOf({ definition_json: { steps: null } }), []);
    assert.deepEqual(CHK.stepsOf(null), []);
    // …and a JSON string is parsed, because that is how the column comes back.
    assert.equal(CHK.stepsOf({ definition_json: JSON.stringify({ steps: [{ type: 'code' }] }) }).length, 1);
});

// ── the subjects, and the automations this check never opened ───────────────

const ROWS = [
    { id: 'aut_1', title: 'Klantmailer', definition_json: { steps: [{ type: 'integration_action', tool: 'gmail_compose', datatableId: 'tbl_1' }] } },
    { id: 'aut_2', title: 'Rijen bijwerken', definition_json: { steps: [{ type: 'datatable', datatableId: 'tbl_1' }] } },
    { id: 'aut_3', title: 'Kapotte import', definition_json: 'not json at all' },
    { id: 'aut_4', title: null, definition_json: { steps: [] } },
];
const depsFor = (rows = ROWS, over = {}) => ({
    getAll: async (sql) => {
        if (/FROM automations/.test(sql)) return rows;
        if (/FROM datatables/.test(sql)) return [{ id: 'tbl_1', name: 'Klanten', scope_kind: 'org', scope_id: 'orgA' }];
        if (/integration_activity_log/.test(sql)) return [];
        return [];
    },
    getTableMeta: async () => ({ fields: [{ key: 'email', name: 'E-mail', type: 'text' }, { key: 'total', name: 'Total', type: 'number' }] }),
    ...over,
});

test('it judges the live automations it can read, one row each', async () => {
    const deps = depsFor();
    const subjects = await CHK.listSubjects('orgA', deps);
    assert.deepEqual(subjects, [
        { id: 'automation:aut_1', label: 'Klantmailer' },
        { id: 'automation:aut_2', label: 'Rijen bijwerken' },
    ]);
    const mailer = await CHK.evaluate('orgA', { id: 'automation:aut_1' }, deps);
    assert.equal(mailer.status, 'warn', 'the table it reads has an e-mail column and nothing guards the send');
    assert.deepEqual(mailer.evidence.carries, ['email']);
    assert.deepEqual(mailer.evidence.destinations, ['gmail']);
    // The column that is not personal data stays out of it.
    assert.ok(!mailer.evidence.carries.includes('financial'));

    const gone = await CHK.evaluate('orgA', { id: 'automation:aut_ghost' }, deps);
    assert.equal(gone.status, 'not_applicable');
    assert.equal((await CHK.evaluate('orgA', null, deps)).status, 'not_applicable');
});

test('a table whose columns are named in snake_case is not thereby free of personal data', async () => {
    // `email_address` has no \b before "address" or after "email", so the
    // name detector read it as nothing and the automation passed with "none of
    // the columns it reads holds personal data".
    const deps = depsFor(ROWS, { getTableMeta: async () => ({ fields: [{ key: 'email_address', name: 'email_address', type: 'text' }] }) });
    const v = await CHK.evaluate('orgA', { id: 'automation:aut_1' }, deps);
    assert.equal(v.status, 'warn');
    assert.deepEqual(v.evidence.carries, ['email']);
});

test('an automation list that cannot be read is not "no longer switched on"', async () => {
    // not_applicable drops the automation out of the score, so a transient
    // read error between listSubjects and evaluate used to hide a failing
    // automation. Only the SQLSTATE travels, never the error message.
    const deps = depsFor(ROWS, { getAll: async () => { throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }); } });
    const v = await CHK.evaluate('orgA', { id: 'automation:aut_1' }, deps);
    assert.equal(v.status, 'warn');
    assert.equal(v.evidence.sqlstate, '57P01');
    assert.equal(v.evidence.automation_id, 'aut_1');
    assert.ok(!JSON.stringify(v).includes('terminating connection'), 'the raw error message stays out of the evidence');
});

test('an automation whose tables cannot be opened is not thereby clean', async () => {
    const deps = depsFor(ROWS, { getTableMeta: async () => { throw new Error('datatable store unavailable'); } });
    const v = await CHK.evaluate('orgA', { id: 'automation:aut_1' }, deps);
    assert.equal(v.status, 'warn');
    assert.equal(v.evidence.carries, null, 'nobody looked — not "nothing is there"');
});

test('"live" is one sentence, and the SQL still says it', async () => {
    let sql = '';
    await CHK._liveAutomations('orgA', { getAll: async (q) => { sql = q; return []; } });
    assert.match(sql, /a\.is_active = TRUE/);
    assert.match(sql, /COALESCE\(a\.is_draft, FALSE\) = FALSE/);
    assert.match(sql, /a\.kind = 'automation'/, 'a reusable Step is not an automation');
    // Rows created before organization_id was stamped resolve through the
    // owner — the filter aiAct/signals.js and the detectors already use. A
    // plain a.organization_id = $1 loses every automation older than that column,
    // and a check that loses automations scores the ones it happened to keep.
    assert.match(sql, /COALESCE\(a\.organization_id, u\."organizationId"\) = \$1/);
});

test('it reports the whole live population and names the ones it could not open', async () => {
    const cov = await CHK.listCoverage('orgA', depsFor());
    assert.equal(cov.kind, 'automation');
    assert.equal(cov.total, 4);
    assert.equal(cov.examined, 2);
    assert.deepEqual(cov.unexamined, [
        { id: 'aut_3', label: 'Kapotte import' },
        // An automation with no title is still named by something clickable.
        { id: 'aut_4', label: 'aut_4' },
    ]);
    assert.equal(cov.link, 'admin/compliance/ropa');
    assert.equal(cov.examined_as, 'read for where its data goes');
});

test('an automation list that cannot be read is never reported as "no automations"', async () => {
    // Swallowing a read failure in listCoverage would claim the workspace
    // runs no automations at all — "there is nothing we failed to look at" —
    // which is the exact false reassurance coverage exists to prevent. The
    // error goes up and the runner records the run as covering an unknown
    // share. listSubjects throws too: its list retires vanished slots, so an
    // empty list read off a failed query would retire every automation.
    const boom = { getAll: async () => { throw new Error('relation "automations" does not exist'); } };
    await assert.rejects(() => CHK.listCoverage('orgA', boom), /relation "automations" does not exist/);
    await assert.rejects(() => CHK.listSubjects('orgA', boom));
});

test('the subject list is the whole live population, so a switched-off automation is retired', async () => {
    // Without this the runner never marks the list complete, and the last
    // warning of an automation that was switched off stays in the score.
    const { _asListing } = require('../../runner');
    assert.equal(_asListing(CHK, await CHK.listSubjects('orgA', depsFor())).complete, true);
    assert.equal(typeof CHK.retiredDetails, 'string');
});

test('an organisation running nothing reports an empty population, not a gap', async () => {
    const cov = await CHK.listCoverage('orgA', depsFor([]));
    assert.equal(cov.total, 0);
    assert.equal(cov.examined, 0);
    assert.deepEqual(cov.unexamined, []);
});

test('the sentence an admin actually reads names the automations and where to go', async () => {
    // The two halves composed: this check supplies the population and the
    // words for its own domain, compliance/runner.js turns them into the row.
    const { _coverageVerdict } = require('../../runner');
    const row = _coverageVerdict(CHK, await CHK.listCoverage('orgA', depsFor()));
    assert.equal(row.status, 'warn');
    assert.match(row.details, /2 of this organisation's 4 live automations have never been read for where its data goes/);
    assert.match(row.details, /the score covers only the other 2/);
    assert.match(row.details, /"Kapotte import", "aut_4"/);

    // NOTHING readable while automations are running: the verdicts above are
    // about nothing at all, and that is the bug this contract was added for —
    // a workspace nobody had looked at used to score the checks that happened
    // to run, often 100.
    const none = _coverageVerdict(CHK, await CHK.listCoverage('orgA', depsFor(ROWS.map((r) => ({ ...r, definition_json: 'not json' })))));
    assert.equal(none.status, 'fail');
    assert.match(none.details, /this check examined nothing at all/);

    // And an organisation with nothing switched on is not accused of a gap.
    assert.equal(_coverageVerdict(CHK, await CHK.listCoverage('orgA', depsFor([]))).status, 'not_applicable');
});

test('the registry gets a check it will accept, with the coverage contract on it', () => {
    assert.equal(CHK.regulation, 'GDPR');
    assert.equal(CHK.article, '30(1)(d)');
    assert.equal(CHK.scope, 'per-source');
    assert.equal(typeof CHK.listSubjects, 'function');
    assert.equal(typeof CHK.evaluate, 'function');
    // Without this the score is again a score over only what it happened to
    // see — see the COVERAGE section at the top of compliance/runner.js.
    assert.equal(typeof CHK.listCoverage, 'function');
    assert.ok(['automated', 'attestation', 'hybrid'].includes(CHK.verification));
    assert.ok(!CHK.remediationLink.includes('?'), 'the admin router reads path segments only');
});

test('the analyser is shared with the playbook review, not copied beside it', () => {
    // playbooks/ and compliance/ are both features and neither may require the
    // other — that direction is already enforced, for every file in both
    // trees, by server/layering.test.js. What THAT guard cannot see is the
    // narrower property this test is actually about: that the two callers of
    // "where does personal data travel" point at the exact same analyser
    // module rather than each carrying their own copy that could drift.
    //
    // Node caches modules by resolved absolute path, so this is checked
    // through the real module graph — `require.cache[...].children` — instead
    // of matching a require string, which would pass just as happily on a
    // stale duplicate reached via a different relative path.
    const chkPath = require.resolve('./art30-1-d-personal-data-flows');
    const dataFlowPath = require.resolve('../../../core/privacy/dataFlow');
    const personalColumnsPath = require.resolve('../../../core/privacy/personalColumns');
    const chkChildren = require.cache[chkPath].children.map((c) => c.id);
    assert.ok(chkChildren.includes(dataFlowPath), 'the check no longer requires core/privacy/dataFlow');
    assert.ok(chkChildren.includes(personalColumnsPath), 'the check no longer requires core/privacy/personalColumns');

    // Loaded here, not at module scope, purely to inspect its require graph;
    // nothing on it is called.
    require('../../../playbooks/phases/compliancePhase');
    const phasePath = require.resolve('../../../playbooks/phases/compliancePhase');
    const phaseChildren = require.cache[phasePath].children.map((c) => c.id);
    assert.ok(phaseChildren.includes(dataFlowPath), 'the other caller no longer reads the same dataFlow module');
});
