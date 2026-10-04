/**
 * App Studio — templateCapture (turning a live app into a reusable template).
 *
 * The rules worth pinning are the ones that decide whether a template installs
 * CLEAN somewhere else: what gets scrubbed (automation ids, system columns, file
 * values, dangling relations), what deliberately does not (connector names),
 * and that a definition with validation errors is refused rather than saved as
 * a template that breaks on install.
 *
 * The seed rules carry the privacy weight: this feature exists for an app whose
 * data model holds a 65-row material list in the same place as its customers'
 * purchase orders, so "no rows unless a table was named" is a contract, not a
 * default.
 *
 * Run: cd server && node --test appStudio/templateCapture.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { captureTemplate, _buildSeed, _scrubAutomationIds, _collectConnectorIds } = require('./templateCapture');
const { canonicalizeDataModel } = require('./dataModel');
const { emptyDefinition } = require('./componentSpecs');

// ── Fixtures ───────────────────────────────────────────────────────────────

function baseDefinition() {
    const def = emptyDefinition('Source app');
    def.actions = {
        act_run: { kind: 'run_automation', automationId: 'auto-live-123' },
    };
    return def;
}

function baseModel() {
    return canonicalizeDataModel({
        tables: [
            {
                id: 'tbl_a', key: 'people', name: 'People',
                fields: [
                    { id: 'fld_1', key: 'name', type: 'text' },
                    { id: 'fld_2', key: 'avatar', type: 'file' },
                    { id: 'fld_3', key: 'label', type: 'computed', computed: { expr: "'x'", type: 'text' } },
                ],
            },
            {
                id: 'tbl_b', key: 'notes', name: 'Notes',
                fields: [
                    { id: 'fld_4', key: 'body', type: 'text' },
                    { id: 'fld_5', key: 'person', type: 'relation', relation: { table: 'tbl_a' } },
                ],
            },
        ],
    }).model;
}

const LIVE_ROWS = {
    tbl_a: [{
        id: 'rec_ada', org_id: 'org-1', created_by: 'user-1', created_at: '2026-01-01',
        name: 'Ada', avatar: 'att_9', label: 'derived',
    }],
    tbl_b: [
        { id: 'rec_n1', body: 'linked', person: 'rec_ada' },
        { id: 'rec_n2', body: 'orphan', person: 'rec_not_captured' },
    ],
};

// ── The scrub ──────────────────────────────────────────────────────────────

test('a live automation id never reaches the template', () => {
    const def = baseDefinition();
    const cut = _scrubAutomationIds(def);
    assert.deepEqual(cut, ['auto-live-123']);
    assert.equal(def.actions.act_run.automationId, null,
        'templates ship automationId:null so the installer wires their own automation');
});

test('connector names are kept, not scrubbed, and reported as a requirement', () => {
    const def = baseDefinition();
    def.actions.act_mail = {
        kind: 'send_email', connectorId: 'conn_qimail', to: 'a@b.nl', subject: 's', body: 'b',
    };
    assert.deepEqual(_collectConnectorIds(def), ['conn_qimail'],
        'a connectorId is a stable NAME in a template — rewriting it would break the source app');
});

test('the captured definition is renamed to the template, not the source app', () => {
    const out = captureTemplate({ definition: baseDefinition(), meta: { title: 'Intake starter' } });
    assert.equal(out.ok, true);
    assert.equal(out.template.definition.meta.name, 'Intake starter');
    assert.equal(out.template.title, 'Intake starter');
});

test('a title is required', () => {
    const out = captureTemplate({ definition: baseDefinition(), meta: { title: '   ' } });
    assert.equal(out.ok, false);
    assert.match(out.errors[0], /title is required/i);
});

// ── The seed ───────────────────────────────────────────────────────────────

test('no seedTables means no rows travel', () => {
    const out = captureTemplate({
        definition: baseDefinition(), dataModel: baseModel(), rowsByTable: {}, meta: { title: 'T' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.template.seed, undefined, 'a template with no named tables carries no data at all');
    assert.equal(out.report.seededRows, 0);
});

test('seed rows lose system columns, file values and computed fields', () => {
    const { seed } = _buildSeed(baseModel(), LIVE_ROWS, 100);
    const row = seed.tbl_a[0];
    for (const key of ['id', 'org_id', 'created_by', 'created_at']) {
        assert.equal(key in row, false, `${key} is stamped by writeRecord, never seeded`);
    }
    assert.equal('avatar' in row, false, 'a file value points at attachment bytes that do not travel');
    assert.equal('label' in row, false, 'a computed field is derived, never seeded');
    assert.equal(row.name, 'Ada');
    assert.equal(row.$id, 'people_1', 'the alias is what a child row points at');
});

test('a relation becomes a $ref when its parent travelled, and null when it did not', () => {
    const { seed } = _buildSeed(baseModel(), LIVE_ROWS, 100);
    assert.deepEqual(seed.tbl_b[0].person, { $ref: 'people_1' },
        'templateInstall rewrites $ref to the newly-seeded parent id');
    assert.equal(seed.tbl_b[1].person, null,
        'a rec_ id from another database is worse than an honest empty');
});

test('the per-table seed ceiling is enforced', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `rec_${i}`, name: `P${i}` }));
    const { seed, counts } = _buildSeed(baseModel(), { tbl_a: rows }, 100);
    assert.equal(seed.tbl_a.length, 100);
    assert.equal(counts.tbl_a, 100);
});

test('the local seed ceiling still agrees with the installer', () => {
    const { DEFAULT_MAX_SEED_ROWS } = require('./templateCapture');
    const { MAX_SEED_ROWS_PER_TABLE } = require('./templateInstall');
    assert.equal(DEFAULT_MAX_SEED_ROWS, MAX_SEED_ROWS_PER_TABLE,
        'capture and install must cap seeds at the same number or a template silently loses rows');
});

// ── The gate ───────────────────────────────────────────────────────────────

test('a definition with validation errors is refused', () => {
    const def = baseDefinition();
    // A grid bound to a table the model does not have — binding.unknown_table.
    def.screens[0].sections[0].children.push({
        id: 'cmp_bad', type: 'table',
        props: { source: { kind: 'records', tableId: 'tbl_gone' }, columns: [{ key: 'name', label: 'Name' }] },
        style: { span: 12 }, visible: true,
    });
    const out = captureTemplate({ definition: def, dataModel: baseModel(), meta: { title: 'Broken' } });
    assert.equal(out.ok, false, 'a template that installs broken is worse than no template');
    assert.match(out.errors[0], /binding\.unknown_table/);
});

test('a clean capture reports what the installer must supply', () => {
    const def = baseDefinition();
    def.actions.act_mail = {
        kind: 'send_email', connectorId: 'conn_qimail', to: 'a@b.nl', subject: 's', body: 'b',
    };
    const out = captureTemplate({
        definition: def, dataModel: baseModel(), rowsByTable: LIVE_ROWS, meta: { title: 'T' },
    });
    assert.equal(out.ok, true);
    const kinds = out.report.requires.map((r) => r.kind);
    assert.ok(kinds.includes('automation'), 'cleared automations are reported, not hidden');
    assert.ok(kinds.includes('connector'), 'the mailbox the installer has to create is named');
    assert.equal(out.report.tables, 2);
    assert.equal(out.report.seededRows, 3);
});

test('the template keeps the shape templates.js entries have', () => {
    const out = captureTemplate({
        definition: baseDefinition(), dataModel: baseModel(), rowsByTable: LIVE_ROWS,
        meta: { title: 'T', description: 'Does a thing', category: 'Sales', icon: 'Mail', tags: ['a', 'a', 'b'] },
    });
    assert.equal(out.ok, true);
    const t = out.template;
    assert.equal(t.version, 1);
    assert.equal(t.category, 'Sales');
    assert.equal(t.icon, 'Mail');
    assert.deepEqual(t.tags, ['a', 'b'], 'tags dedupe');
    assert.ok(t.definition && Array.isArray(t.definition.screens));
    assert.ok(t.dataModel && Array.isArray(t.dataModel.tables));
    assert.ok(t.seed && typeof t.seed === 'object');
});

test('capture never mutates the caller\'s live definition', () => {
    const def = baseDefinition();
    captureTemplate({ definition: def, meta: { title: 'T' } });
    assert.equal(def.actions.act_run.automationId, 'auto-live-123',
        'the draft the rest of the request is using must be untouched');
    assert.equal(def.meta.name, 'Source app');
});
