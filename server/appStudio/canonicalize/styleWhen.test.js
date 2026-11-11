'use strict';

// Conditional style (package LK15): node.styleWhen and columns[].cellStyle are kept only when a
// usable rule is left, with only the knobs they may set, idempotent, schema version 3 only when
// used, refused by the validator in a form canonicalize would change, and settable through
// app_update_component.

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition, LIMITS } = require('../componentSpecs');
const { styleWhenKnobs } = require('./styleWhen.mts');
const { cleanCellStyle } = require('../componentSpecs/styleRuleShape');
const { applyToolCall } = require('../builderTools');

const rule = (expr, style) => ({ when: { kind: 'formula', expr }, style });

function withNodes(...nodes) {
    const def = emptyDefinition('Rules');
    def.screens[0].sections[0].children.push(...nodes);
    return def;
}
const stat = (extra) => ({ id: 'cmp_rule0001', type: 'stat', props: { label: 'Spent', value: { kind: 'static', value: 3 } }, style: { span: 6 }, ...extra });
const table = (column) => ({ id: 'cmp_rule0002', type: 'table', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'qty', ...column }] } });

const canon = (def) => canonicalizeAppDefinition(def);
const nodeOf = (out, i = 0) => out.def.screens[0].sections[0].children[i];
const codes = (findings) => findings.map((f) => `${f.code} @ ${f.path}`);

test('a node without styleWhen keeps its keys and the base version', () => {
    const def = withNodes(stat({}));
    const out = canon(def);
    assert.ok(!('styleWhen' in nodeOf(out)));
    assert.equal(out.def.schemaVersion, def.schemaVersion);
});

test('a rule keeps only the look knobs the type has; a bare string formula is wrapped; version 3', () => {
    const out = canon(withNodes(stat({ styleWhen: [{ when: 'vars.n > 3', style: { color: 'danger', span: 4, height: 'lg', shadow: 'md' } }] })));
    assert.deepEqual(nodeOf(out).styleWhen, [rule('vars.n > 3', { color: 'danger', shadow: 'md' })]);
    assert.equal(out.def.schemaVersion, 3);
    assert.ok(out.repairs.some((r) => r.code === 'style.unknown_key' && r.path.endsWith('styleWhen[0].style')));
    assert.equal(JSON.stringify(canon(out.def).def), JSON.stringify(out.def), 'a second pass changes nothing');
});

test('layout knobs are never conditional, whatever the type has', () => {
    for (const type of ['card', 'heading', 'button', 'container']) {
        const knobs = styleWhenKnobs(type);
        for (const layout of ['span', 'size', 'height', 'widthMode', 'heightMode', 'marginTop', 'spanMd', 'rowSpan', 'columns', 'padding', 'gap']) {
            assert.ok(!knobs.includes(layout), `${type}: ${layout}`);
        }
    }
    assert.deepEqual(styleWhenKnobs('no_such_type'), []);
});

test('a rule without a formula or without a usable knob is dropped; an empty list leaves the key out', () => {
    const out = canon(withNodes(stat({ styleWhen: [{ style: { color: 'info' } }, rule('true', { span: 3 }), rule('', { color: 'info' })] })));
    assert.ok(!('styleWhen' in nodeOf(out)));
    assert.equal(out.repairs.filter((r) => r.code === 'style_rules.rule_dropped').length, 3);
    const notList = canon(withNodes(stat({ styleWhen: { when: 'true' } })));
    assert.ok(!('styleWhen' in nodeOf(notList)));
    assert.ok(notList.repairs.some((r) => r.code === 'style_rules.invalid'));
});

test('at most MAX_STYLE_WHEN_RULES rules are kept', () => {
    const many = Array.from({ length: LIMITS.MAX_STYLE_WHEN_RULES + 2 }, (_, i) => rule(`vars.n > ${i}`, { color: 'info' }));
    const out = canon(withNodes(stat({ styleWhen: many })));
    assert.equal(nodeOf(out).styleWhen.length, LIMITS.MAX_STYLE_WHEN_RULES);
    assert.equal(out.repairs.filter((r) => r.code === 'style_rules.too_many').length, 1);
});

test('cellStyle keeps color, backgroundColor and weight with a role or hex, and nothing else', () => {
    const pushed = [];
    const kept = cleanCellStyle([rule('value > 1', { color: '#047857', backgroundColor: 'warning', weight: 'bold', opacity: 50 }), rule('true', { color: 'purple' })], (c) => pushed.push(c), 'p');
    assert.deepEqual(kept, [rule('value > 1', { color: '#047857', backgroundColor: 'warning', weight: 'bold' })]);
    assert.deepEqual(pushed, ['style_rules.knob_dropped', 'style_rules.knob_dropped', 'style_rules.rule_dropped']);
    const out = canon(withNodes(table({ cellStyle: [{ when: 'value == 0', style: { backgroundColor: 'danger' } }] })));
    assert.deepEqual(nodeOf(out).props.columns[0].cellStyle, [rule('value == 0', { backgroundColor: 'danger' })]);
    assert.equal(out.def.schemaVersion, 3);
    const none = canon(withNodes(table({ cellStyle: null })));
    assert.deepEqual(Object.keys(nodeOf(none).props.columns[0]), ['key']);
});

test('the validator refuses a rule list canonicalize would change and checks every formula', () => {
    const def = canon(withNodes(stat({ styleWhen: [rule('vars.n ==', { color: 'info' })] }), table({ cellStyle: [rule('value >', { color: 'info' })] }))).def;
    const v = validateAppDefinition(def);
    assert.deepEqual(codes(v.errors).filter((c) => c.includes('when.expr')), [
        'formula.parse_error @ screens[0].sections[0].children[0].styleWhen[0].when.expr',
        'formula.parse_error @ screens[0].sections[0].children[1].props.columns[0].cellStyle[0].when.expr',
    ]);
    def.screens[0].sections[0].children[0].styleWhen = [rule('vars.n > 1', { span: 3, color: 'info' })];
    assert.ok(codes(validateAppDefinition(def).errors).some((c) => c.startsWith('node.style_when_invalid @ screens[0].sections[0].children[0].styleWhen[0].style')));
});

test('app_update_component sets styleWhen and null removes it', async () => {
    const wrap = { def: canon(withNodes(stat({}))).def, dataModel: { tables: [] } };
    const set = await applyToolCall('app_update_component', { id: 'cmp_rule0001', styleWhen: [{ when: 'vars.n > 2', style: { color: 'warning' } }] }, wrap);
    assert.ok(!set.error, set.error);
    assert.deepEqual(nodeOf(wrap).styleWhen, [rule('vars.n > 2', { color: 'warning' })]);
    assert.deepEqual(set.component.styleWhen, nodeOf(wrap).styleWhen);
    const bad = await applyToolCall('app_update_component', { id: 'cmp_rule0001', styleWhen: 'vars.n > 2' }, wrap);
    assert.match(String(bad.error), /styleWhen must be a list/);
    await applyToolCall('app_update_component', { id: 'cmp_rule0001', styleWhen: null }, wrap);
    assert.ok(!('styleWhen' in nodeOf(wrap)));
});
