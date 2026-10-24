'use strict';

/**
 * validate — the SECOND kind of table: a model table that fetches its rows from a Studio
 * datatable (model.tables[].source).
 *
 * What is pinned here is precisely what can go wrong without anyone noticing:
 *
 *   1. a datatableId that points nowhere is reported BY NAME — silently skipping it yields an
 *      app that publishes, runs and shows an empty screen, and then nothing says WHERE it went
 *      wrong;
 *   2. `mode` has two values and a third is an error, never a silent 'read';
 *   3. a table WITHOUT source changes nothing in behaviour — this is additive.
 *
 * Run: node --test --test-reporter=tap appStudio/validate.tableSource.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('./validate');

const has = (recs, code) => recs.some((r) => r.code === code);
const find = (recs, code) => recs.find((r) => r.code === code);

const LINKED_ID = 'tbl_link01';
const OWN_ID = 'tbl_own001';

/** Een canoniek model: één tabel met eigen opslag, één met een `source`. */
function modelWith(source) {
    const tables = [{
        id: OWN_ID, key: 'notes', name: 'Notes', icon: null,
        fields: [{ id: 'fld_n00001', key: 'body', name: 'Body', type: 'text', required: false, unique: false }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }];
    if (source !== undefined) {
        tables.push({
            id: LINKED_ID, key: 'orders', name: 'Orders', icon: null,
            fields: [{ id: 'fld_o00001', key: 'total', name: 'Total', type: 'number', required: false, unique: false }],
            access: { default: 'app', roles: {}, rowFilters: {} },
            source,
        });
    }
    return { modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

const LINKED = { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' };

/** Eén scherm met één lijst die aan `binding` hangt. */
function defWith(binding) {
    return {
        schemaVersion: 2,
        meta: { name: 'Orders', description: '', icon: 'LayoutGrid' },
        homeScreenId: 'scr_home01',
        screens: [{
            id: 'scr_home01', name: 'Home', icon: null, showInNav: true, maxWidth: 'wide',
            sections: [{
                id: 'sec_a00001', style: { padding: 4, gap: 3, background: 'none' },
                children: [{ id: 'cmp_lst001', type: 'list', props: { source: binding, titleKey: 'total' } }],
            }],
        }],
        actions: {},
    };
}

const run = (binding, opts) => validateAppDefinition(defWith(binding), opts);
const readsLinked = { kind: 'records', tableId: LINKED_ID };

// ── 1. De dangling datatabel — bij naam, nooit stil ──────────────────

test('a dangling datatableId is reported BY NAME as an error when the owner list is known', () => {
    const res = run(readsLinked, { dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dtaaaa'] });
    const rec = find(res.errors, 'binding.unknown_datatable');
    assert.ok(rec, `expected binding.unknown_datatable, got ${JSON.stringify(res.errors)}`);
    assert.equal(rec.severity, 'error');
    // BY NAME: the id is in the message, not only in the path.
    assert.match(rec.message, /tbl_dt0001/);
    // And the path points to the place where the author can repair it — the binding — not to a path
    // in the data model that the editor does not know.
    assert.equal(rec.path, 'screens[0].sections[0].children[0].props.source.tableId');
    assert.ok(rec.hint, 'a finding without a hint is half a finding');
});

test('without an owner list it is a WARNING — also by name; unknown is never silence', () => {
    const res = run(readsLinked, { dataModel: modelWith(LINKED), datasets: [] });
    const rec = find(res.warnings, 'binding.datatable_unverified');
    assert.ok(rec, `expected binding.datatable_unverified, got ${JSON.stringify(res.warnings)}`);
    assert.equal(rec.severity, 'warning');
    assert.match(rec.message, /tbl_dt0001/);
    // No list may EVER be read as "everything resolves".
    assert.ok(!has(res.errors, 'binding.unknown_datatable'));
});

test('an EMPTY owner list is not the same answer as no list — it rejects', () => {
    const res = run(readsLinked, { dataModel: modelWith(LINKED), datasets: [], datatables: [] });
    assert.ok(has(res.errors, 'binding.unknown_datatable'), JSON.stringify(res.errors));
});

test('a datatableId the owner has resolves clean', () => {
    const res = run(readsLinked, { dataModel: modelWith(LINKED), datasets: [], datatables: [{ id: 'tbl_dt0001' }] });
    assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
    assert.deepEqual(res.warnings.filter((w) => /datatable/.test(w.code)), []);
});

test('a linked table with no Studio table selected is an error, not a shrug', () => {
    const res = run(readsLinked, {
        dataModel: modelWith({ kind: 'datatable', datatableId: '', mode: 'read' }),
        datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.ok(has(res.errors, 'binding.table_source_invalid'), JSON.stringify(res.errors));
});

test('the finding rides the same draft/publish ladder as every other data reference', () => {
    // dataRefsAsWarnings: a half-wired draft must remain saveable.
    const draft = run(readsLinked, {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_other1'], dataRefsAsWarnings: true,
    });
    assert.ok(!has(draft.errors, 'binding.unknown_datatable'));
    assert.ok(has(draft.warnings, 'binding.unknown_datatable'), JSON.stringify(draft.warnings));
});

// ── 2. mode — twee waarden, en een derde is een fout ─────────────────

test('both legal modes pass', () => {
    for (const mode of ['read', 'readwrite']) {
        const res = run(readsLinked, {
            dataModel: modelWith({ ...LINKED, mode }), datasets: [], datatables: ['tbl_dt0001'],
        });
        assert.deepEqual(res.errors, [], `mode ${mode}: ${JSON.stringify(res.errors)}`);
    }
});

test('an unknown third mode is an ERROR — never a silent read', () => {
    for (const mode of ['write', 'readWrite', 'rw', undefined, null, 3]) {
        const res = run(readsLinked, {
            dataModel: modelWith({ ...LINKED, mode }), datasets: [], datatables: ['tbl_dt0001'],
        });
        const rec = find(res.errors, 'binding.table_source_invalid');
        assert.ok(rec, `mode ${JSON.stringify(mode)} must be refused: ${JSON.stringify(res.errors)}`);
        assert.match(rec.hint, /"read" or "readwrite"/);
    }
});

test('an unknown source KIND is refused rather than treated as own storage', () => {
    const res = run(readsLinked, {
        dataModel: modelWith({ kind: 'spreadsheet', datatableId: 'tbl_dt0001', mode: 'read' }),
        datasets: [], datatables: ['tbl_dt0001'],
    });
    const rec = find(res.errors, 'binding.table_source_invalid');
    assert.ok(rec, JSON.stringify(res.errors));
    assert.match(rec.message, /spreadsheet/);
});

test('a source that is not an object at all is refused, not read as own storage', () => {
    const res = run(readsLinked, {
        dataModel: modelWith('tbl_dt0001'), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.ok(has(res.errors, 'binding.table_source_invalid'), JSON.stringify(res.errors));
});

// ── 3. Additief — de bestaande soort blijft werken ───────────────────

test('a table with its OWN storage produces no source finding at all', () => {
    const res = run({ kind: 'records', tableId: OWN_ID }, {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_other1'],
    });
    assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
    assert.deepEqual(res.warnings.filter((w) => /datatable|table_source/.test(w.code)), []);
});

test('a model with no sourced tables at all behaves exactly as before', () => {
    const res = run({ kind: 'records', tableId: OWN_ID }, { dataModel: modelWith(), datasets: [] });
    assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
    assert.deepEqual(res.warnings, [], JSON.stringify(res.warnings));
});

test('without opts.dataModel the source checks are skipped entirely (existing callers untouched)', () => {
    const res = run(readsLinked, { knownTables: [LINKED_ID] });
    assert.ok(!has(res.errors, 'binding.unknown_datatable'));
    assert.ok(!has(res.errors, 'binding.table_source_invalid'));
    assert.ok(!has(res.warnings, 'binding.datatable_unverified'));
});

test('checkTableRef still runs alongside it — an unknown table is still an unknown table', () => {
    const res = run({ kind: 'records', tableId: 'tbl_ghost1' }, {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.ok(has(res.errors, 'binding.unknown_table'), JSON.stringify(res.errors));
    // …and the source verdict stays silent about a table that the model does not know: that is
    // already reported, and two findings about the same gap help nobody.
    assert.ok(!has(res.errors, 'binding.unknown_datatable'));
});

test('every read binding kind asks the question, not just records', () => {
    const kinds = [
        { kind: 'record', tableId: LINKED_ID, recordId: 'rec_x' },
        { kind: 'records', tableId: LINKED_ID },
        { kind: 'aggregate', tableId: LINKED_ID, aggregates: [{ fn: 'count', as: 'count' }] },
    ];
    for (const binding of kinds) {
        const res = run(binding, { dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_other1'] });
        assert.ok(has(res.errors, 'binding.unknown_datatable'), `${binding.kind}: ${JSON.stringify(res.errors)}`);
    }
});

// ── 4. Columns of a linked table do not belong to the app ────────

test('filter/sort keys on a LINKED table are not judged here — the datatable owns its columns', () => {
    const binding = {
        kind: 'records', tableId: LINKED_ID,
        filter: [{ field: 'not_in_the_mirror', op: 'eq', value: 1 }],
        sort: [{ field: 'also_not_here', dir: 'asc' }],
    };
    const res = run(binding, { dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'] });
    assert.ok(!has(res.errors, 'binding.unknown_field'), JSON.stringify(res.errors));
});

test('…while a table with its own storage still has every column checked', () => {
    const binding = { kind: 'records', tableId: OWN_ID, filter: [{ field: 'nope', op: 'eq', value: 1 }] };
    const res = run(binding, { dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'] });
    assert.ok(has(res.errors, 'binding.unknown_field'), JSON.stringify(res.errors));
});

// ── 4. Every OTHER path that names a table ─────────────────────────────
//
// checkTableSource was only attached to the READ bindings (validate/bindings.js), so an app whose
// linked table was touched only by a STEP, by an approval hook, by an ai writeTo or by an
// input_relation validated and published cleanly while `source.datatableId` pointed to a Studio
// table that the owner no longer has. The error then surfaced only when running, on the user's screen.

const KNOWN = ['tbl_dtaaaa'];  // an owner list that tbl_dt0001 is NOT in
const RW = { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'readwrite' };

/** Eén knop met één actie, plus (optioneel) een los component. */
function defWithAction(action, extraNode = null) {
    const def = defWith({ kind: 'static', value: 'x' });
    def.actions = { act_go: action };
    def.screens[0].sections[0].children = [
        { id: 'cmp_btn001', type: 'button', props: { label: 'Go' }, onClick: 'act_go' },
        ...(extraNode ? [extraNode] : []),
    ];
    return def;
}

const STEP_CASES = [
    ['create_record', { kind: 'sequence', steps: [{ kind: 'create_record', tableId: LINKED_ID, values: { total: { kind: 'static', value: 1 } } }] }],
    ['update_record', { kind: 'sequence', steps: [{ kind: 'update_record', tableId: LINKED_ID, recordId: { kind: 'static', value: 'rec_1' }, values: { total: { kind: 'static', value: 1 } } }] }],
    ['delete_record', { kind: 'sequence', steps: [{ kind: 'delete_record', tableId: LINKED_ID, recordId: { kind: 'static', value: 'rec_1' } }] }],
];

test('een STAP die een gekoppelde tabel noemt krijgt dezelfde harde fout als een binding', () => {
    for (const [what, action] of STEP_CASES) {
        const res = validateAppDefinition(defWithAction(action), {
            dataModel: modelWith(RW), datasets: [], datatables: KNOWN,
        });
        const rec = find(res.errors, 'step.unknown_datatable');
        assert.ok(rec, `${what}: verwacht step.unknown_datatable, kreeg ${JSON.stringify(res.errors)}`);
        assert.match(rec.message, /tbl_dt0001/, `${what}: de id hoort in het bericht`);
    }
});

test('een SCHRIJFstap op een mode:read-koppeling is een fout bij het publiceren, niet bij het klikken', () => {
    for (const [what, action] of STEP_CASES) {
        const res = validateAppDefinition(defWithAction(action), {
            // The datatable DOES exist here — only the link is read.
            dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
        });
        const rec = find(res.errors, 'step.table_read_only');
        assert.ok(rec, `${what}: verwacht step.table_read_only, kreeg ${JSON.stringify(res.errors)}`);
        assert.equal(rec.severity, 'error');
        assert.match(rec.message, /reading only/);
    }
});

test('een schrijfstap op een READWRITE-koppeling die bestaat, valideert schoon', () => {
    for (const [what, action] of STEP_CASES) {
        const res = validateAppDefinition(defWithAction(action), {
            dataModel: modelWith(RW), datasets: [], datatables: ['tbl_dt0001'],
        });
        assert.equal(has(res.errors, 'step.table_read_only'), false, what);
        assert.equal(has(res.errors, 'step.unknown_datatable'), false, what);
    }
});

test('een LEESstap op een read-koppeling is geen fout — alleen schrijven is dat', () => {
    const action = { kind: 'sequence', steps: [{ kind: 'refresh', tableId: LINKED_ID }] };
    const res = validateAppDefinition(defWithAction(action), {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.equal(has(res.errors, 'step.table_read_only'), false);
});

test('de approval-haak onDecided schrijft, dus geldt daar hetzelfde', () => {
    const action = {
        kind: 'sequence',
        steps: [{
            kind: 'request_approval', title: 'Ok?', approvers: [{ kind: 'user', id: 'u1' }],
            onDecided: { tableId: LINKED_ID, recordId: { kind: 'static', value: 'rec_1' }, set: { approved: { total: 1 } } },
        }],
    };
    const res = validateAppDefinition(defWithAction(action), {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.ok(find(res.errors, 'step.table_read_only'), JSON.stringify(res.errors));
});

test('ai_extract writeTo schrijft, dus geldt daar hetzelfde', () => {
    const action = {
        kind: 'sequence',
        steps: [{
            kind: 'ai_extract', source: { kind: 'static', value: 'x' },
            schema: [{ name: 'total', type: 'number' }],
            writeTo: { tableId: LINKED_ID, mapping: { total: 'total' } },
        }],
    };
    const res = validateAppDefinition(defWithAction(action), {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.ok(find(res.errors, 'step.table_read_only'), JSON.stringify(res.errors));
});

test('input_relation LEEST, dus alleen de bronvraag — geen leesrecht-fout', () => {
    const node = { id: 'cmp_rel001', type: 'input_relation', props: { name: 'order', tableId: LINKED_ID, label: 'Order' } };
    const missing = validateAppDefinition(defWithAction({ kind: 'navigate', screenId: 'scr_home01' }, node), {
        dataModel: modelWith(LINKED), datasets: [], datatables: KNOWN,
    });
    assert.ok(find(missing.errors, 'binding.unknown_datatable'), JSON.stringify(missing.errors));

    const fine = validateAppDefinition(defWithAction({ kind: 'navigate', screenId: 'scr_home01' }, node), {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.equal(has(fine.errors, 'binding.unknown_datatable'), false);
    assert.equal(has(fine.errors, 'binding.table_read_only'), false, 'lezen is geen schrijven');
});

test('een tabel met EIGEN opslag verandert op geen van deze paden', () => {
    const action = { kind: 'sequence', steps: [{ kind: 'create_record', tableId: OWN_ID, values: { body: { kind: 'static', value: 'x' } } }] };
    const res = validateAppDefinition(defWithAction(action), {
        dataModel: modelWith(LINKED), datasets: [], datatables: ['tbl_dt0001'],
    });
    assert.equal(has(res.errors, 'step.table_read_only'), false);
    assert.equal(has(res.errors, 'step.unknown_datatable'), false);
    assert.equal(has(res.warnings, 'step.datatable_unverified'), false);
});
