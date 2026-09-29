/**
 * Three ways a datatable step was written that the builder could not read —
 * all three from live builds on 2026-09-16, all three ending in the repeat
 * ladder with nothing on the canvas.
 *
 *  1. The filter as ONE condition object spelled another way:
 *     `where: {column:"status", operator:"equals", value:"New"}`. The
 *     column-keyed reading turned its KEYS into column names, so the step was
 *     refused for a column called "column" — three times.
 *  2. `sort: [{column:"ai_score", direction:"desc"}]`. Re-keyed to a column
 *     named `undefined`; the rows came back in no particular order.
 *  3. The whole step handed to builder_add_action, which answered "add a
 *     `tool` name from the catalog" — advice a datatable step cannot follow.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/datatableShapes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { sanitizeDatatableBindings, coerceSortList } = require('./stepBuilders');

const TABLE = {
    id: 'tbl_73e0363d7f36', key: 'ai_resume_screener', name: 'AI Resume Screener', canWrite: true,
    columns: [
        { key: 'candidate_name', name: 'Candidate Name', type: 'text' },
        { key: 'ai_summary', name: 'AI Summary', type: 'text' },
        { key: 'ai_score', name: 'AI Score', type: 'number' },
        { key: 'status', name: 'Status', type: 'text' },
    ],
};

const DRAFT = { steps: [] };
const sanitize = (raw) => sanitizeDatatableBindings({ values: {}, ...raw }, DRAFT);

async function wrapWithTable() {
    const dw = { userId: 'u_test', def: emptyDefinition(), _datatables: [TABLE] };
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    return dw;
}

// ── 1. one condition, spelled otherwise ─────────────────────────────

test('{column, operator, value} is ONE condition, not three columns', () => {
    const out = sanitize({ where: { column: 'status', operator: 'equals', value: 'New' } });
    assert.strictEqual(out.where.length, 1, JSON.stringify(out.where));
    assert.strictEqual(out.where[0].field, 'status');
    assert.strictEqual(out.where[0].op, 'eq');
    assert.deepStrictEqual(out.where[0].value, { kind: 'literal', value: 'New' });
});

test('the operator words a model uses all land on the stored ones', () => {
    const cases = [['equals', 'eq'], ['==', 'eq'], ['!=', 'neq'], ['not_equals', 'neq'], ['greater_than', 'gt'],
        ['>=', 'gte'], ['<', 'lt'], ['contains', 'contains'], ['starts_with', 'startsWith'], ['in', 'in']];
    for (const [written, stored] of cases) {
        const out = sanitize({ where: { column: 'ai_score', operator: written, value: 5 } });
        assert.strictEqual(out.where[0].op, stored, `${written} → ${out.where[0].op}`);
    }
});

test('the same spelling inside a LIST is read too', () => {
    const out = sanitize({ where: [{ column: 'status', operator: '==', value: 'New' }] });
    assert.deepStrictEqual(out.where.map((w) => [w.field, w.op]), [['status', 'eq']]);
});

test('the column-keyed map still works, and the stored shape is untouched', () => {
    assert.strictEqual(sanitize({ where: { status: 'New' } }).where[0].field, 'status');
    const already = sanitize({ where: [{ field: 'status', op: 'eq', value: 'New' }] });
    assert.deepStrictEqual(already.where.map((w) => [w.field, w.op]), [['status', 'eq']]);
    assert.strictEqual((already.repairs || []).filter((r) => r.startsWith('where:')).length, 0, 'nothing to report');
});

test('the translation is reported, naming what was renamed', () => {
    const note = (sanitize({ where: { column: 'status', operator: 'equals', value: 'New' } }).repairs || [])
        .find((r) => r.startsWith('where:'));
    assert.ok(note, 'a note is written');
    assert.match(note, /ONE condition on "status"/);
    assert.match(note, /LIST of \{field, op, value\}/);
});

test('an object that is neither shape is still no filter', () => {
    assert.deepStrictEqual(sanitize({ where: 'nonsense' }).where, []);
    assert.deepStrictEqual(sanitize({ where: null }).where, []);
});

// ── 2. sort ─────────────────────────────────────────────────────────

test('sort {column, direction} becomes {field, dir}', () => {
    const { list, note } = coerceSortList([{ column: 'ai_score', direction: 'desc' }]);
    assert.deepStrictEqual(list, [{ field: 'ai_score', dir: 'desc' }]);
    assert.match(note, /column→field/);
    assert.match(note, /direction→dir/);
});

test('sort words that are not asc/desc are read as one of the two', () => {
    assert.strictEqual(coerceSortList([{ field: 'ai_score', dir: 'descending' }]).list[0].dir, 'desc');
    assert.strictEqual(coerceSortList([{ column: 'ai_score', order: 'DESC' }]).list[0].dir, 'desc');
    assert.strictEqual(coerceSortList([{ column: 'ai_score' }]).list[0].dir, 'asc', 'no direction means ascending');
});

test('a sort that is already right is returned unchanged and unreported', () => {
    const { list, note } = coerceSortList([{ field: 'ai_score', dir: 'desc' }]);
    assert.deepStrictEqual(list, [{ field: 'ai_score', dir: 'desc' }]);
    assert.strictEqual(note, null);
});

test('a lone sort object or a bare column name is the one-entry list', () => {
    assert.deepStrictEqual(coerceSortList({ column: 'ai_score', direction: 'desc' }).list, [{ field: 'ai_score', dir: 'desc' }]);
    assert.deepStrictEqual(coerceSortList('ai_score').list, [{ field: 'ai_score', dir: 'asc' }]);
});

// ── 3. the step sent to the wrong builder ───────────────────────────

test('builder_add_action with a datatable step builds the datatable step', async () => {
    const dw = await wrapWithTable();
    const r = await applyToolCall('builder_add_action', {
        tempId: 'find_candidate',
        type: 'datatable',
        inputs: {
            datatableId: TABLE.id, datatableKey: TABLE.key, label: 'Find top New candidate',
            op: 'find_rows', limit: 1,
            where: [{ column: 'status', operator: '==', value: 'New' }],
            sort: [{ column: 'ai_score', direction: 'desc' }],
        },
    }, dw);

    assert.ok(!r.error, `the step must land, not ask for a tool name: ${JSON.stringify(r.error)}`);
    assert.strictEqual(r.added.type, 'datatable');
    assert.ok((r._warnings || []).some((w) => /builder_add_action is for integration tools only/.test(w)),
        `the redirect is named: ${JSON.stringify(r._warnings)}`);
    const step = dw.def.steps.find((s) => s.type === 'datatable');
    assert.deepStrictEqual(step.where.map((w) => [w.field, w.op]), [['status', 'eq']], 'the filter survived the redirect');
    assert.deepStrictEqual(step.sort, [{ field: 'ai_score', dir: 'desc' }], 'and so did the ordering');
});

test('a real integration action is untouched by the redirect', async () => {
    const dw = await wrapWithTable();
    dw._availableToolNames = new Set(['nextcloud_list_files']);
    const r = await applyToolCall('builder_add_action', {
        tempId: 'ls', tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/x' } },
    }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.added.type, 'integration_action');
});

test('a step that names no table still asks for a tool name', async () => {
    const dw = await wrapWithTable();
    dw._availableToolNames = new Set(['nextcloud_list_files']);
    const r = await applyToolCall('builder_add_action', { tempId: 'x', inputs: { path: '/x' } }, dw);
    assert.ok(r.error && /tool/.test(r.error), `unchanged for the case it was written for: ${JSON.stringify(r)}`);
});
