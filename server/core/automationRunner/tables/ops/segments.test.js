'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');
const { slug } = require('./segments');

const mk = (n, extra) => Array.from({ length: n }, (_, i) => ({ id: i, group: i < n * 0.6 ? 'Alpha' : 'Beta', tags: i % 2 ? 'a;b' : 'b', rare: i === 0 ? 'only' : 'common', ...extra }));
const DATA = mk(50);

test('groups lists the total and every value; usable segments carry rules', async () => {
    const { rows, result, keys } = await run([{ op: 'groups', minN: 5, splits: [{ column: 'group' }] }], DATA);
    assert.deepEqual(keys, ['segment', 'label', 'column', 'value', 'n', 'suppressed']);
    assert.deepEqual(rows.map((r) => [r.segment, r.n]), [['all', 50], ['group-alpha', 30], ['group-beta', 20]]);
    assert.equal(rows[0].label, 'All');
    assert.deepEqual(result.segments[1], { id: 'group-alpha', label: 'group: Alpha', column: 'group', value: 'Alpha', n: 30, rules: [{ column: 'group', test: 'equals', value: 'Alpha' }] });
    assert.deepEqual(result.segments[0].rules, []);
});

test('groups multi-answer columns count membership and produce contains_item rules', async () => {
    const { rows, result } = await run([{ op: 'groups', minN: 5, includeTotal: false, splits: [{ column: 'tags', separator: ';', label: 'Tag' }] }], DATA);
    assert.deepEqual(rows.map((r) => [r.value, r.n]), [['b', 50], ['a', 25]]);
    assert.deepEqual(result.segments[1].rules, [{ column: 'tags', test: 'contains_item', value: 'a', separator: ';' }]);
    assert.equal(result.segments[1].label, 'Tag: a');
});

test('groups lists chosen values in the given order', async () => {
    const { rows } = await run([{ op: 'groups', minN: 5, includeTotal: false, splits: [{ column: 'group', values: ['beta', 'ALPHA', 'gamma'] }] }], DATA);
    assert.deepEqual(rows.map((r) => r.value), ['beta', 'ALPHA']);
    assert.deepEqual(rows.map((r) => r.n), [20, 30]);
});

test('groups hides the size of small segments and leaves them out of segments', async () => {
    const { rows, result } = await run([{ op: 'groups', minN: 5, splits: [{ column: 'rare' }] }], DATA);
    const rare = rows.find((r) => r.value === 'only');
    assert.deepEqual([rare.n, rare.suppressed], [null, true]);
    assert.ok(!result.segments.some((s) => s.value === 'only'));
    assert.ok(result.warningCodes.includes('groups_suppressed'));
    assert.ok(!JSON.stringify(result.warnings).includes('1 row'));
});

test('groups: the organisation floor wins over a lower step minimum', async () => {
    const low = await run([{ op: 'groups', minN: 1, splits: [{ column: 'group' }] }], DATA, { minGroupFloor: 25 });
    assert.deepEqual(low.rows.map((r) => r.suppressed), [false, false, true]);
    const zero = await run([{ op: 'groups', minN: 0, splits: [{ column: 'group' }] }], DATA, { minGroupFloor: 25 });
    assert.deepEqual(zero.rows.map((r) => r.suppressed), [false, false, true]);
});

test('groups caps the usable segments', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ k: `v${i % 8}` }));
    const { result, rows } = await run([{ op: 'groups', minN: 1, splits: [{ column: 'k' }] }], data, { limits: { maxSegments: 3 } });
    assert.equal(result.segments.length, 3);
    assert.equal(rows.length, 9);
    assert.ok(result.warningCodes.includes('segments_capped'));
});

test('groups segment rules work as rulesFrom of a later filter', async () => {
    const first = await run([{ op: 'groups', minN: 5, splits: [{ column: 'group' }] }], DATA);
    const seg = first.result.segments.find((s) => s.value === 'Beta');
    const filtered = await run([{ op: 'filter', rulesFrom: { kind: 'ref', path: 'item.rules' } }], DATA, { runState: { vars: {}, item: seg } });
    assert.equal(filtered.rows.length, seg.n);
});

test('groups ids are stable slugs and stay unique', async () => {
    assert.equal(slug('group=Café Ünï'), 'group-cafe-uni');
    const data = Array.from({ length: 10 }, (_, i) => ({ k: i % 2 ? 'A b' : 'a-b' }));
    const { result } = await run([{ op: 'groups', minN: 1, includeTotal: false, splits: [{ column: 'k' }] }], data);
    assert.equal(new Set(result.segments.map((s) => s.id)).size, 2);
});

test('groups needs splits on known columns, and honours the group cap', async () => {
    await assert.rejects(run([{ op: 'groups', splits: [] }], DATA), (e) => e.errorClass === 'table_op_invalid');
    await assert.rejects(run([{ op: 'groups', splits: [{ column: 'ghost' }] }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.field === 'splits[0].column');
    await assert.rejects(run([{ op: 'groups', splits: [{ column: 'id' }] }], DATA, { limits: { maxGroups: 5 } }), (e) => e.errorClass === 'table_too_many_groups');
});
