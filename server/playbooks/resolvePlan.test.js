/**
 * "Resolve with AI" proposes; it never writes. What is pinned here is that the
 * proposal is built from what really exists — a legal basis the organisation
 * configured, a group that is really in the directory, a column that is really
 * in the table — and that a finding with no safe automatic fix says so instead
 * of offering a button that does nothing.
 *
 * Run: node --test --test-force-exit playbooks/resolvePlan.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('./resolvePlan');

const TABLE = {
    id: 'tbl_1',
    scope: { kind: 'org', id: 'orgA' },
    name: 'Invoice BI Automator',
    columns: [
        { key: 'supplier', name: 'Supplier', type: 'text' },
        { key: 'invoice_date', name: 'Invoice Date', type: 'date' },
        { key: 'due_date', name: 'Due Date', type: 'date' },
        { key: 'created_at', name: 'Created At', type: 'date' },
        { key: 'contact_email', name: 'Contact Email', type: 'text' },
        { key: 'contact_person', name: 'Contact Person', type: 'text' },
    ],
    personal: [
        { key: 'contact_email', name: 'Contact Email', kind: 'email', kinds: ['email'] },
        { key: 'contact_person', name: 'Contact Person', kind: 'name', kinds: ['name'] },
    ],
    lawfulBasis: null, retentionDays: null, retentionField: null, subjectColumn: null,
};
const FACTS = {
    frameworks: ['GDPR'],
    table: TABLE,
    automations: [{ id: 'aut_1', title: 'Read invoices', aiSteps: ['data_extraction'], hasPrivacyStep: false, outbound: [] }],
    app: { id: 'app_1', name: 'Invoice app', audience: 'organisation', publicPages: 1, scopedRoles: [] },
    access: { roles: [], memberCount: 0, defaultRole: 'app' },
    org: { legalBases: ['contract', 'legitimate_interests'], defaultRetentionDays: 365, hasDpo: true },
};
const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'list', type: 'nextcloud_list_files' },
        { id: 'read', type: 'nextcloud_read_file' },
        { id: 'ex', type: 'data_extraction', label: 'Extract invoice fields', source: { kind: 'ref', path: 'steps.read.output.content' } },
        { id: 'row', type: 'datatable' },
    ],
    edges: [{ from: 'list', to: 'read' }, { from: 'read', to: 'ex' }, { from: 'ex', to: 'row' }],
};
const DEPS = { definitionOf: () => DEF, spliceTokenize: R.spliceTokenize, addDisclosure: R.addDisclosure, groups: [], people: [] };

test('the registration fills in every derivable fact — and NEVER the legal basis', () => {
    const reg = R.registrationDefaults(FACTS);
    assert.equal(reg.retentionDays, 365);
    assert.equal(reg.retentionField, 'created_at', '"created" beats "due" — retention runs from when we got it');
    assert.equal(reg.subjectColumn, 'contact_person', 'a name beats an e-mail address, and neither is "Currency"');

    // THE BASIS IS NOT A DERIVABLE FACT. This used to answer 'contract' — the
    // organisation's first configured basis — and, failing that, the literal
    // string 'legitimate_interests'. Art. 6(1)(f) is a balancing test with a
    // documented assessment behind it; a plan that proposes it by default is
    // the product taking a legal position on the customer's behalf, and the
    // plan carried it straight into what Apply writes to the row.
    assert.equal(reg.lawfulBasis, null, 'nothing but the table\'s own recorded answer');
    assert.equal(reg.basisSource, null);
    assert.deepEqual(reg.basisCandidates, ['contract', 'legitimate_interests'],
        'the organisation\'s own bases are OFFERED as a shortlist — offering is help, selecting is a position');

    // A basis already on the row is the customer's earlier answer and stands.
    const recorded = R.registrationDefaults({ ...FACTS, table: { ...TABLE, lawfulBasis: 'legal_obligation' } });
    assert.equal(recorded.lawfulBasis, 'legal_obligation');
    assert.equal(recorded.basisSource, 'recorded');

    // Nothing configured at all: still no basis, and no column invented.
    const bare = R.registrationDefaults({ table: { ...TABLE, lawfulBasis: null, columns: [{ key: 'x', name: 'X', type: 'text' }], personal: [] }, org: {} });
    assert.equal(bare.lawfulBasis, null, 'an empty organisation is not a reason to pick one for them');
    assert.deepEqual(bare.basisCandidates, []);
    assert.equal(bare.subjectColumn, null, 'no personal column, no subject column invented');
});

test('the plan Apply writes cannot carry a legal basis nobody chose', () => {
    const out = R.resolveRegistration(FACTS);
    const reg = out.calls[0].body.registration;
    // Absent, not null: this body is what Apply writes, and a key that is not
    // in it is a value that cannot be written by accident.
    assert.equal('lawfulBasis' in reg, false);
    assert.deepEqual(Object.keys(reg).sort(), ['retentionDays', 'retentionField', 'subjectColumn']);
    assert.equal('basisCandidates' in reg, false, 'a hint for the form has no business in a write');

    // …and the plan says out loud that the one thing left is the one thing
    // only the customer can answer, naming their own configured bases.
    assert.equal(out.unresolved.length, 1);
    assert.match(out.unresolved[0].what, /six Art\. 6 grounds/);
    assert.match(out.unresolved[0].what, /performance of a contract, legitimate interests/);
    assert.ok(!out.what.some((line) => /legal basis/.test(line)), out.what.join(' | '));

    // With nothing configured it still refuses to propose one.
    const noBases = R.resolveRegistration({ ...FACTS, org: { ...FACTS.org, legalBases: [] } });
    assert.match(noBases.unresolved[0].what, /nobody but you can decide/);
});

test('a table with no date of its own is still counted from when the row was added', () => {
    // Every datatable carries created_at/updated_at and the retention job ages
    // rows by either, so "this table has no date column" was never a reason to
    // record no retention — and for a table an automation fills, the stamp IS
    // when the row was extracted (owner, 2026-09-17).
    const noDates = { ...FACTS, table: { ...TABLE, columns: TABLE.columns.filter((c) => c.type !== 'date') } };
    assert.deepEqual(R.dateColumns(noDates.table).map((c) => c.key), ['created_at', 'updated_at']);
    const out = R.resolveRegistration(noDates);
    assert.deepEqual(out.unresolved.map((u) => u.kind), ['table'], 'only the legal basis is left open');
    const reg = out.calls[0].body.registration;
    assert.equal(reg.retentionField, 'created_at');
    assert.equal(reg.retentionDays, 365);
    // what[0], not what[1]: with no basis recorded there is no basis sentence
    // above it, because the plan no longer writes one.
    assert.match(out.what[0], /when the row was added/);
    // A table that declares its own created_at is not offered it twice.
    assert.deepEqual(R.dateColumns(TABLE).map((c) => c.key), ['created_at', 'invoice_date', 'due_date', 'updated_at']);
});

test('the privacy fix is a tokenize step in front of the model, and the model then reads the masked text', () => {
    const out = R.resolvePrivacyStep(FACTS, { code: 'ai_no_guard_aut_1' }, DEPS);
    assert.deepEqual(out.unresolved, []);
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].kind, 'automation_definition');
    const def = out.calls[0].body.definition;
    const tok = def.steps.find((s) => s.type === 'tokenize');
    assert.ok(tok, 'a tokenize step was added');
    assert.equal(tok.sourceRef, 'steps.read.output.content', 'it reads what the AI step used to read');
    // Not a guard: a brancher whose onFound.stop can end the run would change
    // what the automation DOES, which a fix must not do behind someone's back.
    assert.equal(def.steps.some((s) => s.type === 'guard'), false);
    // The rewiring: read → tokenize → extract, and the extract reads the mask.
    assert.deepEqual(def.edges.filter((e) => e.to === tok.id).map((e) => e.from), ['read']);
    assert.deepEqual(def.edges.filter((e) => e.from === tok.id).map((e) => e.to), ['ex']);
    assert.deepEqual(def.steps.find((s) => s.id === 'ex').source, { kind: 'ref', path: `steps.${tok.id}.output.text` });
    assert.deepEqual(def.steps.map((s) => s.id).indexOf(tok.id), 2, 'and it sits where it runs, not at the end');
    // The original is untouched — a proposal must not already have happened.
    assert.equal(DEF.steps.length, 4);
    assert.deepEqual(DEF.steps[2].source, { kind: 'ref', path: 'steps.read.output.content' });
});

test('an AI step nothing feeds, or that reads from no named place, is refused in words', () => {
    const orphan = { ...DEF, edges: [{ from: 'list', to: 'read' }] };
    assert.equal(R.spliceTokenize(orphan, { aiStepId: 'ex', sourceField: 'source', sourcePath: 'x' }), null);
    const bare = { ...DEF, steps: DEF.steps.map((s) => (s.id === 'ex' ? { ...s, source: 'just some text' } : s)) };
    const out = R.resolvePrivacyStep(FACTS, { code: 'ai_no_guard_aut_1' }, { ...DEPS, definitionOf: () => bare });
    assert.equal(out.calls, undefined);
    assert.match(out.unresolved[0].what, /does not read from one named place/);
});

test('the disclosure lands where people read it, and marking is only proposed when it is off', () => {
    const withPage = { ...DEF, steps: [...DEF.steps, { id: 'p1', type: 'form_page', label: 'Thanks', text: 'All done.' }] };
    const out = R.resolveDisclosure(FACTS, { code: 'aia_disclosure_aut_1' }, { ...DEPS, definitionOf: () => withPage, sentence: 'Deze tekst is met AI gemaakt.' });
    const def = out.calls.find((c) => c.kind === 'automation_definition').body.definition;
    assert.match(def.steps.find((s) => s.id === 'p1').text, /All done\.\n\nDeze tekst is met AI gemaakt\./);
    assert.ok(out.calls.some((c) => c.kind === 'org_settings' && c.body.ai_content_marking_enabled === true));
    assert.equal(out.calls.find((c) => c.kind === 'org_settings').needs, 'admin_compliance');
    // Marking already on: only the sentence is proposed.
    const on = R.resolveDisclosure({ ...FACTS, org: { ...FACTS.org, markingEnabled: true } }, { code: 'aia_disclosure_aut_1' }, { ...DEPS, definitionOf: () => withPage, sentence: 'x' });
    assert.deepEqual(on.calls.map((c) => c.kind), ['automation_definition']);
});

test('an audience is narrowed only to groups that really exist, and never to none', () => {
    const groups = [{ id: 'g_fin', name: 'Finance' }, { id: 'g_ops', name: 'Ops' }];
    const out = R.resolveAudience(FACTS, {}, { ...DEPS, groups, groupIds: ['g_fin'] });
    assert.deepEqual(out.calls[0].body, { appId: 'app_1', isPublished: true, sharedGroups: ['g_fin'] });
    assert.match(out.what[0], /Finance/);
    // A group the model invented is not in the directory, so nothing is proposed.
    const ghost = R.resolveAudience(FACTS, {}, { ...DEPS, groups, groupIds: ['g_ghost'] });
    assert.equal(ghost.calls, undefined);
    assert.equal(ghost.unresolved[0].kind, 'group');
});

test('a role goes to a real person, and to nobody otherwise', () => {
    const people = [{ id: 'u_ann', name: 'Ann Blok' }];
    const role = R.resolveNamedRole(FACTS, {}, { ...DEPS, people, userIds: ['u_ann'] });
    assert.deepEqual(role.calls[0].body, { appId: 'app_1', userId: 'u_ann', roleKey: 'member' });
    assert.equal(R.resolveNamedRole(FACTS, {}, { ...DEPS, people, userIds: [] }).unresolved[0].kind, 'person');
});

test('a finding with no safe automatic fix is not given a button', () => {
    for (const code of ['ropa_retention', 'mirror_personal', 'ai_no_guard_aut_1', 'aia_disclosure_aut_1', 'personal_data_org_wide', 'iso_access_roles']) {
        assert.equal(R.isResolvable(code), true, code);
    }
    // A public page needs its TOKEN to revoke and the review carries only a
    // count, so that finding gets the link and not a button that cannot aim.
    for (const code of ['personal_data_public_page', 'outbound_aut_1', 'aia_annex_iii_aut_1', 'ai_0', 'something_else']) {
        assert.equal(R.isResolvable(code), false, code);
    }
});

test('planResolve asks the model only for the judgement, and stands without it', async () => {
    const calls = [];
    const deps = {
        resolveModel: async () => 'fast',
        chatForcedTool: async (m, msgs, tool, opts) => {
            calls.push({ tool, opts, system: msgs[0].content, user: msgs[1].content });
            return { structured: { lawfulBasis: 'legal_obligation', retentionDays: 2555, note: 'Invoices must be kept seven years.' } };
        },
    };
    const out = await R.planResolve({ code: 'ropa_retention', finding: { code: 'ropa_retention', title: 'T', why: 'W', fix: 'F' }, facts: FACTS, locale: 'en' }, deps);
    assert.equal(out.ok, true);
    assert.equal(calls[0].tool.function.name, 'propose_fix');
    // It was shown the real options and told to pick from them only.
    assert.match(calls[0].user, /"legal_bases_configured":\["contract","legitimate_interests"\]/);
    assert.match(calls[0].system, /does not exist/);
    const reg = out.plan.calls[0].body.registration;
    assert.equal(reg.lawfulBasis, 'legal_obligation', "the model's choice, because it is one of the six");
    assert.equal(reg.retentionDays, 2555);
    assert.equal(reg.retentionField, 'created_at', 'still the rules\' answer — the model never picks a column');
    // A model proposal is named as one. It reaches the plan only because the
    // person pressed "Resolve with AI", and the sentence has to say who is
    // making the legal call — a basis that reads like a recorded fact hides it.
    assert.match(out.plan.what[0], /proposed, not decided/);
    assert.deepEqual(out.plan.unresolved, [], 'a proposal answers the open question, so it is no longer open');
    assert.equal(out.plan.note, 'Invoices must be kept seven years.');
    assert.equal(out.plan.empty, false);

    // A basis the model invented is dropped, and the default stands.
    const junk = await R.planResolve({ code: 'ropa_retention', finding: { code: 'ropa_retention' }, facts: FACTS }, {
        resolveModel: async () => 'fast',
        chatForcedTool: async () => ({ structured: { lawfulBasis: 'because we felt like it', retentionDays: 999999 } }),
    });
    // …and nothing takes its place: the invented basis is dropped and the plan
    // is short one field rather than filled with a default.
    assert.equal('lawfulBasis' in junk.plan.calls[0].body.registration, false);
    assert.equal(junk.plan.calls[0].body.registration.retentionDays, 365);
    assert.equal(junk.plan.unresolved.length, 1);

    // No model at all — the demo runs with the Wi-Fi off.
    const offline = await R.planResolve({ code: 'ropa_retention', finding: { code: 'ropa_retention' }, facts: FACTS }, {
        resolveModel: async () => { throw new Error('no model'); },
        chatForcedTool: async () => ({}),
    });
    assert.equal(offline.ok, true);
    assert.equal(offline.plan.modelFailed, 'no model');
    assert.equal('lawfulBasis' in offline.plan.calls[0].body.registration, false,
        'no model is not a licence to guess a legal basis either');

    // And a code nothing can fix is refused with a code the stage can read.
    const no = await R.planResolve({ code: 'outbound_aut_1', finding: {}, facts: FACTS }, deps);
    assert.equal(no.ok, false);
    assert.equal(no.code, 'not_resolvable');
});
