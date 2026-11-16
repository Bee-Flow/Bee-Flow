'use strict';

/**
 * app_wrap_nodes and app_unwrap_node (wrapTools.mts) through the builder's own dispatch: a wrap
 * groups siblings into one new card or container where the first of them stood, an unwrap puts
 * the children of a box back in its place. Ids and wiring survive both.
 *
 * Run: cd server && node --test appStudio/builderTools/wrapTools.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, MUTATING_TOOLS } = require('../builderTools');
const { canonicalizeAppDefinition } = require('../canonicalize');

const text = (id, span = 4) => ({ id, type: 'text', props: { text: id }, style: { span } });

function draft() {
    const def = canonicalizeAppDefinition({
        schemaVersion: 2,
        meta: { name: 'Wrap tools' },
        screens: [{ id: 'scr_aaa111', name: 'A', sections: [
            { id: 'sec_one111', children: [
                text('cmp_aaa111'),
                { id: 'cmp_btn111', type: 'button', props: { label: 'Go' }, style: { span: 4 }, onClick: 'act_one111' },
                text('cmp_ccc111'),
                { id: 'cmp_crd111', type: 'card', props: { title: 'Box' }, style: { span: 12 }, children: [text('cmp_in1111', 6), text('cmp_in2222', 6)] },
            ] },
        ] }],
        actions: { act_one111: { kind: 'sequence', steps: [{ kind: 'toast', message: 'Hi' }] } },
    }).def;
    return { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def };
}

const childIds = (holder) => (holder.children || []).map((n) => n.id);
const section = (wrap) => wrap.def.screens[0].sections[0];

test('the two tools are mutating registry tools', () => {
    assert.ok(MUTATING_TOOLS.has('app_wrap_nodes'));
    assert.ok(MUTATING_TOOLS.has('app_unwrap_node'));
});

test('a wrap puts the siblings in one card at the place of the first, in screen order, wiring kept', async () => {
    const wrap = draft();
    const r = await applyToolCall('app_wrap_nodes', { ids: ['cmp_ccc111', 'cmp_btn111'], props: { title: 'Actions' } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepEqual(r.wrapped, ['cmp_btn111', 'cmp_ccc111']);
    assert.deepEqual(childIds(section(wrap)), ['cmp_aaa111', r.containerId, 'cmp_crd111']);
    const box = section(wrap).children[1];
    assert.equal(box.type, 'card');
    assert.equal(box.props.title, 'Actions');
    assert.equal(box.style.span, 12);
    assert.deepEqual(childIds(box), ['cmp_btn111', 'cmp_ccc111']);
    assert.equal(box.children[0].onClick, 'act_one111');
});

test('a wrap into a container takes its look and span; ids under different parents are refused', async () => {
    const wrap = draft();
    const r = await applyToolCall('app_wrap_nodes', { ids: ['cmp_in1111', 'cmp_in2222'], type: 'container', props: { look: 'panel' }, style: { span: 8 } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const card = section(wrap).children[3];
    assert.deepEqual(childIds(card), [r.containerId]);
    assert.equal(card.children[0].props.look, 'panel');
    assert.equal(card.children[0].style.span, 8);

    const before = JSON.stringify(wrap.def);
    const bad = await applyToolCall('app_wrap_nodes', { ids: ['cmp_aaa111', r.containerId] }, wrap);
    assert.match(bad.error, /share one parent/);
    const unknown = await applyToolCall('app_wrap_nodes', { ids: ['cmp_nope11'] }, wrap);
    assert.match(unknown.error, /Unknown component id/);
    const badType = await applyToolCall('app_wrap_nodes', { ids: ['cmp_aaa111'], type: 'form' }, wrap);
    assert.match(badType.error, /type is card or container/);
    assert.equal(JSON.stringify(wrap.def), before, 'a refused call changes nothing');
});

test('an unwrap puts the children of a card in its place; a form is refused', async () => {
    const wrap = draft();
    const r = await applyToolCall('app_unwrap_node', { id: 'cmp_crd111' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepEqual(r.children, ['cmp_in1111', 'cmp_in2222']);
    assert.deepEqual(childIds(section(wrap)), ['cmp_aaa111', 'cmp_btn111', 'cmp_ccc111', 'cmp_in1111', 'cmp_in2222']);

    const notABox = await applyToolCall('app_unwrap_node', { id: 'cmp_aaa111' }, wrap);
    assert.match(notABox.error, /only a card, container, pane can be unwrapped/);
});

test('wrap then unwrap gives the tree back', async () => {
    const wrap = draft();
    const before = childIds(section(wrap));
    const r = await applyToolCall('app_wrap_nodes', { ids: ['cmp_aaa111', 'cmp_btn111'] }, wrap);
    await applyToolCall('app_unwrap_node', { id: r.containerId }, wrap);
    assert.deepEqual(childIds(section(wrap)), before);
});
