'use strict';

/**
 * builder_create_datatable — a table at DESIGN time. Fake deps: the
 * creator, the principal, the permission, the catalog.
 *
 * Run: node --test --test-force-exit automation/builderTools/datatableCreate.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyCreateDatatable, createPendingDatatable, normaliseFieldArgs } = require('./datatableCreate');
const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
const { TOOL_SCHEMAS } = require('./schemas');
const { CORE_TOOL_NAMES } = require('../builderModelProfiles');

function deps(overrides = {}) {
    const calls = [];
    return {
        calls,
        resolvePrincipal: async (userId) => ({ userId, orgId: 'orgA' }),
        hasManageDatatables: async () => true,
        defaultCreateScope: (p) => (p.orgId ? { kind: 'org', id: p.orgId } : { kind: 'user', id: p.userId }),
        evaluateForRequest: async () => ({}),
        normalizeFields,
        createStudioDatatable: async (args) => { calls.push(args); return { ok: true, table: { id: 'tbl_new01', key: args.key || 'invoice', name: args.name, scope: { kind: 'org', id: 'orgA' }, fields: args.fields.map((f) => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })) } }; },
        catalogFor: async () => [{ id: 'tbl_new01', name: 'invoice', key: 'invoice', columns: [{ key: 'supplier', name: 'Supplier', type: 'text' }] }],
        ...overrides,
    };
}

test('the column list is read the way the model writes it: keys derived from names, type aliases, a select without options becomes text', () => {
    const notes = [];
    const fields = normaliseFieldArgs([
        { name: 'Supplier', type: 'string' }, { name: 'Excl. btw', type: 'currency' }, { label: 'Datum', type: 'date' },
        { name: 'Status', type: 'select', options: ['open', 'paid', 'open'] }, { name: 'Kind', type: 'select' }, { key: 'Bad Key', name: 'X', type: 'weird' },
    ], notes);
    assert.deepEqual(fields.map((f) => [f.key, f.type]), [['supplier', 'text'], ['excl_btw', 'number'], ['datum', 'date'], ['status', 'select'], ['kind', 'text'], ['bad_key', 'text']]);
    assert.deepEqual(fields[3].options, ['open', 'paid']);
    assert.ok(notes.some((n) => /type "currency" read as "number"/.test(n)));
    assert.ok(notes.some((n) => /select without options read as text/.test(n)));
    assert.ok(notes.some((n) => /key "Bad Key" read as "bad_key"/.test(n)));
});

test('creates the table for the automation owner, refreshes the draft catalog in place and points at builder_add_datatable', async () => {
    const d = deps();
    const wrap = { userId: 'u1', _datatables: [] };
    const r = await applyCreateDatatable(wrap, { name: 'invoice', fields: [{ name: 'Supplier', type: 'text' }, { name: 'Total', type: 'number' }] }, d);
    assert.ok(!r.error, JSON.stringify(r));
    assert.equal(r.datatableId, 'tbl_new01');
    assert.equal(r.created, true);
    assert.deepEqual(r.fields.map((f) => f.key), ['supplier', 'total']);
    assert.match(r._next, /builder_add_datatable \{op:"add_row", datatableId:"tbl_new01"/);
    assert.deepEqual(d.calls[0].fields.map((f) => f.key), ['supplier', 'total']);
    assert.equal(d.calls[0].ownerUserId, 'u1');
    assert.equal(d.calls[0].hasManageDatatables, true);
    assert.ok(wrap._datatables.some((t) => t.id === 'tbl_new01'), 'the catalog the next call reads holds the table');
});

test('idempotent on the name; the refusals name the cause; no owner is a clear stop', async () => {
    const d = deps();
    const wrap = { userId: 'u1', _datatables: [{ id: 'tbl_old', name: 'Invoice', key: 'invoice', columns: [{ key: 'supplier', type: 'text' }] }] };
    const again = await applyCreateDatatable(wrap, { name: 'invoice', fields: [{ name: 'X', type: 'text' }] }, d);
    assert.ok(!again.error);
    assert.equal(again.datatableId, 'tbl_old');
    assert.match(again.note, /already exists/);
    assert.equal(d.calls.length, 0, 'nothing created');
    assert.match((await applyCreateDatatable(wrap, { fields: [] }, d)).error, /name is required/);
    assert.match((await applyCreateDatatable(wrap, { name: 'Nieuw', fields: [] }, d)).error, /fields must list at least one column/);
    const refused = await applyCreateDatatable({ userId: 'u2', _datatables: [] }, { name: 'Nieuw', fields: [{ name: 'A', type: 'text' }] }, deps({ createStudioDatatable: async () => ({ ok: false, code: 'manage_datatables_required', error: 'no' }) }));
    assert.equal(refused.code, 'manage_datatables_required');
    assert.match(refused._fixHint, /may not create organisation tables/);
    assert.match((await applyCreateDatatable({ _datatables: [] }, { name: 'N', fields: [{ name: 'A', type: 'text' }] }, d)).error, /no owner/);
});

test('the tool is on the menu: a schema, the small-model core set, and the add_datatable schema points at it', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_create_datatable');
    assert.ok(schema, 'schema present');
    assert.deepEqual(schema.function.parameters.required, ['name', 'fields']);
    assert.ok(CORE_TOOL_NAMES.has('builder_create_datatable'));
    const add = TOOL_SCHEMAS.find((t) => t.function.name === 'builder_add_datatable');
    assert.match(add.function.description, /create it FIRST with builder_create_datatable/);
    assert.ok(CORE_TOOL_NAMES.has('builder_add_datatable'), 'the _next hint and the add schema name it — so the small band must have it');
});

test('no core tool text points at a tool outside the small-model menu', () => {
    // A core tool's description naming another builder_* tool is an instruction
    // the small band follows — so what it names must be on its menu. Measured
    // 2026-09-17: builder_create_datatable's schema and _next hint both said
    // "write into it with builder_add_datatable", which was full-band only.
    const allNames = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
    const offMenu = new Set();
    for (const t of TOOL_SCHEMAS) {
        if (!CORE_TOOL_NAMES.has(t.function.name)) continue;
        for (const m of JSON.stringify(t.function).matchAll(/builder_[a-z_]+/g)) {
            if (allNames.has(m[0]) && !CORE_TOOL_NAMES.has(m[0])) offMenu.add(m[0]);
        }
    }
    assert.deepEqual([...offMenu], [], `core tool texts name tools outside the core menu: ${[...offMenu].join(', ')}`);
});

test('_stageDatatables delegates to staging: nothing is created and the live catalog is untouched', async () => {
    const d = deps();
    const wrap = { userId: 'u1', _stageDatatables: true, _datatables: [{ id: 'tbl_old', name: 'Old', key: 'old', columns: [] }], _pendingDatatables: [], _datatableCreate: { ok: true, scope: { kind: 'org', id: 'orgA' } } };
    const r = await applyCreateDatatable(wrap, { name: 'Invoice', fields: [{ name: 'Supplier', type: 'text' }] }, d);
    assert.deepEqual([r.datatableId, r.staged], ['pending:1', true]);
    assert.equal(d.calls.length, 0);
    assert.deepEqual(wrap._datatables.filter((t) => !t.pending).map((t) => t.id), ['tbl_old']);
});

test('_planDatatables: a listed name creates (with the plan\'s fields when the call has none); an unlisted name creates nothing', async () => {
    const d = deps();
    const wrap = { userId: 'u1', _datatables: [], _planDatatables: [{ name: 'Invoice', fields: [{ key: 'supplier', name: 'Supplier', type: 'text' }] }] };
    const ok = await applyCreateDatatable(wrap, { name: ' invoice ' }, d);
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.deepEqual(d.calls[0].fields.map((f) => f.key), ['supplier']);
    const no = await applyCreateDatatable(wrap, { name: 'Klanten', fields: [{ name: 'Naam', type: 'text' }] }, d);
    assert.match(no.error, /"Klanten" is not in the approved plan, so no table was created/);
    assert.match(no._fixHint, /Create only the tables the plan lists/);
    assert.equal(d.calls.length, 1);
});

test('a direct create runs the access check: an organisation mismatch and a missing permission refuse before anything is made', async () => {
    const d = deps();
    const mismatch = await applyCreateDatatable({ userId: 'u1', orgId: 'orgB', _datatables: [] }, { name: 'Nieuw', fields: [{ name: 'A', type: 'text' }] }, d);
    assert.equal(mismatch.code, 'datatable_org_mismatch');
    const denied = await applyCreateDatatable({ userId: 'u1', _datatables: [] }, { name: 'Nieuw', fields: [{ name: 'A', type: 'text' }] }, deps({ hasManageDatatables: async () => false }));
    assert.equal(denied.code, 'manage_datatables_required');
    const training = await applyCreateDatatable({ userId: 'u1', _req: {}, _datatables: [] }, { name: 'Nieuw', fields: [{ name: 'A', type: 'text' }] }, deps({ evaluateForRequest: async () => ({ datatables: { enforced: true, satisfied: false, courseTitle: 'T' } }) }));
    assert.equal(training.code, 'training_required');
    assert.equal(d.calls.length, 0);
});

test('the created id lands in the approved set and in the created list', async () => {
    const d = deps();
    const wrap = { userId: 'u1', _datatables: [], _approvedDatatableIds: new Set(), _createdDatatableIds: [] };
    const r = await applyCreateDatatable(wrap, { name: 'invoice', fields: [{ name: 'Supplier', type: 'text' }] }, d);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(wrap._approvedDatatableIds.has('tbl_new01'));
    assert.deepEqual(wrap._createdDatatableIds, ['tbl_new01']);
});

test('the same name: with an approval set the user must have chosen that table; with none (MCP) the existing table is returned', async () => {
    const existing = { id: 'tbl_old', name: 'Invoice', key: 'invoice', canWrite: true, columns: [{ key: 'supplier', type: 'text' }] };
    const gated = await applyCreateDatatable({ userId: 'u1', _datatables: [existing], _approvedDatatableIds: new Set() }, { name: 'invoice', fields: [{ name: 'X', type: 'text' }] }, deps());
    assert.equal(gated.code, 'datatable_choice_required');
    assert.ok(gated._askArgs);
    const chosen = await applyCreateDatatable({ userId: 'u1', _datatables: [existing], _approvedDatatableIds: new Set(['tbl_old']) }, { name: 'invoice', fields: [{ name: 'X', type: 'text' }] }, deps());
    assert.equal(chosen.datatableId, 'tbl_old');
    const mcp = await applyCreateDatatable({ userId: 'u1', _datatables: [existing] }, { name: 'invoice', fields: [{ name: 'X', type: 'text' }] }, deps());
    assert.equal(mcp.datatableId, 'tbl_old');
});

test('createPendingDatatable creates with exactKey and the reserved key', async () => {
    const d = deps();
    const entry = { name: 'Invoice', description: '', fields: [{ key: 'supplier', name: 'Supplier', type: 'text' }] };
    const r = await createPendingDatatable('u1', entry, { key: 'invoice_2', principal: { userId: 'u1' }, hasManage: true }, d);
    assert.equal(r.ok, true);
    assert.deepEqual([d.calls[0].key, d.calls[0].exactKey, d.calls[0].ownerUserId, d.calls[0].hasManageDatatables], ['invoice_2', true, 'u1', true]);
    assert.match(d.calls[0].description, /^Created by the automation builder for "Invoice"$/);
});
