'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./invoiceTracker');
const { getRecipe, listRecipes } = require('./index');
const { normalizeFields, DATATABLE_FIELD_TYPES } = require('../../core/dataEngine/dataModel/datatableFields');

const TABLE = { id: 'tbl_ac8bd9ea1182', name: 'Facturen', key: 'facturen', mapping: R.schemaMapping(), isMirror: false, hasStatus: true };
const MIRROR_FIELDS = [
    { key: 'datum', name: 'Datum', type: 'date' }, { key: 'leverancier', name: 'Leverancier', type: 'text' },
    { key: 'factuurnummer', name: 'Factuurnummer', type: 'text' }, { key: 'excl_btw', name: 'Excl. btw', type: 'number' },
    { key: 'btw', name: 'Btw', type: 'number' }, { key: 'totaal', name: 'Totaal', type: 'number' },
];

test('the schema is a valid datatable schema (types the engine has, a select with options)', () => {
    const norm = normalizeFields(R.INVOICE_SCHEMA.map((f) => ({ ...f })), []);
    assert.ok(norm.ok, norm.error);
    assert.equal(norm.fields.length, 8);
    for (const f of R.INVOICE_SCHEMA) assert.ok(DATATABLE_FIELD_TYPES.includes(f.type), `${f.key}: ${f.type}`);
    assert.deepEqual(R.schemaMapping(), Object.fromEntries(R.INVOICE_SCHEMA.map((f) => [f.key, f.key])));
    assert.equal(R.defaultTableKey('Facturen 2026', new Set(['facturen_2026'])), 'facturen_2026_2');
});

test('every brief stays under the cap, names the REAL table and keys, and never a placeholder id', () => {
    const briefs = {
        automation: R.composeAutomationBrief({ table: TABLE, folderPath: '/Invoices-Test' }),
        app: R.composeAppBrief({ table: TABLE, title: 'Facturen' }),
        approvals: R.composeApprovalsBrief({ table: TABLE, approver: { userId: 'u_owner_1' } }),
    };
    for (const [name, b] of Object.entries(briefs)) {
        assert.ok(b.length <= R.MAX_BRIEF_CHARS, `${name}: ${b.length} chars`);
        assert.ok(b.includes('"Facturen"'), `${name} names the table`);
        assert.doesNotMatch(b, /tbl_x+|tbl_…|<tbl_id>|<name>|<key>|<folder>/, `${name} has no placeholder`);
    }
    // Every brief is MARKDOWN — the person reads it rendered, in the handoff
    // card and again as the builder's first message (owner, 2026-09-16).
    for (const [name, b] of Object.entries(briefs)) {
        assert.match(b, /^## /, `${name} opens with a heading`);
        assert.match(b, /\n(?:1\. |- )/, `${name} is a list, one item per line`);
        assert.match(b, /`/, `${name} puts tool names in backticks`);
    }
    // The two automations number their steps; the app lists its screens.
    assert.match(briefs.automation, /\n1\. /);
    assert.match(briefs.approvals, /\n1\. /);
    assert.match(briefs.app, /\n- /);
    // Automation: manual trigger, the four steps, the real id, the six fields, the status literal.
    assert.match(briefs.automation, /^## Build an automation\nI start it by hand: manual trigger/);
    assert.match(briefs.automation, /nextcloud_list_files` on folder "\/Invoices-Test"/);
    assert.match(briefs.automation, /nextcloud_read_file` for each item/);
    assert.match(briefs.automation, /data_extraction` .* datum \(date\), leverancier \(string\), factuurnummer \(string\), excl_btw \(number\), btw \(number\), totaal \(number\)/);
    assert.match(briefs.automation, /datatable add_row` .* \*\*"Facturen"\*\* \(id `tbl_ac8bd9ea1182`, key `facturen`\)/);
    assert.match(briefs.automation, /set status to the literal "open"/);
    assert.doesNotMatch(briefs.automation, /Nextcloud Tables mirror/);
    // App: plan first, link by name, never create/seed, both screens, Dutch labels, finalize.
    // By ID: three tables called "Facturen" exist on the box (measured 2026-09-13) and {name} was ambiguous.
    assert.match(briefs.app, /`app_set_plan`, then `app_link_datatable \{datatableId:"tbl_ac8bd9ea1182"\}`/);
    assert.match(briefs.app, /Never `app_upsert_table` or `app_seed_records`/);
    assert.match(briefs.app, /### Screen "Overzicht"\n- Stat tiles:.*sum excl_btw.*sum btw.*sum totaal/);
    assert.match(briefs.app, /- A `chart` of totaal per month over datum\.\n- A `filter_bar` on leverancier, datum, status\./);
    assert.match(briefs.app, /### Screen "Factuur"\n- A `record_detail`/);
    assert.match(briefs.app, /Finish with `app_finalize`/);
    // Approvals: writable re-link, the literal stage shape with the owner's id, the list screen.
    // The approval flow is a AUTOMATION on Studio → Approvals — the app is never touched.
    assert.match(briefs.approvals, /^## Build an automation "Facturen goedkeuren"\nI start it by hand: manual trigger/);
    assert.match(briefs.approvals, /find_rows` in the EXISTING datatable \*\*"Facturen"\*\* \(id `tbl_ac8bd9ea1182`, key `facturen`\): where status equals "open", sort datum ascending, limit 1/);
    assert.match(briefs.approvals, /set status to "in_beoordeling"/);
    assert.match(briefs.approvals, /builder_add_approval` with assignee \{userId:"u_owner_1"\}, expiresInHours 168/);
    assert.match(briefs.approvals, /\{\{steps\.<step1>\.output\.rows\.0\.factuurnummer\}\}/, 'the automation bindings survive the recipe template');
    assert.match(briefs.approvals, /set status to "goedgekeurd"/);
    assert.doesNotMatch(briefs.approvals, /app_|approval_list|screen/i);
    assert.match(R.composeApprovalsBrief({ table: TABLE, approver: { groupId: 'grp_fin' } }), /assignee \{groupId:"grp_fin"\}/);
    // The DOCUMENT's templates render to exactly what the functions compose —
    // a custom playbook copied from this one starts from the same words.
    const doc = require('../recipeDoc').fromDocument(R.DOCUMENT);
    const ctx = { table: TABLE, options: { folderPath: '/Invoices-Test' }, playbook: { title: 'Facturen', userId: 'u_owner_1' } };
    assert.equal(doc.composeBrief('automation', ctx), briefs.automation);
    assert.equal(doc.composeBrief('app', ctx), briefs.app);
    assert.equal(doc.composeBrief('approvals', ctx), briefs.approvals);
    assert.equal(require('../recipeDoc').validateRecipeDoc(R.DOCUMENT).ok, true);
});

test('an existing table is addressed by ITS keys: mirror titles map onto roles; a missing status drops the status sentences', () => {
    const check = R.verifyExistingTable(MIRROR_FIELDS);
    assert.equal(check.ok, true);
    assert.equal(check.hasStatus, false);
    assert.deepEqual(check.missing, []);
    assert.deepEqual(check.mapping, { datum: 'datum', leverancier: 'leverancier', factuurnummer: 'factuurnummer', excl_btw: 'excl_btw', btw: 'btw', totaal: 'totaal' });
    const titled = R.verifyExistingTable([
        { key: 'c1', name: 'Datum', type: 'date' }, { key: 'c2', name: 'Leverancier', type: 'text' }, { key: 'c3', name: 'Factuurnummer', type: 'text' },
        { key: 'c4', name: 'Excl. btw', type: 'number' }, { key: 'c5', name: 'Totaal', type: 'text' },
    ]);
    assert.equal(titled.ok, true);
    assert.deepEqual(titled.mapping, { datum: 'c1', leverancier: 'c2', factuurnummer: 'c3', excl_btw: 'c4', totaal: 'c5' });
    assert.deepEqual(titled.typeWarnings, []);
    const automation = R.composeAutomationBrief({ table: { id: 'tbl_m1', name: 'Facturen (NC)', key: 'facturen_nc', mapping: titled.mapping, isMirror: true, hasStatus: false }, folderPath: '/Invoices' });
    assert.match(automation, /c1 \(date\), c2 \(string\), c3 \(string\), c4 \(number\), c5 \(number\)/);
    assert.match(automation, /Map the fields by column key\./);
    assert.doesNotMatch(automation, /literal "open"/);
    assert.match(automation, /Nextcloud Tables mirror; rows go to Nextcloud/);
    const app = R.composeAppBrief({ table: { name: 'Facturen (NC)', key: 'facturen_nc', mapping: titled.mapping } });
    assert.match(app, /- A `filter_bar` on c2, c1\./);
    assert.doesNotMatch(app, /totaal btw/);
    const missing = R.verifyExistingTable(MIRROR_FIELDS.filter((f) => f.key !== 'totaal'));
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missing, ['totaal']);
    const wrongType = R.verifyExistingTable([...MIRROR_FIELDS.filter((f) => f.key !== 'totaal'), { key: 'totaal', name: 'Totaal', type: 'bool' }]);
    assert.deepEqual(wrongType.typeWarnings, ['totaal: column "totaal" is bool, expected number|text']);
});

test('phasesFor: table ready, the rest pending, approvals locked without the capability', () => {
    const open = R.phasesFor({ tableMode: 'new' }, { approvalsAllowed: true });
    assert.deepEqual(open.map((p) => [p.key, p.status]), [['table', 'ready'], ['automation', 'pending'], ['fill', 'pending'], ['design', 'pending'], ['app', 'pending'], ['approvals', 'pending']]);
    assert.match(open[3].goal, /factuur-app/);
    const locked = R.phasesFor({ tableMode: 'existing' }, { approvalsAllowed: false });
    assert.equal(locked[5].status, 'locked');
    assert.deepEqual(open[0].artifacts, {});
    assert.equal(open[0].briefVersion, R.BRIEF_VERSION);
});

test('an English workspace builds an English demo: English columns, briefs and labels, the same roles', () => {
    const doc = R.toDocument('en');
    const mapping = R.schemaMapping('en');
    // The columns are English — keys and names — while the ROLES the briefs
    // address them by never move.
    assert.deepEqual(R.schemaFor('en').map((f) => `${f.key}:${f.name}`), ['date:Date', 'supplier:Supplier', 'invoice_number:Invoice number', 'excl_vat:Excl. VAT', 'vat:VAT', 'total:Total', 'status:Status', 'file:File']);
    assert.deepEqual(mapping, { datum: 'date', leverancier: 'supplier', factuurnummer: 'invoice_number', excl_btw: 'excl_vat', btw: 'vat', totaal: 'total', status: 'status', bestand: 'file' });
    const norm = normalizeFields(R.schemaFor('en'), []);
    assert.ok(norm.ok, norm.error);
    assert.deepEqual(norm.fields.find((f) => f.key === 'status').options, ['open', 'in_review', 'approved', 'rejected', 'paid']);
    // A table this recipe just made in English maps back onto the roles.
    const back = R.verifyExistingTable(R.schemaFor('en'));
    assert.equal(back.ok, true);
    assert.deepEqual(back.mapping, mapping);

    const table = { id: 'tbl_en1', name: 'Invoices', key: 'invoices', mapping, isMirror: false, hasStatus: true };
    const automation = R.composeAutomationBrief({ table, folderPath: '/Invoices', locale: 'en' });
    const app = R.composeAppBrief({ table, title: 'Invoices', locale: 'en' });
    const approvals = R.composeApprovalsBrief({ table, approver: { userId: 'u_owner_1' }, locale: 'en' });
    for (const [name, b] of Object.entries({ automation, app, approvals })) {
        assert.ok(b.length <= R.MAX_BRIEF_CHARS, `${name}: ${b.length} chars`);
        assert.doesNotMatch(b, /Facturen|factuur|btw|Datum|Leverancier|goedkeur/i, `${name} says nothing Dutch`);
    }
    assert.match(automation, /date \(date\), supplier \(string\), invoice_number \(string\), excl_vat \(number\), vat \(number\), total \(number\)/);
    assert.match(automation, /set status to the literal "open"/);
    assert.match(automation, /Title "Read invoices"/);
    assert.match(app, /### Screen "Overview"\n- Stat tiles: invoice count \(count\), total excl\. VAT \(sum excl_vat\)/);
    assert.match(app, /### Screen "Invoice"\n- A `record_detail`/);
    assert.match(app, /English labels everywhere \(Date, Supplier, Invoice number, Excl\. VAT, VAT, Total, Status\)/);
    assert.match(approvals, /^## Build an automation "Approve invoices"/);
    assert.match(approvals, /set status to "in_review"/);
    assert.match(approvals, /prompt "Approve invoice \{\{steps\.<step1>\.output\.rows\.0\.invoice_number\}\} from \{\{steps\.<step1>\.output\.rows\.0\.supplier\}\}/);
    assert.match(approvals, /set status to "approved"/);

    // The English document is runnable and its templates render to exactly
    // the same briefs — the two languages cannot drift apart either.
    const docAdapter = require('../recipeDoc').fromDocument(doc);
    const ctx = { table, options: { folderPath: '/Invoices' }, playbook: { title: 'Invoices', userId: 'u_owner_1' } };
    assert.equal(require('../recipeDoc').validateRecipeDoc(doc).ok, true);
    assert.equal(docAdapter.composeBrief('automation', ctx), automation);
    assert.equal(docAdapter.composeBrief('app', ctx), app);
    assert.equal(docAdapter.composeBrief('approvals', ctx), approvals);
    // A copy of the document behaves like the module: role → the table's key.
    assert.deepEqual(docAdapter.schemaMapping(), mapping);
    assert.deepEqual(docAdapter.verifyExistingTable(MIRROR_FIELDS).mapping, { datum: 'datum', leverancier: 'leverancier', factuurnummer: 'factuurnummer', excl_btw: 'excl_btw', btw: 'btw', totaal: 'totaal' });

    // The rail, the title and the folder field speak English too.
    assert.deepEqual(R.phasesFor({ locale: 'en' }, { approvalsAllowed: true }).map((p) => p.label), ['Table', 'Automation', 'First rows', 'Design', 'App', 'Approval flow']);
    assert.match(R.phasesFor({ locale: 'en' }, {})[3].goal, /invoice app/);
    assert.equal(R.titleFor('en'), 'Invoice tracker');
    assert.equal(R.tableTitleFor('en'), 'Invoices');
    assert.equal(doc.inputs[0].label, 'Nextcloud folder with the invoices');
    // Anything we ship no words for reads English; an unset locale stays Dutch.
    assert.equal(R.titleFor('de'), 'Invoice tracker');
    assert.equal(R.titleFor(undefined), 'Facturen bijhouden');
    assert.deepEqual(R.schemaMapping(), R.schemaMapping('nl'));
});

test('the registry still resolves the recipe, and offers none', () => {
    assert.equal(getRecipe('invoice_tracker'), R);
    assert.equal(getRecipe('nope'), null);
    // OFFERED is empty since 2026-09-16: the New dialog has one door, Describe
    // it. The module stays because playbooks built from it are on file and
    // their briefs and phase labels are composed from it on every transition.
    assert.deepEqual(listRecipes(), []);
    assert.deepEqual(listRecipes('en'), []);
    // The document it would be listed AS is unchanged (recipeDoc.js shape).
    assert.deepEqual([R.DOCUMENT.id, R.DOCUMENT.title, R.DOCUMENT.source, R.DOCUMENT.phases.map((p) => `${p.key}:${p.kind}`)], ['invoice_tracker', 'Facturen bijhouden', 'builtin', ['table:table', 'automation:automation', 'fill:fill', 'design:design', 'app:app', 'approvals:automation']]);
    assert.equal(R.toDocument('en').title, 'Invoice tracker');
});
