/**
 * The closing review: facts first, rules second, the model last — and the
 * static half is the floor, so a model that cannot be reached never turns the
 * review into silence.
 *
 * Run: node --test --test-force-exit playbooks/phases/compliancePhase.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./compliancePhase');

const TABLE = {
    name: 'Invoices',
    fields: [{ key: 'supplier', name: 'Leverancier', type: 'text' }, { key: 'email', name: 'E-mail', type: 'text' }, { key: 'total', name: 'Total', type: 'number' }],
    rowCount: 32,
};
// THE SHAPE THE ROUTE ACTUALLY SENDS: {type, tool}, where `type` is a runtime
// step type and `tool` is set only on an integration_action. This fixture used
// to put TOOL names in `type` ('nextcloud_list_files'), which is a shape no
// automation can produce — and that is exactly why three bugs in gatherFacts
// survived: the tests agreed with the misunderstanding instead of with
// routes/playbooks/complianceReview.js.
const AUTO = {
    title: 'Read invoices',
    trigger: 'manual',
    steps: [
        { type: 'integration_action', tool: 'nextcloud_list_files' },
        { type: 'integration_action', tool: 'nextcloud_read_file' },
        { type: 'data_extraction', tool: null },
        { type: 'datatable', tool: null },
    ],
};
const facts = (over = {}) => C.gatherFacts({
    table: TABLE, automations: [AUTO],
    app: { name: 'Invoice Dashboard', published: true, sharedGroups: [], screenCount: 1, publicPages: 0 },
    access: { roles: [], memberCount: 0 },
    frameworks: ['GDPR', 'ISO27001'],
    ...over,
});

test('the facts are what a regulator would ask about, and personal columns are recognised by name', () => {
    const f = facts();
    assert.deepEqual(f.table.personal.map((p) => p.kind).sort(), ['email', 'supplier']);
    assert.deepEqual(f.automations[0].aiSteps, ['data_extraction']);
    assert.equal(f.automations[0].hasPrivacyStep, false);
    assert.equal(f.automations[0].readsFiles, true);
    assert.equal(f.app.audience, 'organisation');
    // A column that is not personal data stays out of it.
    assert.ok(!f.table.personal.some((p) => p.key === 'total'));
    assert.deepEqual(C.personalColumns([{ key: 'total', name: 'Total' }]), []);
});

test('the rule findings speak the demo language, not just the AI ones', () => {
    // The half of the verdict with a FACT behind it used to be English always,
    // beside AI findings the model wrote in Dutch.
    const f = facts();
    const nl = C.staticFindings(f, 'nl').find((x) => x.code === 'personal_data_org_wide');
    assert.match(nl.title, /Persoonsgegevens staan open voor de hele organisatie/);
    assert.match(nl.subject, /^App "Invoice Dashboard"$/);
    assert.match(nl.why, /de waarden erin zijn gescand|hun namen lezen als persoonsgegevens/);
    assert.match(nl.fix, /groepen|rol/i);
    const en = C.staticFindings(f, 'en').find((x) => x.code === 'personal_data_org_wide');
    assert.match(en.title, /Personal data is open to the whole organisation/);
    // Same finding, same code, same target — only the words change.
    assert.equal(nl.code, en.code);
    assert.deepEqual(nl.target, en.target);
});

test('what the facts alone already say — each finding names its subject and what to do', () => {
    const found = C.staticFindings(facts());
    const byCode = Object.fromEntries(found.map((f) => [f.code, f]));
    assert.ok(byCode.personal_data_org_wide, 'personal data + open to the whole organisation');
    assert.equal(byCode.personal_data_org_wide.severity, 'high');
    assert.match(byCode.personal_data_org_wide.subject, /Invoice Dashboard/);
    assert.match(byCode.personal_data_org_wide.fix, /groups|role/i);
    assert.ok(found.some((f) => f.code.startsWith('ai_no_guard')), 'a model reads the files with no Privacy Shield in front');
    assert.ok(byCode.ropa_retention, 'personal data with no retention recorded');
    assert.ok(byCode.iso_access_roles, 'ISO: shared, but nobody holds a role');
    for (const f of found) assert.ok(f.title && f.why && f.fix && f.framework, `${f.code} is incomplete`);
});

test('a framework that is OFF is never spoken about, and a clean build finds nothing', () => {
    // ISO off → no ISO finding; GDPR off → no GDPR finding at all.
    const isoOff = C.staticFindings(facts({ frameworks: ['GDPR'] }));
    assert.ok(!isoOff.some((f) => f.framework === 'ISO27001'));
    const none = C.staticFindings(facts({ frameworks: [] }));
    assert.deepEqual(none, []);
    // No personal data, a private app, a privacy step in the automation.
    const clean = C.staticFindings(C.gatherFacts({
        table: { name: 'Totals', fields: [{ key: 'total', name: 'Total', type: 'number' }] },
        automations: [{ title: 'Sum', trigger: 'manual', steps: [{ type: 'guard' }, { type: 'datatable' }] }],
        app: { name: 'Totals', published: false, sharedGroups: [] },
        access: { roles: [], memberCount: 1 },
        frameworks: ['GDPR', 'ISO27001'],
    }));
    assert.deepEqual(clean, []);
});

test('an automation that sends data outward is reported; one that does not is not', () => {
    // A REAL outbound step. The fixture used to be `{type:'send_email'}` — a
    // step type that does not exist anywhere in the product, invented to
    // exercise a set that listed it. That is what a test pinning a bug looks
    // like: it had to fabricate an impossible input to go green.
    const sends = [...AUTO.steps, { type: 'integration_action', tool: 'gmail_compose' }];
    const outbound = C.staticFindings(facts({ automations: [{ ...AUTO, steps: sends }] }));
    const hit = outbound.find((f) => f.code.startsWith('outbound_'));
    assert.ok(hit);
    assert.equal(hit.severity, 'medium');
    assert.match(hit.why, /integration_action/);
    assert.ok(!C.staticFindings(facts()).some((f) => f.code.startsWith('outbound_')));
});

test('an app action that only READS is not reported as sending data out', () => {
    // The whole reason the answer is asked per STEP rather than per TYPE:
    // gmail_search and gmail_compose are both integration_action, and only one
    // of them leaves the building. A review that flags every connected-app
    // step is a review people learn to skip.
    const reads = [...AUTO.steps, { type: 'integration_action', tool: 'gmail_search' }];
    const f = C.staticFindings(facts({ automations: [{ ...AUTO, steps: reads }] }));
    assert.ok(!f.some((x) => x.code.startsWith('outbound_')));
});

test('a code step counts as outbound — its sandbox is handed an HTTPS fetch', () => {
    const withCode = [...AUTO.steps, { type: 'code', tool: null }];
    const f = C.staticFindings(facts({ automations: [{ ...AUTO, steps: withCode }] }));
    assert.ok(f.some((x) => x.code.startsWith('outbound_')));
});

test('reading files is detected from the TOOL, which is where those words live', () => {
    // This was matching /nextcloud|file|drive/ against step TYPES, and no real
    // step type contains any of them — so it was false for every automation ever
    // reviewed.
    assert.strictEqual(C.gatherFacts({ automations: [AUTO] }).automations[0].readsFiles, true);
    const noFiles = { ...AUTO, steps: [{ type: 'ai_step', tool: null }] };
    assert.strictEqual(C.gatherFacts({ automations: [noFiles] }).automations[0].readsFiles, false);
});

test('the model may only speak about active frameworks, and half a finding is no finding', () => {
    const raw = {
        findings: [
            { severity: 'high', framework: 'GDPR', article: 'Art. 32', subject: 'Table "Invoices"', title: 'A', why: 'B', fix: 'C' },
            { severity: 'high', framework: 'NIS2', title: 'Not active here', why: 'x', fix: 'y' },
            { severity: 'low', framework: 'GDPR', title: 'No fix given', why: 'x' },
            { severity: 'nonsense', framework: 'gdpr', title: 'D', why: 'E', fix: 'F' },
        ],
    };
    const out = C.normaliseFindings(raw, { frameworks: ['GDPR'] });
    assert.deepEqual(out.map((f) => f.title), ['A', 'D']);
    assert.equal(out[1].severity, 'low', 'an unknown severity is the quiet one');
    assert.equal(out[1].framework, 'GDPR');
    assert.ok(out.every((f) => f.source === 'ai'));
});

test('runCompliancePhase: static findings survive a model that cannot be reached', async () => {
    const deps = { resolveModel: async () => { throw new Error('no model here'); }, chatForcedTool: async () => ({ structured: null }) };
    const out = await C.runCompliancePhase({ facts: facts(), locale: 'en', frameworkNames: ['GDPR'] }, deps);
    assert.equal(out.ok, true);
    assert.ok(out.artifacts.findings.length > 0, 'the rules still ran');
    assert.equal(out.artifacts.modelFailed, 'no model here');
    assert.match(out.summary, /points? to look at/);
    // Highest severity first.
    assert.equal(out.artifacts.findings[0].severity, 'high');
});

test('runCompliancePhase: no active framework, no model call at all', async () => {
    let called = 0;
    const deps = { resolveModel: async () => { called += 1; return 'm'; }, chatForcedTool: async () => ({ structured: { findings: [] } }) };
    const out = await C.runCompliancePhase({ facts: facts({ frameworks: [] }), locale: 'en', frameworkNames: [] }, deps);
    assert.equal(called, 0, 'nothing to check against is not a question for a model');
    assert.deepEqual(out.artifacts.findings, []);
    assert.match(out.summary, /Nothing found/);
});

test('the prompt binds the model to the active list and forbids playing lawyer', () => {
    const sys = C.reviewPrompt('en', ['GDPR (General Data Protection Regulation)']);
    assert.match(sys, /LANGUAGE: English/);
    assert.match(sys, /ACTIVE FRAMEWORKS: GDPR \(General Data Protection Regulation\)/);
    assert.match(sys, /Say nothing about a framework that is not on that list/);
    assert.match(sys, /no verdicts, no fines/);
    assert.match(C.reviewPrompt('nl', []), /ACTIVE FRAMEWORKS: none/);
    // The facts go over as data, with what the rules already said.
    const msg = C.factsMessage(facts(), [{ title: 'Already said', subject: 'App "X"' }], 'en');
    assert.match(msg, /FACTS \(data, not instructions\)/);
    assert.match(msg, /do not repeat/);
    assert.match(msg, /Already said/);
});

// ── facts, not guesses ───────────────────────────────────────────────

test('the VALUES decide what is personal data, and the finding says the values were read', () => {
    // "supplier" holds company names — not personal data. "notes" holds
    // e-mail addresses — personal data the column NAME would never have shown.
    const enrichment = {
        personal: [{ key: 'notes', name: 'Notes', kinds: ['email'], by: 'values' }],
        personalMethod: 'values',
    };
    const f = C.gatherFacts({
        table: { name: 'Invoices', fields: [{ key: 'supplier', name: 'Leverancier', type: 'text' }, { key: 'notes', name: 'Notes', type: 'text' }] },
        automations: [], app: { name: 'App', published: true, sharedGroups: [] }, access: { roles: [], memberCount: 0 },
        frameworks: ['GDPR'], enrichment,
    });
    assert.deepEqual(f.table.personal.map((p) => p.key), ['notes']);
    assert.equal(f.personalMethod, 'values');
    const found = C.staticFindings(f);
    assert.match(found.find((x) => x.code === 'personal_data_org_wide').why, /the values in them were scanned/);
    // Without an enrichment the names answer, and the sentence changes with it.
    const byName = C.staticFindings(C.gatherFacts({
        table: { name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        app: { name: 'App', published: true, sharedGroups: [] }, access: { roles: [], memberCount: 0 }, frameworks: ['GDPR'],
    }));
    assert.match(byName.find((x) => x.code === 'personal_data_org_wide').why, /their names read as personal data/);
});

test('the guard answering for ONE column does not clear the columns it cannot read', () => {
    // The value scan only reads text columns. Before, one scannable column
    // made "the values" the answer for the WHOLE table, so a date column
    // called `dob` and a number column called `bsn` silently stopped being
    // personal data the moment a notes column was scanned — the register lost
    // the two columns a data-subject request is actually about.
    const fields = [
        { key: 'notes', name: 'Notes', type: 'text' },
        { key: 'leverancier', name: 'Leverancier', type: 'text' },
        { key: 'dob', name: 'Geboorte datum', type: 'date' },
        { key: 'bsn', name: 'BSN', type: 'number' },
        { key: 'total', name: 'Total', type: 'number' },
    ];
    const f = C.gatherFacts({
        table: { name: 'Invoices', fields },
        automations: [], app: { name: 'App', published: true, sharedGroups: [] }, access: { roles: [], memberCount: 0 },
        frameworks: ['GDPR'],
        enrichment: {
            personal: [{ key: 'notes', name: 'Notes', kinds: ['email'], by: 'values', sampled: 20, matched: 18, byKind: { email: 18 }, rate: 0.9, confidence: 'likely' }],
            // The guard read both text columns: one held addresses, the other
            // held company names.
            scannedColumns: ['notes', 'leverancier'],
            personalMethod: 'values',
        },
    });
    assert.deepEqual(f.table.personal.map((p) => p.key), ['notes', 'dob', 'bsn']);
    assert.deepEqual(f.table.personal.map((p) => p.by), ['values', 'names', 'names']);
    // The VALUES still win where they were read: a column called "Leverancier"
    // holding company names is not personal data, however much its name looks
    // like it. That distinction is the whole reason for scanning values.
    assert.ok(!f.table.personal.some((p) => p.key === 'leverancier'));
    // And a column with neither a name nor a value behind it stays out.
    assert.ok(!f.table.personal.some((p) => p.key === 'total'));
    // The table-level method is unchanged, so the finding still says the
    // values were read (playbooks/copy.js seenValues).
    assert.equal(f.personalMethod, 'values');
    // What was actually looked at travels with the column, which is what a
    // reviewer needs to weigh it: 18 of 20 cells is a mailing list, and a
    // column nothing read says so instead of claiming a count.
    const notes = f.table.personal.find((p) => p.key === 'notes');
    assert.equal(notes.matched, 18);
    assert.equal(notes.sampled, 20);
    assert.equal(notes.rate, 0.9);
    assert.equal(f.table.personal.find((p) => p.key === 'dob').confidence, 'name_only');
    assert.equal(f.table.personal.find((p) => p.key === 'dob').matched, null, 'nobody counted, so no count is claimed');
});

test('an enrichment that does not say what it read gets the old answer, never a guessed one', () => {
    // Older stored enrichments (and the route when the guard half failed)
    // carry the hits and nothing else. Assuming "everything not on the list
    // was unreadable" would resurrect exactly the columns the value scan was
    // built to clear — the supplier column, again.
    const f = C.gatherFacts({
        table: { name: 'Invoices', fields: [{ key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'notes', name: 'Notes', type: 'text' }] },
        automations: [], app: { name: 'App', published: true, sharedGroups: [] }, access: { roles: [], memberCount: 0 },
        frameworks: ['GDPR'],
        enrichment: { personal: [{ key: 'notes', name: 'Notes', kinds: ['email'], by: 'values' }], personalMethod: 'values' },
    });
    assert.deepEqual(f.table.personal.map((p) => p.key), ['notes']);
    // …and the shape is filled in whatever the enrichment left out, so every
    // consumer reads the same fields.
    assert.equal(f.table.personal[0].kind, 'email');
    assert.equal(f.table.personal[0].matched, null);
});

test('a table that RECORDS its legal basis and retention is not told to record them', () => {
    const base = {
        table: { name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        automations: [], app: { name: 'App', published: false, sharedGroups: [] }, access: { roles: [], memberCount: 1 },
        frameworks: ['GDPR'],
    };
    const without = C.staticFindings(C.gatherFacts(base));
    assert.ok(without.some((x) => x.code === 'ropa_retention'));
    const withBoth = C.staticFindings(C.gatherFacts({
        ...base,
        enrichment: { privacy: { lawfulBasis: 'contract', retentionDays: 365, retentionField: 'email' } },
    }));
    assert.equal(withBoth.some((x) => x.code === 'ropa_retention'), false, 'it looked, instead of asserting');
    // Half recorded is still a finding, and it names the half that is missing.
    const half = C.staticFindings(C.gatherFacts({ ...base, enrichment: { privacy: { lawfulBasis: null, retentionDays: 365, retentionField: 'email' } } }));
    // "no a legal basis" — the title supplies the "no", so the parts no longer carry an article.
    assert.match(half.find((x) => x.code === 'ropa_retention').title, /no legal basis on record/);
    // A retention period with no field to count from is a number the clean-up
    // job can never act on — so it does not count as recorded either.
    const noField = C.staticFindings(C.gatherFacts({ ...base, enrichment: { privacy: { lawfulBasis: 'contract', retentionDays: 365, retentionField: null } } }));
    assert.match(noField.find((x) => x.code === 'ropa_retention').title, /date to count the retention from/);
});

test('a row rule is what "shared with everyone" may mean — and then it is not a finding', () => {
    const base = {
        table: { name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        automations: [], access: { roles: [], memberCount: 1 }, frameworks: ['GDPR'],
    };
    const open = C.staticFindings(C.gatherFacts({ ...base, app: { name: 'App', published: true, sharedGroups: [] } }));
    assert.ok(open.some((x) => x.code === 'personal_data_org_wide'));
    const scoped = C.staticFindings(C.gatherFacts({
        ...base,
        app: { name: 'App', published: true, sharedGroups: [], scopedRoles: ['supplier_acme'] },
    }));
    assert.equal(scoped.some((x) => x.code === 'personal_data_org_wide'), false,
        'everyone can open it, and each of them sees only their own rows');
});

test('the AI Act comes from the product’s own detector — and stays quiet when the signals are quiet', () => {
    const table = { name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] };
    const quiet = { title: 'Read invoices', signals: { contains_ai: true, generates_content: false, customer_facing: false, disclosure_present: false, annex_iii_hint: false } };
    const loud = { title: 'Reply to customers', signals: { contains_ai: true, generates_content: true, customer_facing: true, disclosure_present: false, annex_iii_hint: true, annex_iii_categories: ['employment'] } };
    const facts = (aiAct, autos) => C.gatherFacts({
        table, automations: autos, app: { name: 'App', published: false, sharedGroups: [] },
        access: { roles: [], memberCount: 1 }, frameworks: ['GDPR', 'AIA'], enrichment: { aiAct },
    });
    const a = { title: 'Read invoices', trigger: 'manual', steps: [{ type: 'data_extraction' }] };
    const quietFound = C.staticFindings(facts([quiet], [a]));
    assert.equal(quietFound.some((x) => x.framework === 'AIA'), false,
        'an extraction step that faces nobody is not an AI Act transparency case');
    // …and the old hand-rolled "AIA Art. 10" claim is gone for good.
    assert.equal(quietFound.some((x) => x.article === 'Art. 10'), false);
    assert.equal(quietFound.find((x) => x.code.startsWith('ai_no_guard')).article, 'Art. 25, 32');

    const b = { title: 'Reply to customers', trigger: 'manual', steps: [{ type: 'ai_step' }] };
    const loudFound = C.staticFindings(facts([loud], [b]));
    assert.equal(loudFound.find((x) => x.code.startsWith('aia_disclosure')).article, 'Art. 50(1)');
    assert.equal(loudFound.find((x) => x.code.startsWith('aia_annex_iii')).severity, 'medium');

    // Annex III is a POINTER to the questionnaire, not a verdict. The wording
    // used to decide a legal qualification by keyword match: "This may be a
    // high-risk use of AI". It is now the ten questions that decide, and the
    // finding says which point of the annex the wording touches so the reader
    // can look it up. A finding that carries `annex_iii_questions` cites the
    // point; one from an older caller cites the annex as a whole.
    const annexF = loudFound.find((x) => x.code.startsWith('aia_annex_iii'));
    assert.equal(annexF.article, 'Annex III', 'no per-domain articles on the signals → no invented point');
    assert.ok(!/high[- ]risk/i.test(annexF.title), `a keyword match may not qualify anything: ${annexF.title}`);
    assert.match(annexF.fix, /Annex III/);

    const cited = C.staticFindings(facts([{
        title: 'Reply to customers',
        signals: {
            ...loud.signals,
            annex_iii_categories: ['employment', 'credit'],
            annex_iii_questions: [
                { id: 'employment', hint: true, article: 'Annex III(4)' },
                { id: 'credit', hint: true, article: 'Annex III(5)(b)' },
                { id: 'biometrics', hint: false, article: 'Annex III(1)' },
            ],
        },
    }], [b]));
    assert.equal(cited.find((x) => x.code.startsWith('aia_annex_iii')).article, 'Annex III(4), Annex III(5)(b)',
        'the points the wording touched, and only those');

    // With the AI Act switched OFF, neither is spoken about.
    const off = C.staticFindings(C.gatherFacts({
        table, automations: [b], app: { name: 'App', published: false, sharedGroups: [] },
        access: { roles: [], memberCount: 1 }, frameworks: ['GDPR'], enrichment: { aiAct: [loud] },
    }));
    assert.equal(off.some((x) => x.framework === 'AIA'), false);
});

test('every finding carries where to go and fix it', () => {
    const found = C.staticFindings(C.gatherFacts({
        table: { name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }], isMirror: true },
        automations: [{ title: 'A', trigger: 'manual', steps: [{ type: 'data_extraction' }, { type: 'send_email' }] }],
        app: { name: 'App', published: true, sharedGroups: [], publicPages: 1 },
        access: { roles: [], memberCount: 0 }, frameworks: ['GDPR', 'ISO27001'],
    }));
    assert.ok(found.length >= 5);
    for (const f of found) assert.ok(['app', 'automation', 'register', 'table'].includes(f.link), `${f.code} has no link`);
});

test('the model repeating a rule finding is dropped — the one with the fact behind it stays', async () => {
    // Measured on the demo build: the rules said "access is shared but nobody
    // holds a role" and the model added "Unrestricted default access role" —
    // the same sentence twice, under two different articles.
    const statics = [{ code: 'iso_access_roles', subject: 'App "Invoices"', title: 'Access is shared but no role is assigned to anyone', why: 'The app is open to others while everyone falls back to the default role.' }];
    const model = [
        { code: 'ai_0', subject: 'App "Invoices"', title: 'Unrestricted default access role', why: 'The access facts show the default role is used for everyone, with no specific roles assigned.' },
        { code: 'ai_1', subject: 'Table "Invoices"', title: 'Something else entirely', why: 'A different observation about other matters.' },
    ];
    assert.deepEqual(C.dedupe(statics, model).map((f) => f.code), ['ai_1']);
    // A different SUBJECT is never a duplicate, however similar the words.
    assert.equal(C.dedupe(statics, [{ ...model[0], subject: 'App "Other"' }]).length, 1);
});

test('a reviewer that hangs costs the review nothing — the rules are the floor, on a clock', async () => {
    const t0 = Date.now();
    const deps = {
        resolveModel: async () => 'fast',
        chatForcedTool: () => new Promise(() => { /* never settles — the demo case */ }),
    };
    const out = await C.runCompliancePhase({
        facts: facts(), locale: 'en', frameworkNames: ['GDPR'], budgetMs: 200,
    }, deps);
    assert.equal(out.ok, true);
    assert.match(out.artifacts.modelFailed, /longer than/);
    assert.ok(out.artifacts.findings.length > 0, 'the rules still answered');
    assert.ok(Date.now() - t0 < 2000, 'and it gave up on its own');
});

test('every finding carries the thing it is about, as something you can click and write to', () => {
    const facts = C.gatherFacts({
        table: { id: 'tbl_1', scope: { kind: 'org', id: 'org1' }, name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        automations: [{ id: 'aut_1', title: 'Read invoices', steps: [{ type: 'data_extraction' }] }],
        app: { id: 'app_1', name: 'Invoice app', published: true, sharedGroups: [] },
        access: { roles: [], memberCount: 0 },
        frameworks: ['GDPR', 'ISO27001'],
    });
    const found = C.staticFindings(facts);
    for (const f of found) {
        assert.ok(f.target, `${f.code} has no target`);
        assert.ok(f.target.id, `${f.code} has a target with no id`);
        assert.ok(['table', 'automation', 'app'].includes(f.target.kind));
    }
    assert.equal(found.find((f) => f.code === 'personal_data_org_wide').target.id, 'app_1');
    assert.equal(found.find((f) => f.code === 'ropa_retention').target.id, 'tbl_1');
    assert.deepEqual(found.find((f) => f.code === 'ropa_retention').target.scope, { kind: 'org', id: 'org1' });
    assert.equal(found.find((f) => f.code === 'ai_no_guard_aut_1').target.id, 'aut_1');
    // The code keys off the ID, so two automations with one name are two findings.
    const twins = C.staticFindings(C.gatherFacts({
        table: { id: 'tbl_1', name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        automations: [
            { id: 'aut_1', title: 'Untitled automation', steps: [{ type: 'data_extraction' }] },
            { id: 'aut_2', title: 'Untitled automation', steps: [{ type: 'data_extraction' }] },
        ],
        frameworks: ['GDPR'],
    })).filter((f) => f.code.startsWith('ai_no_guard_'));
    assert.deepEqual(twins.map((f) => f.code), ['ai_no_guard_aut_1', 'ai_no_guard_aut_2']);
    assert.deepEqual(twins.map((f) => f.target.id), ['aut_1', 'aut_2']);
});

test('a finding the model wrote is matched back to the real thing by name — or carries none', () => {
    const facts = C.gatherFacts({
        table: { id: 'tbl_1', name: 'Invoice Intelligence', fields: [] },
        automations: [{ id: 'aut_1', title: 'Read invoices', steps: [] }],
        app: { id: 'app_1', name: 'Invoice app', published: false },
        frameworks: ['GDPR'],
    });
    const out = C.normaliseFindings({
        findings: [
            { severity: 'high', framework: 'GDPR', subject: 'Table "Invoice Intelligence"', title: 'A', why: 'B', fix: 'C' },
            { severity: 'low', framework: 'GDPR', subject: 'Read invoices', title: 'D', why: 'E', fix: 'F' },
            { severity: 'low', framework: 'GDPR', subject: 'the payroll system', title: 'G', why: 'H', fix: 'I' },
        ],
    }, { frameworks: ['GDPR'], facts });
    assert.deepEqual(out[0].target, { kind: 'table', id: 'tbl_1', name: 'Invoice Intelligence' });
    assert.equal(out[0].link, 'table');
    assert.deepEqual(out[1].target, { kind: 'automation', id: 'aut_1', name: 'Read invoices' });
    assert.equal(out[2].target, undefined, 'a subject that is not one of ours is never given a target');
    assert.equal(out[2].link, undefined);
    // The longer name wins, so "Invoices" cannot steal "Invoices archive".
    const both = [{ kind: 'table', id: 't1', name: 'Invoices' }, { kind: 'table', id: 't2', name: 'Invoices archive' }];
    assert.equal(C.matchTarget('Table "Invoices archive" holds it', both).id, 't2');
});

test('the verdict counts the rules that could be asked, not the ones that fired', () => {
    // No frameworks: nothing was checked, so nothing may be claimed as clean.
    assert.deepEqual(C.checkCoverage(C.gatherFacts({ table: { id: 't', name: 'T', fields: [] }, frameworks: [] })), { ran: 0, flagged: 0, clean: 0 });
    const facts = C.gatherFacts({
        table: { id: 'tbl_1', name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        automations: [{ id: 'aut_1', title: 'A', steps: [{ type: 'data_extraction' }] }, { id: 'aut_2', title: 'B', steps: [{ type: 'http_request' }] }],
        app: { id: 'app_1', name: 'App', published: true, sharedGroups: [] },
        access: { roles: [], memberCount: 0 },
        frameworks: ['GDPR', 'ISO27001'],
    });
    const cover = C.checkCoverage(facts);
    // 2 app rules + 2 automation rules × 2 automations + mirror + ropa + iso.
    assert.equal(cover.ran, 9);
    assert.equal(cover.flagged, C.staticFindings(facts).length);
    assert.equal(cover.clean, cover.ran - cover.flagged);
    assert.ok(cover.clean > 0, 'the card has something green to say');
    // The AI Act rules are only asked where the detector actually answered.
    assert.equal(C.checkCoverage(C.gatherFacts({ ...{ table: null, automations: [{ id: 'a', title: 'A', steps: [] }], app: null, access: null }, frameworks: ['AIA'] })).ran, 0);
    // Every counted rule is a rule staticFindings can really produce.
    const codes = new Set(C.CHECKS.map((c) => c.code));
    for (const f of C.staticFindings(facts)) {
        assert.ok([...codes].some((c) => f.code === c || f.code.startsWith(`${c}_`)), `${f.code} is counted by no rule`);
    }
});

test('a finding the MODEL wrote reaches the same fix as the rule that says the same thing', () => {
    // "Missing lawful basis for processing" arrived as `ai_0` and got "this
    // one needs you", while the rule saying the same thing had a working
    // Resolve right under it (owner, 2026-09-17).
    const facts = C.gatherFacts({
        table: { id: 'tbl_1', name: 'HR Resume Manager', fields: [{ key: 'candidate_name', name: 'Candidate Name', type: 'text' }] },
        automations: [{ id: 'aut_1', title: 'Read resumes', steps: [{ type: 'data_extraction' }] }],
        app: { id: 'app_1', name: 'HR app', published: true, sharedGroups: [] },
        frameworks: ['GDPR'],
    });
    const out = C.normaliseFindings({
        findings: [
            { severity: 'high', framework: 'GDPR', article: 'Art. 13', subject: 'HR Resume Manager', title: 'Missing lawful basis for processing', why: "The table has lawfulBasis set to null.", fix: 'Assign a lawful basis to the table.' },
            { severity: 'medium', framework: 'GDPR', subject: 'HR Resume Manager', title: 'Missing data retention period', why: 'retentionDays is 0.', fix: 'Set a retention period.' },
            { severity: 'medium', framework: 'GDPR', subject: 'Read resumes', title: 'No privacy check', why: 'A model reads it.', fix: 'Add a Privacy Shield step before the AI step.' },
            { severity: 'high', framework: 'GDPR', subject: 'HR app', title: 'Open to everyone', why: 'The whole organisation can open it.', fix: 'Share it with the groups that need it.' },
        ],
    }, { frameworks: ['GDPR'], facts });
    assert.deepEqual(out.map((f) => f.fix_kind), ['registration', 'registration', 'privacy_step', 'audience']);

    // Narrow on purpose: a finding that asks for something we cannot do, or
    // that resolved to nothing, still says "this one needs you".
    const vague = C.normaliseFindings({
        findings: [
            { severity: 'low', framework: 'GDPR', subject: 'HR Resume Manager', title: 'Consider a DPIA', why: 'It may be high risk.', fix: 'Talk to your DPO about a DPIA.' },
            { severity: 'low', framework: 'GDPR', subject: 'the payroll system', title: 'Missing lawful basis', why: 'x', fix: 'Add a lawful basis.' },
        ],
    }, { frameworks: ['GDPR'], facts });
    assert.deepEqual(vague.map((f) => f.fix_kind), [undefined, undefined]);
});

test('every rule finding that can be fixed carries the fix it maps to', () => {
    const facts = C.gatherFacts({
        table: { id: 'tbl_1', name: 'Invoices', fields: [{ key: 'email', name: 'E-mail', type: 'text' }], isMirror: true },
        // Same correction as the fixture above: a real outbound step, not
        // the phantom 'send_email' type.
        automations: [{ id: 'aut_1', title: 'A', steps: [{ type: 'data_extraction' }, { type: 'integration_action', tool: 'gmail_compose' }] }],
        app: { id: 'app_1', name: 'App', published: true, sharedGroups: [] },
        access: { roles: [], memberCount: 0 },
        frameworks: ['GDPR', 'ISO27001'],
    });
    const byCode = Object.fromEntries(C.staticFindings(facts).map((f) => [f.code, C.fixFor(f)]));
    assert.equal(byCode.ropa_retention, 'registration');
    assert.equal(byCode.mirror_personal, 'registration');
    assert.equal(byCode.ai_no_guard_aut_1, 'privacy_step');
    assert.equal(byCode.personal_data_org_wide, 'audience');
    assert.equal(byCode.iso_access_roles, 'named_role');
    // The two that genuinely need a person keep saying so.
    assert.equal(byCode.outbound_aut_1, null);
});

/**
 * THE GUARD THAT WOULD HAVE CAUGHT ALL OF THIS.
 *
 * gatherFacts carried three bugs at once — an OUTBOUND set naming a step type
 * that does not exist and missing the two biggest real ones, and a readsFiles
 * flag matching tool-shaped words against step types so it was false for every
 * automation ever reviewed. None of them was visible, because the fixtures in
 * this file were shaped like the misunderstanding rather than like the caller:
 * they put TOOL names in `type`, which no automation can produce.
 *
 * A fixture that disagrees with production is not a test, it is a second
 * implementation nobody runs. This reads the ONE caller and pins the shape it
 * really sends, so the next person to change either side is told.
 */
test('the fixtures here are the shape routes/playbooks/complianceReview.js really sends', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const routeSrc = fs.readFileSync(
        path.resolve(__dirname, '../../routes/playbooks/complianceReview.js'), 'utf8',
    );
    // The projection must carry BOTH identifiers. `type` alone is not enough to
    // answer "does this step send data out" for an integration_action, which is
    // the single largest outbound surface the product has.
    // Spans the whole expression, not to the first newline: the projection is
    // written across several lines and a line-bounded match silently read
    // only its first one.
    const projection = routeSrc.match(/steps:\s*\(a\.definition[\s\S]*?:\s*\[\],/);
    assert.ok(projection, 'the steps projection moved — re-point this guard before trusting it');
    assert.match(projection[0], /type:\s*st\s*&&\s*st\.type/, 'the route stopped sending `type`');
    assert.match(projection[0], /tool:/, 'the route stopped sending `tool` — readsFiles and the outbound check both go blind, silently');

    // And the fixture obeys it: every step is {type, tool}, with tool only ever
    // set on an integration_action.
    for (const st of AUTO.steps) {
        assert.ok('type' in st && 'tool' in st, `fixture step ${JSON.stringify(st)} does not match the route's projection`);
        if (st.tool) assert.strictEqual(st.type, 'integration_action', 'only an integration_action carries a tool');
    }
});

/**
 * WHERE THE DATA GOES — the shared flow analyser (core/privacy/dataFlow.js),
 * which this phase and the after-the-fact GDPR checks now both read.
 *
 * The three lists this file used to own ("which step types leave the
 * building", "which are a model", "which are the Privacy Shield") had to exist
 * a second time for the checks that ask the same thing of what is already
 * running, so they moved to core rather than being copied — the same move, for
 * the same reason, as personalColumns.js.
 */
test('an automation\'s facts say where the data goes, not only that it goes', () => {
    // `integration_action` is Gmail, Nextcloud Talk and LinkedIn at once, and
    // the review's copy has always called its argument `dests` while being
    // handed step types. Art. 30(1)(d) asks for the categories of RECIPIENTS.
    const f = facts({ automations: [{ ...AUTO, id: 'aut_1', steps: [...AUTO.steps, { type: 'integration_action', tool: 'gmail_compose' }] }] });
    assert.deepEqual(f.automations[0].flow.destinations, ['gmail']);
    const why = C.staticFindings(f).find((x) => x.code === 'outbound_aut_1').why;
    assert.match(why, /gmail/, 'the recipient is named');
    // Beside the type, not instead of it: the type is what the person sees on
    // the canvas and has to find.
    assert.match(why, /integration_action/);
});

test('the flow knows a Privacy Shield is a POSITION, not a property of the automation', () => {
    // A shield dropped at the END of an automation protects nothing that already
    // ran, and `hasPrivacyStep` — a boolean about the whole automation — cannot
    // tell that from a shield in the right place. Both facts now travel: the
    // boolean the finding's fixed copy is written against, and the count the
    // after-the-fact check states in its own words.
    const late = facts({ automations: [{ ...AUTO, id: 'aut_1', steps: [{ type: 'ai_step', tool: null }, { type: 'integration_action', tool: 'gmail_compose' }, { type: 'guard', tool: null }] }] });
    assert.equal(late.automations[0].hasPrivacyStep, true, 'there is a shield');
    assert.equal(late.automations[0].flow.models_unshielded, 1, 'and the model ran before it');
    assert.equal(late.automations[0].flow.exits_unshielded, 1);
    assert.equal(late.automations[0].flow.verdict, 'unguarded');

    const early = facts({ automations: [{ ...AUTO, id: 'aut_1', steps: [{ type: 'guard', tool: null }, { type: 'ai_step', tool: null }, { type: 'integration_action', tool: 'gmail_compose' }] }] });
    assert.equal(early.automations[0].flow.models_unshielded, 0);
    assert.equal(early.automations[0].flow.verdict, 'guarded');
});

test('the flow record is an allow-list, so a step\'s own configuration never rides into the artifacts', () => {
    // BFSF-441. The facts are stored on the playbook and handed to a model; a
    // step object is the automation's own configuration and sooner or later one
    // of them holds a recipient address or a bound value. The record names its
    // fields rather than deleting the ones it does not want.
    const dataFlow = require('../../core/privacy/dataFlow');
    const f = facts({ automations: [{ ...AUTO, id: 'aut_1', steps: [{ type: 'integration_action', tool: 'gmail_compose', to: 'jan.jansen@example.com' }] }] });
    assert.deepEqual(Object.keys(f.automations[0].flow).sort(), [...dataFlow.FLOW_FIELDS].sort());
    assert.ok(!JSON.stringify(f.automations[0].flow).includes('jan.jansen@example.com'));
});

test('an automation that sends nothing personal says so, and says which columns it read that from', () => {
    const sends = [{ type: 'integration_action', tool: 'gmail_compose' }];
    const clean = C.gatherFacts({ table: { name: 'T', fields: [{ key: 'total', name: 'Total', type: 'number' }] }, automations: [{ id: 'a', title: 'A', steps: sends }], frameworks: ['GDPR'] });
    assert.deepEqual(clean.automations[0].flow.carries, []);
    assert.equal(clean.automations[0].flow.verdict, 'no_personal_data');
    // `[]` here is an answer, and it is an answer this phase is entitled to:
    // the columns were in hand and none of them is personal data. The OTHER
    // case — nobody established what the automation handles — is `null`, and it
    // is the after-the-fact check that meets it, because a sweep regularly
    // cannot read an automation's tables. gatherFacts always resolves the columns
    // to an array (mergeDetections), so the analyser is what keeps the two
    // apart, and it does: null in, null out, and a verdict of "unknown"
    // rather than an automation declared clean.
    const dataFlow = require('../../core/privacy/dataFlow');
    const unlooked = dataFlow.analyseFlow({ steps: sends, personal: null });
    assert.equal(unlooked.carries, null);
    assert.equal(unlooked.verdict, 'unknown');
});
