/**
 * The recipe document: what an AI's tool call is mechanically brought to,
 * what the validator refuses, and how a template renders against real ids.
 *
 * Run: node --test --test-force-exit playbooks/recipeDoc.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('./recipeDoc');
const R = D;

test('normalise: keys derived, kinds inferred, the table phase first, a fill after the routine, later app phases become turns', () => {
    const doc = D.normaliseRecipeDoc({
        title: 'Klachten afhandelen',
        fields: [{ name: 'Datum', type: 'date' }, { name: 'Klant', type: 'string' }, { key: 'Status', name: 'Status', type: 'enum', options: ['open', 'dicht'] }],
        inputs: [{ label: 'Map met klachten', kind: 'folder', default: '/Klachten' }],
        phases: [
            { kind: 'automation', label: 'Inlezen', brief: 'Build a routine on {{table.name}} with {{field.datum}}' },
            { kind: 'app', label: 'App', brief: 'Build an app on {{table.name}}' },
            { kind: 'app', label: 'Extra scherm', brief: 'Extend this app' },
            { kind: 'datatable', label: 'Tabel' },
        ],
    });
    assert.equal(doc.id, 'custom_klachten_afhandelen');
    assert.deepEqual(doc.table.fields.map((f) => [f.key, f.type, f.required]), [['datum', 'date', true], ['klant', 'text', true], ['status', 'select', true]]);
    assert.deepEqual(doc.table.fields[2].options, ['open', 'dicht']);
    assert.deepEqual(doc.inputs, [{ key: 'map_met_klachten', label: 'Map met klachten', kind: 'folder', default: '/Klachten' }]);
    // …and a DESIGN phase right before the app, its goal from the description/title.
    assert.deepEqual(doc.phases.map((p) => [p.key, p.kind]), [['table', 'table'], ['routine', 'routine'], ['fill', 'fill'], ['design', 'design'], ['app', 'app'], ['app_turn', 'app_turn']]);
    assert.equal(doc.phases[3].goal, 'Klachten afhandelen');
    assert.equal(D.validateRecipeDoc(doc).ok, true, JSON.stringify(D.validateRecipeDoc(doc).errors));
});

test('validate: the refusals a stage could not survive', () => {
    const errs = (raw) => D.validateRecipeDoc(D.normaliseRecipeDoc(raw)).errors.map((e) => e.code);
    assert.deepEqual(errs({ title: '', phases: [] }), ['title_required', 'phases_required']);
    // A design with no app to follow is dropped by normalise (nothing to design for).
    assert.deepEqual(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'design', label: 'D', goal: 'g' }, { kind: 'routine', label: 'R', brief: 'b' }] }).phases.map((p) => p.kind), ['routine']);
    assert.ok(D.validateRecipeDoc({ title: 'x', inputs: [], table: null, phases: [{ key: 'd', kind: 'design', label: 'D' }] }).errors.map((e) => e.code).includes('design_without_app'));
    // A design phase placed after the app is moved before it, not refused.
    assert.deepEqual(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'app', label: 'A', brief: 'b' }, { kind: 'design', label: 'D', goal: 'g' }] }).phases.map((p) => p.kind), ['design', 'app']);
    assert.ok(errs({ title: 'x', phases: [{ kind: 'fill', label: 'F' }] }).includes('fill_without_routine'));
    // A lone app_turn is repaired into THE app, not refused (doctrine: mechanical repair first).
    assert.deepEqual(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'app_turn', label: 'T', brief: 'b' }] }).phases.map((p) => p.kind), ['design', 'app']);
    assert.ok(errs({ title: 'x', phases: [{ kind: 'routine', label: 'R' }] }).includes('brief_required'));
    assert.ok(errs({ title: 'x', phases: [{ kind: 'routine', label: 'R', brief: 'uses {{table.name}}' }] }).includes('unknown_placeholder'));
    assert.ok(errs({ title: 'x', fields: [{ key: 'a', name: 'A', type: 'text' }], phases: [{ kind: 'routine', label: 'R', brief: 'uses {{field.zzz}}' }] }).includes('unknown_placeholder'));
    assert.ok(errs({ title: 'x', fields: [{ key: 's', name: 'S', type: 'select' }], phases: [{ kind: 'routine', label: 'R', brief: 'b' }] }).includes('select_needs_options'));
    assert.ok(errs({ title: 'x', fields: [{ key: 'a', name: 'A', type: 'text' }], phases: [{ kind: 'routine', label: 'R', brief: 'b', requiresRole: 'nope' }] }).includes('requires_role_unknown'));
    // A kind the model made up is read off the words, or the phase is dropped with a warning — never a refusal of the whole document.
    const wiz = D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'wizardry', label: 'W' }, { kind: 'routine', label: 'R', brief: 'b' }] });
    assert.deepEqual(wiz.phases.map((p) => p.kind), ['routine']);
    assert.deepEqual(wiz.warnings, ['phase "W" dropped — no known kind']);
    assert.equal(D.normaliseRecipeDoc({ title: 'x', phases: [{ key: 'fase_1', label: 'Fase 1', brief: 'Build a modern BI dashboard' }] }).phases.find((p) => p.key === 'fase_1').kind, 'app');
    assert.equal(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'approvals', label: 'G', brief: 'b' }] }).phases[0].requires, 'approvals');
    assert.ok(errs({ title: 'x', fields: [{ key: 'a', name: 'A', type: 'text' }], phases: [{ kind: 'table', label: 'T' }] }).includes('no_builder_phase'));
    // A folder input without a default gets one from its label.
    assert.equal(D.normaliseRecipeDoc({ title: 'x', inputs: [{ key: 'folderPath', label: 'Map met contracten', kind: 'folder' }], phases: [] }).inputs[0].default, '/map-met-contracten');
});

test('normalise: the column list survives the shapes a small model writes it in (owner\'s dialog, 2026-09-17)', () => {
    const brief = 'Build a routine on {{table.name}} (id {{table.id}}, key {{table.key}}) with {{field.invoice_date}}';
    const phases = [
        { kind: 'table', label: 'Tabel' },
        { kind: 'routine', label: 'Inlezen', brief },
    ];
    const ok = (raw) => {
        const doc = D.normaliseRecipeDoc({ title: 'Facturen', ...raw, phases }, { locale: 'en' });
        const check = D.validateRecipeDoc(doc);
        assert.ok(check.ok, JSON.stringify(check.errors));
        return doc.table.fields;
    };
    // `table.columns` instead of `table.fields`.
    assert.deepEqual(ok({ table: { columns: [{ key: 'invoice_date', name: 'Invoice Date', type: 'date' }, { key: 'vendor_name', name: 'Vendor', type: 'text' }] } }).map((f) => f.key), ['invoice_date', 'vendor_name']);
    // The fields array handed over AS `table`.
    assert.deepEqual(ok({ table: [{ key: 'invoice_date', name: 'Invoice Date', type: 'date' }] }).map((f) => f.key), ['invoice_date']);
    // String entries: the string IS the column, never a "Column 1".
    const strings = ok({ table: { fields: ['invoice_date', 'Vendor Name', 'amount'] } });
    assert.deepEqual(strings.map((f) => [f.key, f.name, f.type]), [['invoice_date', 'invoice_date', 'text'], ['vendor_name', 'Vendor Name', 'text'], ['amount', 'amount', 'text']]);
    // A comma-joined string of column names.
    assert.deepEqual(ok({ table: { fields: 'invoice_date, vendor_name, amount' } }).map((f) => f.key), ['invoice_date', 'vendor_name', 'amount']);
    assert.deepEqual(ok({ table: { columns: 'invoice_date; vendor_name' } }).map((f) => f.key), ['invoice_date', 'vendor_name']);
    // An object keyed by column name, and one bare column object.
    assert.deepEqual(ok({ table: { fields: { invoice_date: 'date', vendor_name: { type: 'text' } } } }).map((f) => [f.key, f.type]), [['invoice_date', 'date'], ['vendor_name', 'text']]);
    assert.deepEqual(ok({ table: { fields: { name: 'Invoice Date', type: 'date' } } }).map((f) => [f.key, f.name]), [['invoice_date', 'Invoice Date']]);
    // And a genuinely absent table still fails with the clear error, not a silent pass.
    const missing = D.validateRecipeDoc(D.normaliseRecipeDoc({ title: 'x', phases }));
    assert.ok(missing.errors.some((e) => e.code === 'table_schema_missing'));
});

test('what the SERVER adds to a described playbook is written in the demo\'s language', () => {
    const raw = { title: 'Invoices', fields: [{ name: 'Total', type: 'number' }, { name: '', type: 'text' }], inputs: [{ kind: 'folder' }], phases: [{ kind: 'routine', label: 'Read them', brief: 'b {{table.name}}' }, { kind: 'app', label: 'The app', brief: 'a {{table.name}}' }] };
    const en = D.normaliseRecipeDoc(raw, { locale: 'en' });
    assert.deepEqual(en.phases.map((p) => p.label), ['Table', 'Read them', 'First rows', 'Design', 'The app']);
    assert.equal(en.table.fields[1].name, 'Column 2');
    assert.deepEqual([en.inputs[0].label, en.inputs[0].default], ['Input 1', '/input-1']);
    const nl = D.normaliseRecipeDoc(raw, { locale: 'nl' });
    assert.deepEqual(nl.phases.map((p) => p.label), ['Tabel', 'Read them', 'Eerste rijen', 'Ontwerp', 'The app']);
    assert.equal(nl.table.fields[1].name, 'Kolom 2');
    assert.equal(nl.inputs[0].label, 'Invoer 1');
    // An unset locale stays Dutch — the documents written before this existed.
    assert.equal(D.normaliseRecipeDoc(raw).phases[2].label, 'Eerste rijen');
});

test('render: placeholders, the conditional, a missing artifact is a coded error', () => {
    const ctx = D.briefContext({ table: { id: 'tbl_1', key: 'k', name: 'Facturen', mapping: { datum: 'c1', btw: null }, isMirror: true, hasStatus: false }, options: { folderPath: '/F', approverGroupId: 'g1', inputs: { extra: 'E' } }, playbook: { title: 'T', userId: 'u1' } });
    assert.equal(D.renderBrief('{{table.name}} ({{table.id}}, {{table.key}}) {{field.datum}} {{input.folderPath}} {{input.extra}} {{title}} {{approver}} {{owner.id}}', ctx), 'Facturen (tbl_1, k) c1 /F E T {groupId:"g1"} u1');
    assert.equal(D.renderBrief('a{{#if table.isMirror}} mirror{{/if}}{{#if field.btw}} btw{{/if}}{{#if table.hasStatus}} status{{/if}} z', ctx), 'a mirror z');
    assert.throws(() => D.renderBrief('{{field.btw}}', ctx), (e) => e.code === 'artifacts_missing' && e.placeholder === 'field.btw');
    // Only the recipe's own roots are placeholders; a routine binding passes through verbatim.
    assert.deepEqual(D.placeholdersOf('{{#if table.isMirror}}{{field.datum}}{{/if}} {{ title }} {{steps.a.output.x}} {{trigger.output.id}}').sort(), ['field.datum', 'table.isMirror', 'title']);
    assert.equal(D.renderBrief('{{table.name}} {{steps.a.output.rows.0.totaal}}', ctx), 'Facturen {{steps.a.output.rows.0.totaal}}');
});

test('fromDocument: the adapter the lifecycle programs against — roles from the schema, verify by key or title slug, phases with kinds', () => {
    const doc = D.normaliseRecipeDoc({ title: 'Leden', fields: [{ key: 'naam', name: 'Naam', type: 'text' }, { key: 'email', name: 'E-mailadres', type: 'text', required: false }], phases: [{ kind: 'routine', label: 'R', brief: 'r {{table.name}} {{field.naam}}' }, { kind: 'app', label: 'A', brief: 'a {{table.name}}', requires: 'approvals' }] });
    const r = D.fromDocument(doc);
    assert.equal(r.RECIPE_ID, 'custom_leden');
    assert.equal(r.hasTable, true);
    assert.deepEqual(r.PHASE_KEYS, ['table', 'routine', 'fill', 'design', 'app']);
    assert.deepEqual(r.schemaMapping(), { naam: 'naam', email: 'email' });
    assert.deepEqual(r.verifyExistingTable([{ key: 'c1', name: 'Naam', type: 'text' }]), { ok: true, mapping: { naam: 'c1' }, missing: [], hasStatus: false, typeWarnings: [] });
    assert.equal(r.verifyExistingTable([{ key: 'x', name: 'Y', type: 'text' }]).ok, false);
    const phases = r.phasesFor({}, { approvalsAllowed: false });
    assert.deepEqual(phases.map((p) => [p.key, p.kind, p.status]), [['table', 'table', 'ready'], ['routine', 'routine', 'pending'], ['fill', 'fill', 'pending'], ['design', 'design', 'pending'], ['app', 'app', 'locked']]);
    assert.equal(r.composeBrief('design', {}), null);
    assert.equal(r.composeBrief('routine', { table: { id: 't', key: 'k', name: 'Leden', mapping: { naam: 'c1' } }, options: {}, playbook: {} }), 'r Leden c1');
    assert.equal(r.composeBrief('fill', {}), null);
});

test('a column may declare the ROLE its brief addresses it by, so the key can follow the language', () => {
    const doc = D.normaliseRecipeDoc({
        title: 'Invoices',
        fields: [{ key: 'total', name: 'Total', type: 'number', role: 'totaal' }, { key: 'state', name: 'Status', type: 'select', options: ['open'], role: 'status' }],
        phases: [{ kind: 'routine', label: 'R', brief: 'add {{field.totaal}} and {{field.status}}', requiresRole: 'status' }],
    });
    assert.deepEqual(doc.table.fields.map((f) => [f.key, f.role]), [['total', 'totaal'], ['state', 'status']]);
    assert.equal(D.validateRecipeDoc(doc).ok, true);
    const r = D.fromDocument(doc);
    // Role → the table's real key, both for a table this recipe makes…
    assert.deepEqual(r.schemaMapping(), { totaal: 'total', status: 'state' });
    // …and for one that already exists under other names (the role is an alias too).
    assert.deepEqual(r.verifyExistingTable([{ key: 'c1', name: 'Totaal', type: 'number' }, { key: 'c2', name: 'Status', type: 'select' }]).mapping, { totaal: 'c1', status: 'c2' });
    assert.equal(r.composeBrief('routine', { table: { id: 't', key: 'k', name: 'Invoices', mapping: { totaal: 'c1', status: 'c2' } }, options: {}, playbook: {} }), 'add c1 and c2');
    // Without a role the key IS the role — every recipe an AI writes.
    const plain = D.normaliseRecipeDoc({ title: 'X', fields: [{ key: 'total', name: 'Total', type: 'number' }], phases: [{ kind: 'routine', label: 'R', brief: 'add {{field.total}}' }] });
    assert.equal(plain.table.fields[0].role, undefined);
    assert.equal(D.validateRecipeDoc(plain).ok, true);
    assert.deepEqual(D.fromDocument(plain).schemaMapping(), { total: 'total' });
});


test('a brief that only grows past the cap AFTER substitution is clamped, not thrown', () => {
    // `{{table.id}}` is 13 characters and a uuid is 36, so a template the
    // validator accepted at 1600 can render past 1200. This used to throw a
    // codeless Error that every caller rethrew: pressing Continue on the design
    // handoff answered 500 and the playbook was dead with no way past it.
    const doc = R.normaliseRecipeDoc({
        title: 'T',
        table: { fields: [{ key: 'a', name: 'A', type: 'text' }] },
        phases: [
            { key: 'table', kind: 'table', label: 'Table' },
            { key: 'routine', kind: 'routine', label: 'Routine', brief: `## Build\n${'x'.repeat(1100)}\n- into {{table.id}} {{table.id}} {{table.id}}` },
        ],
    }, { source: 'ai', locale: 'en' });
    const recipe = R.fromDocument(doc);
    let text;
    assert.doesNotThrow(() => {
        text = recipe.composeBrief('routine', { table: { id: 'a'.repeat(36), key: 'k', name: 'N', mapping: {} }, options: {}, playbook: {} });
    });
    assert.ok(text.length <= R.MAX_BRIEF_CHARS, `${text.length} over the cap`);
});

test('a design phase must say what the app is for', () => {
    const bad = R.validateRecipeDoc({
        title: 'T',
        table: { fields: [{ key: 'a', name: 'A', type: 'text' }] },
        phases: [
            { key: 'table', kind: 'table', label: 'Table' },
            { key: 'design', kind: 'design', label: 'Design' },
            { key: 'app', kind: 'app', label: 'App', brief: '## Build a … app' },
        ],
    });
    assert.ok(bad.errors.some((e) => e.code === 'goal_required'), 'a goalless design is caught, so the repair round can fix it');
});


test('a column the database already owns never reaches the table creator', () => {
    // A model asked for `created_at` and the playbook died on phase 1 with
    // "Every table already has a "created_at" column" — and Retry could only
    // fail the same way, because the recipe document is replayed as written.
    const doc = R.normaliseRecipeDoc({
        title: 'T',
        table: {
            fields: [
                { key: 'naam', name: 'Naam', type: 'text' },
                // Keyed like the stamp but MEANING a business date: it keeps its
                // meaning under a key of its own.
                { key: 'created_at', name: 'Sollicitatiedatum', type: 'date' },
                // Genuinely asking for the stamp the table already has: dropped,
                // because a second "when was this added" is worse than none.
                { key: 'updated_at', name: 'Created at', type: 'date' },
                { key: 'id', name: 'Id', type: 'text' },
            ],
        },
        phases: [{ key: 'table', kind: 'table', label: 'Table' }, { key: 'app', kind: 'app', label: 'App', brief: '## Build a … app' }],
    }, { source: 'ai', locale: 'nl' });
    const keys = doc.table.fields.map((f) => f.key);
    assert.deepEqual(keys, ['naam', 'sollicitatiedatum']);
    assert.ok(!keys.some((k) => R.reservedKey(k)));

    // And a document ALREADY stored with one still runs: fromDocument strips it
    // too, so an existing playbook's Retry can succeed.
    const stored = {
        ...doc,
        table: { fields: [...doc.table.fields, { key: 'created_at', name: 'Created at', type: 'date' }] },
    };
    const recipe = R.fromDocument(stored);
    assert.ok(!recipe.INVOICE_SCHEMA && true);
    const schema = recipe.schema ? recipe.schema : null;
    const mapped = Object.values(recipe.schemaMapping('nl'));
    assert.ok(!mapped.includes('created_at'), 'the stored column is gone from the mapping too');
    if (schema) assert.ok(!schema.some((f) => f.key === 'created_at'));
});

test('normalise: `columns` is the contract, and every other place a model puts a column list hoists into table.fields — in that order', () => {
    const brief = 'Build a routine on {{table.name}} with {{field.invoice_date}}';
    const cols = (extra) => [{ key: 'invoice_date', name: 'Invoice date', type: 'date' }, ...(extra ? [{ key: extra, name: extra, type: 'text' }] : [])];
    const keys = (raw) => {
        const doc = D.normaliseRecipeDoc({ title: 'Invoices', phases: [{ kind: 'table', label: 'Table' }, { kind: 'routine', label: 'Read', brief }], ...raw }, { locale: 'en' });
        const check = D.validateRecipeDoc(doc);
        assert.ok(check.ok, JSON.stringify(check.errors));
        return doc.table.fields.map((f) => f.key);
    };
    // 1. The contract: a top-level `columns` array (and its old name `fields`).
    assert.deepEqual(keys({ columns: cols('a') }), ['invoice_date', 'a']);
    assert.deepEqual(keys({ fields: cols('b') }), ['invoice_date', 'b']);
    // 2. The nested `table` the contract used to be — object or bare array.
    assert.deepEqual(keys({ table: { fields: cols('c') } }), ['invoice_date', 'c']);
    assert.deepEqual(keys({ table: { columns: cols('d') } }), ['invoice_date', 'd']);
    assert.deepEqual(keys({ table: cols('e') }), ['invoice_date', 'e']);
    // 3. The other names a model gives a table.
    assert.deepEqual(keys({ datatable: { fields: cols('f') } }), ['invoice_date', 'f']);
    assert.deepEqual(keys({ datatable: cols('g') }), ['invoice_date', 'g']);
    assert.deepEqual(keys({ schema: { columns: cols('h') } }), ['invoice_date', 'h']);
    assert.deepEqual(keys({ schema: cols('i') }), ['invoice_date', 'i']);
    assert.deepEqual(keys({ tables: [{ name: 'Invoices', fields: cols('j') }] }), ['invoice_date', 'j']);
    assert.deepEqual(keys({ tables: [cols('k')] }), ['invoice_date', 'k']);
    // 4. Inside the table phase itself — under fields, columns or schema —
    //    even when that phase's kind had to be read off its label.
    const inPhase = (phase) => {
        const doc = D.normaliseRecipeDoc({ title: 'Invoices', columns: [], phases: [phase, { kind: 'routine', label: 'Read', brief }] }, { locale: 'en' });
        assert.ok(D.validateRecipeDoc(doc).ok, JSON.stringify(D.validateRecipeDoc(doc).errors));
        assert.deepEqual(doc.phases.map((p) => p.kind), ['table', 'routine', 'fill']);
        assert.ok(!('fields' in doc.phases[0]) && !('columns' in doc.phases[0]), 'the phase itself carries no columns');
        return doc.table.fields.map((f) => f.key);
    };
    assert.deepEqual(inPhase({ kind: 'table', label: 'Table', fields: cols('l') }), ['invoice_date', 'l']);
    assert.deepEqual(inPhase({ kind: 'datatable', label: 'Table', columns: cols('m') }), ['invoice_date', 'm']);
    assert.deepEqual(inPhase({ kind: 'table', label: 'Table', schema: { invoice_date: 'date', n: 'text' } }), ['invoice_date', 'n']);
    assert.deepEqual(inPhase({ label: 'Tabel', columns: cols('o') }), ['invoice_date', 'o']);
    // The order: the contract wins over a table object, which wins over the phase.
    assert.deepEqual(keys({ columns: cols('top'), table: { fields: cols('nested') }, phases: [{ kind: 'table', label: 'T', columns: cols('phase') }, { kind: 'routine', label: 'R', brief }] }), ['invoice_date', 'top']);
    assert.deepEqual(keys({ columns: [], table: { fields: cols('nested') }, phases: [{ kind: 'table', label: 'T', columns: cols('phase') }, { kind: 'routine', label: 'R', brief }] }), ['invoice_date', 'nested']);
    // A table STUB is not a column list: `{name:"Invoices"}` must not become one column.
    const stub = D.normaliseRecipeDoc({ title: 'x', table: { name: 'Invoices' }, phases: [{ kind: 'routine', label: 'R', brief: 'b' }] });
    assert.equal(stub.table, null);
    // `columns: []` is the honest "no table", not an error in itself.
    const none = D.normaliseRecipeDoc({ title: 'x', columns: [], phases: [{ kind: 'app', label: 'A', brief: '## Build an app' }] });
    assert.equal(none.table, null);
    assert.equal(D.validateRecipeDoc(none).ok, true);
});

test('validate: the table findings name the fix — the `columns` array and the keys the briefs reference', () => {
    const check = (raw) => D.validateRecipeDoc(D.normaliseRecipeDoc(raw, { locale: 'en' }));
    const byCode = (c, code) => c.errors.filter((e) => e.code === code).map((e) => e.message);
    const noTable = check({
        title: 'x', columns: [],
        phases: [
            { kind: 'table', label: 'Table' },
            { kind: 'routine', label: 'Read', brief: 'into {{table.name}} with {{field.invoice_date}}, {{field.supplier}} and {{field.invoice_date}} again' },
            { kind: 'fill', label: 'Rows' },
            { kind: 'app', label: 'App', brief: 'show {{field.total}} of {{table.name}}' },
        ],
    });
    assert.equal(noTable.ok, false);
    assert.deepEqual(byCode(noTable, 'table_schema_missing'), ['Phase "Table" is a table phase but the document has no columns. Add a top-level `columns` array with one entry {key, name, type} per column — the briefs reference: invoice_date, supplier, total.']);
    assert.deepEqual(byCode(noTable, 'fill_without_table'), ['A fill phase counts rows in the table — add `columns`, or remove the fill phase.']);
    assert.deepEqual(byCode(noTable, 'unknown_placeholder'), [
        '{{table.name}} needs `columns` — the table does not exist without them.',
        '{{field.invoice_date}} needs an entry with key "invoice_date" in `columns`.',
        '{{field.supplier}} needs an entry with key "supplier" in `columns`.',
        '{{field.total}} needs an entry with key "total" in `columns`.',
        '{{table.name}} needs `columns` — the table does not exist without them.',
    ]);
    // No brief references a field: the finding does not trail an empty list.
    const bare = check({ title: 'x', phases: [{ kind: 'table', label: 'T' }, { kind: 'app', label: 'A', brief: '## Build an app' }] });
    assert.deepEqual(byCode(bare, 'table_schema_missing'), ['Phase "T" is a table phase but the document has no columns. Add a top-level `columns` array with one entry {key, name, type} per column.']);
    // With a table, an unknown field names the keys that DO exist (roles first).
    const wrongKey = check({ title: 'x', columns: [{ key: 'total', name: 'Total', type: 'number', role: 'totaal' }, { key: 'supplier', name: 'Supplier', type: 'text' }], phases: [{ kind: 'routine', label: 'R', brief: 'uses {{field.amount}}' }] });
    assert.deepEqual(byCode(wrongKey, 'unknown_placeholder'), ['{{field.amount}} is not a column key — `columns` declares: totaal, supplier.']);
    // Anything else is simply not a placeholder this playbook knows.
    const other = check({ title: 'x', phases: [{ kind: 'routine', label: 'R', brief: 'uses {{input.nope}} and {{owner.name}}' }] });
    assert.deepEqual(byCode(other, 'unknown_placeholder'), ['{{input.nope}} is not something this playbook knows.', '{{owner.name}} is not something this playbook knows.']);
    // The referenced keys are also exported on their own, distinct, as
    // placeholdersOf yields them (the conditions of a brief first, then its
    // placeholders), brief by brief.
    assert.deepEqual(D.fieldKeysReferenced(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'routine', label: 'R', brief: '{{field.b}} {{#if field.a}}{{field.c}}{{/if}} {{field.b}}' }, { kind: 'app', label: 'A', brief: '{{field.d}} {{field.a}}' }] })), ['a', 'b', 'c', 'd']);
});

test('validate: every finding is located twice — by path in the normalised document, and by the subject\'s own name', () => {
    // A column finding says `columns`, as the tool does — `table.fields[2]`
    // sent a model adding a top-level `table` object instead of fixing the
    // entry it wrote — and names the column, since the index is the
    // normalised list's (system columns stripped).
    const cols = D.validateRecipeDoc(D.normaliseRecipeDoc({
        title: 'x', columns: [{ key: 'created_at', name: 'Created at', type: 'date' }, { key: 'supplier', name: 'Supplier', type: 'text' }, { key: 'status', name: 'Status', type: 'select' }],
        phases: [{ kind: 'routine', label: 'R', brief: 'b' }],
    }));
    assert.deepEqual(cols.errors.map((e) => [e.code, e.path, e.column]), [['select_needs_options', 'columns[1]', 'status']]);
    assert.equal(D.validateRecipeDoc({ title: 'x', inputs: [], table: { fields: [] }, phases: [{ key: 'r', kind: 'routine', label: 'R', brief: 'b' }] }).errors.find((e) => e.code === 'fields_required').path, 'columns');
    assert.ok(!JSON.stringify(cols).includes('table.fields'));
    // A phase finding carries the phase's key and label: raw [table, routine,
    // app] is normalised to [table, routine, fill, design, app], so the path
    // says phases[4] while the model's own call has the app at index 2.
    const doc = D.normaliseRecipeDoc({
        title: 'x', columns: [{ key: 'supplier', name: 'Supplier', type: 'text' }],
        phases: [
            { key: 'table', kind: 'table', label: 'Table' },
            { key: 'read', kind: 'routine', label: 'Read invoices', brief: '{{field.amount}} into {{table.name}}', requiresRole: 'status' },
            { key: 'app', kind: 'app', label: 'App' },
        ],
    }, { locale: 'en' });
    assert.deepEqual(doc.phases.map((p) => p.kind), ['table', 'routine', 'fill', 'design', 'app']);
    const check = D.validateRecipeDoc(doc);
    assert.deepEqual(check.errors.map((e) => [e.code, e.path, e.phase]), [
        ['unknown_placeholder', 'phases[1].brief', { key: 'read', label: 'Read invoices' }],
        ['requires_role_unknown', 'phases[1]', { key: 'read', label: 'Read invoices' }],
        ['brief_required', 'phases[4].brief', { key: 'app', label: 'App' }],
    ]);
    // The document-level findings carry neither.
    const bare = D.validateRecipeDoc(D.normaliseRecipeDoc({ phases: [{ kind: 'table', label: 'T' }] }));
    assert.deepEqual(bare.errors.map((e) => [e.code, e.path, e.phase, e.column]), [
        ['title_required', 'title', undefined, undefined],
        ['no_builder_phase', 'phases', undefined, undefined],
        ['table_schema_missing', 'phases[0]', { key: 'table', label: 'T' }, undefined],
    ]);
    // The garbled warning is located the same way.
    const garbled = D.validateRecipeDoc(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'app', label: 'A', brief: 'type "text}}},systemPrompt:"' }] }));
    assert.deepEqual(garbled.warnings.map((w) => [w.code, w.path, w.phase]), [['brief_garbled', 'phases[1].brief', { key: 'app', label: 'A' }]]);
});

test('validate: a garbled brief is a WARNING — said in the result, never a refusal', () => {
    // The signature llama.cpp's Gemma parser leaves when it chops a string at
    // a brace: valid JSON, a value that swallowed the next key.
    const doc = D.normaliseRecipeDoc({
        title: 'x', columns: [{ key: 'a', name: 'A', type: 'text' }],
        phases: [{ kind: 'routine', label: 'R', brief: 'field type "text}}},systemPrompt:" with {{field.a}}' }, { kind: 'app', label: 'A', brief: 'clean {{table.name}}' }],
    });
    const check = D.validateRecipeDoc(doc);
    assert.equal(check.ok, true);
    assert.deepEqual(check.errors, []);
    assert.deepEqual(check.warnings.map((w) => [w.code, w.path]), [['brief_garbled', 'phases[1].brief']]);
    assert.match(check.warnings[0].message, /Brief of "R" carries a run of JSON punctuation/);
    // A clean document has an empty warnings list, not a missing one.
    assert.deepEqual(D.validateRecipeDoc(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'app', label: 'A', brief: 'b' }] })).warnings, []);
    assert.deepEqual(D.validateRecipeDoc(null).warnings, []);
});

test('synthesizeTableFromPlaceholders: a column per referenced key, typed by its words, and the document says it was guessed', () => {
    const doc = D.normaliseRecipeDoc({
        title: 'Invoices', columns: [],
        phases: [
            { kind: 'routine', label: 'Read', brief: '{{field.invoice_date}} {{field.supplier}} {{field.amount_excl_vat}} {{field.vat}} {{field.total}} {{field.qty}} {{field.status}} {{field.file_path}} {{field.datum}} {{field.date}} {{field.notes}}' },
            { kind: 'app', label: 'App', brief: 'show {{field.total}} and {{field.document_url}} and {{#if field.status}}{{field.status}}{{/if}}' },
        ],
    }, { locale: 'en' });
    assert.equal(doc.table, null);
    const out = D.synthesizeTableFromPlaceholders(doc, { locale: 'en' });
    assert.deepEqual(out.table.fields.map((f) => [f.key, f.name, f.type, f.required]), [
        ['invoice_date', 'Invoice date', 'date', true],
        ['supplier', 'Supplier', 'text', true],
        ['amount_excl_vat', 'Amount excl vat', 'number', true],
        ['vat', 'Vat', 'number', true],
        ['total', 'Total', 'number', true],
        ['qty', 'Qty', 'number', true],
        ['status', 'Status', 'text', false],
        ['file_path', 'File path', 'text', false],
        ['datum', 'Datum', 'date', true],
        ['date', 'Date', 'date', true],
        ['notes', 'Notes', 'text', true],
        ['document_url', 'Document url', 'text', false],
    ]);
    assert.deepEqual(out.warnings, ['table_synthesized']);
    // The money/count words match whole key segments only: `summary` is not a
    // sum and `country` is not a count, while `total_amount`, `subtotal` and
    // the Dutch `aantal` still read as numbers.
    const typed = D.synthesizeTableFromPlaceholders(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'routine', label: 'R', brief: '{{field.summary}} {{field.country}} {{field.accountant}} {{field.private_note}} {{field.discount_reason}} {{field.total_amount}} {{field.subtotal}} {{field.aantal}} {{field.item_counts}}' }] }));
    assert.deepEqual(typed.table.fields.map((f) => `${f.key}:${f.type}`), [
        'summary:text', 'country:text', 'accountant:text', 'private_note:text', 'discount_reason:text',
        'total_amount:number', 'subtotal:number', 'aantal:number', 'item_counts:number',
    ]);
    // A key the table already owns never becomes a column, and a key written
    // in the wrong case becomes the lowercase column — the placeholders
    // themselves stay unresolvable, and the finding says so. (`{{field.bad-key}}`
    // is not a placeholder at all, so it is neither.)
    const odd = D.synthesizeTableFromPlaceholders(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'routine', label: 'R', brief: '{{field.created_at}} {{field.bad-key}} {{field.Supplier}} {{field.ok}}' }] }));
    assert.deepEqual(odd.table.fields.map((f) => f.key), ['supplier', 'ok']);
    assert.deepEqual(D.validateRecipeDoc(odd).errors.map((e) => e.message), [
        '{{field.created_at}} is not a column key — `columns` declares: supplier, ok.',
        '{{field.Supplier}} is not a column key — `columns` declares: supplier, ok.',
    ]);
    // Re-normalised: the table phase first, a fill after the routine, the
    // design before the app — and the result validates.
    assert.deepEqual(out.phases.map((p) => [p.kind, p.label]), [['table', 'Table'], ['routine', 'Read'], ['fill', 'First rows'], ['design', 'Design'], ['app', 'App']]);
    assert.equal(out.source, 'ai');
    assert.equal(D.validateRecipeDoc(out).ok, true, JSON.stringify(D.validateRecipeDoc(out).errors));
    // The input is not touched.
    assert.equal(doc.table, null);
    assert.equal(doc.warnings, undefined);
    // Earlier warnings survive alongside.
    const warned = D.synthesizeTableFromPlaceholders({ ...doc, warnings: ['phase "W" dropped — no known kind'] }, { locale: 'nl' });
    assert.deepEqual(warned.warnings, ['phase "W" dropped — no known kind', 'table_synthesized']);
    assert.equal(warned.phases[0].label, 'Tabel', 'what the server adds is in the demo\'s language');
    // Nothing to read off: null, so the caller keeps its findings.
    assert.equal(D.synthesizeTableFromPlaceholders(D.normaliseRecipeDoc({ title: 'x', phases: [{ kind: 'routine', label: 'R', brief: 'only {{table.name}}' }] })), null);
    assert.equal(D.synthesizeTableFromPlaceholders(null), null);

    // The marker survives the round trip: the dialog posts the composed
    // document back and the route normalises it AGAIN before storing it —
    // without this the stored playbook lost the one trace that its schema
    // was a guess, and the rail, the table phase summary and every later
    // edit showed it as the model's own.
    const stored = D.normaliseRecipeDoc(out, { source: 'ai', locale: 'en' });
    assert.deepEqual(stored.warnings, ['table_synthesized']);
    assert.deepEqual(stored.table.fields.map((f) => f.key), out.table.fields.map((f) => f.key));
    assert.deepEqual(D.normaliseRecipeDoc(stored).warnings, ['table_synthesized'], 'and the trip after that');
    // Only the marker, and only while there is a table for it to describe:
    // dropped-phase warnings are re-derived (the phase is gone by now), a
    // person who removed the columns by hand removed the guess with them.
    assert.equal(D.normaliseRecipeDoc({ ...out, warnings: ['phase "W" dropped — no known kind', 'anything'] }).warnings, undefined);
    assert.equal(D.normaliseRecipeDoc({ ...out, table: null }).warnings, undefined);
    assert.equal(D.normaliseRecipeDoc({ ...doc, warnings: 'table_synthesized' }).warnings, undefined, 'a string is not the array');
    // A document without the marker gains none.
    assert.equal(D.normaliseRecipeDoc({ title: 'x', columns: [{ key: 'a', name: 'A', type: 'text' }], phases: [{ kind: 'app', label: 'A', brief: 'b' }] }).warnings, undefined);
    // Synthesizing twice does not say it twice.
    assert.deepEqual(D.synthesizeTableFromPlaceholders({ ...out, table: null }, { locale: 'en' }).warnings, ['table_synthesized']);
});
