'use strict';

/**
 * app_add_components: a card chain resent over its landed twins is merged all
 * the way down to LIMITS.MAX_DEPTH, not built a second time below depth 5.
 *
 * Run: node --test appStudio/builderTools.shellMerge.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall } = require('./builderTools');
const { emptyDefinition } = require('./componentSpecs');
const ops = require('./definitionOps');

const freshWrap = () => ({ userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def: emptyDefinition('Test app') });
const homeSectionId = (wrap) => wrap.def.screens[0].sections[0].id;

test('app_add_components: a resent card chain merges into its landed twins down to the maximum depth', async () => {
    // Eight nested cards (the deepest nesting the builder takes,
    // LIMITS.MAX_DEPTH): the shell-merge used to stop at depth 5, so the
    // innermost cards were built a second time on a resend.
    const chain = (leafType) => {
        let node = { type: 'stat', props: { label: 'Leaf', value: 1 } };
        if (leafType) node = { type: leafType, props: { label: 'Leaf', value: 1 } };
        for (let d = 8; d >= 1; d--) node = { type: 'card', props: { title: `Level ${d}` }, children: [node] };
        return node;
    };
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const first = await applyToolCall('app_add_components', { parentId, components: [chain('sttat')] }, wrap);
    assert.ok(first.failed && first.failed.length === 1, JSON.stringify(first));
    const again = await applyToolCall('app_add_components', { parentId, components: [chain(null)] }, wrap);
    assert.ok(!again.error, JSON.stringify(again));
    assert.deepEqual(again.added.map((a) => a.type), ['stat'], 'only the leaf is new');
    const countCards = (nodes) => nodes.reduce((n, c) => n + (c.type === 'card' ? 1 : 0) + countCards(c.children || []), 0);
    assert.equal(countCards(ops.findSection(wrap.def, parentId).section.children), 8, 'no card was built twice');
});

