// @typecheck
/**
 * The design material app_inspect_catalog serves: the six layout archetypes and the worked
 * design example (designTopics.mts).
 *
 * Every skeleton is built here through the tools the model would use, on an empty draft: no
 * call is refused, none is repaired (`_hints`), and the result validates. So what the topic
 * shows is what the tools take.
 *
 * Run: node --test appStudio/builderPrompt/designTopics.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall } = require('../builderTools');
const { emptyDefinition, COMPONENT_SPECS } = require('../componentSpecs');
const { validateAppDefinition } = require('../validate');
const { buildSystemPrompt } = require('../builderPrompt');
const { askTopic } = require('./catalogDiet.mts');
const {
    LAYOUT_ARCHETYPES, DESIGN_EXAMPLE_CALLS, TABLE_PLACEHOLDER, renderLayoutsTopic, renderDesignExampleTopic, renderArchetype, renderSkeletonNode,
} = require('./designTopics.mts');

const freshWrap = () => ({ userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def: emptyDefinition('Design topics') });

/** A call that landed whole: no refusal, no repair, no failed entry. */
async function landed(tool, args, wrap) {
    const result = await applyToolCall(tool, args, wrap);
    assert.strictEqual(result.error, undefined, `${tool}: ${result.error} ${result._fixHint || ''}`);
    assert.deepEqual(result._hints || [], [], `${tool} was repaired: ${JSON.stringify(result._hints)}`);
    assert.deepEqual(result.failed || [], [], `${tool} failed entries: ${JSON.stringify(result.failed)}`);
    return result;
}

/** The table placeholder as an id the tools take. */
const withTable = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(TABLE_PLACEHOLDER)).join('"tbl_demo"'));

const errorsOf = (wrap) => validateAppDefinition(wrap.def).errors.filter((e) => !String(e.code || '').startsWith('data.'));

test('the six archetypes are the ones the prompt names, each with every part', () => {
    assert.deepEqual(LAYOUT_ARCHETYPES.map((a) => a.name), ['dashboard', 'list_detail', 'form_wizard', 'landing', 'kanban_board', 'report']);
    for (const a of LAYOUT_ARCHETYPES) {
        assert.ok(a.when && a.wire && a.vary && a.sections.length >= 1, a.name);
        assert.ok(renderArchetype(a).length < 4200, `${a.name} stays compact (${renderArchetype(a).length})`);
        assert.ok(a.sections.filter((s) => s.style?.height === 'fill').length <= 1, `${a.name}: one fill section at most`);
    }
});

for (const archetype of LAYOUT_ARCHETYPES) {
    test(`archetype ${archetype.name} builds through the tools as written`, async () => {
        const wrap = freshWrap();
        const screenId = wrap.def.screens[0].id;
        await landed('app_update_screen', { screenId, ...archetype.screen }, wrap);
        if (archetype.variables) await landed('app_set_variables', { variables: archetype.variables }, wrap);
        for (const [i, section] of archetype.sections.entries()) {
            let sectionId = wrap.def.screens[0].sections[0].id;
            if (i === 0) {
                if (section.style) await landed('app_update_section', { sectionId, style: section.style }, wrap);
            } else {
                ({ sectionId } = await landed('app_add_section', { screenId, ...(section.style ? { style: section.style } : {}) }, wrap));
            }
            const result = await landed('app_add_components', { parentId: sectionId, components: withTable(section.children) }, wrap);
            assert.ok(result.added.length >= section.children.length);
        }
        assert.deepEqual(errorsOf(wrap), []);
        // What was stored is what was written: every authored prop and style value survived.
        const stored = wrap.def.screens[0].sections.flatMap((s) => s.children);
        const authored = archetype.sections.flatMap((s) => withTable(s.children));
        const check = (a, b, path) => {
            assert.strictEqual(b.type, a.type, path);
            assert.ok(COMPONENT_SPECS[a.type], `${a.type} is a base type`);
            for (const [k, v] of Object.entries(a.props || {})) assert.deepEqual(b.props[k], v, `${path}.props.${k}`);
            for (const [k, v] of Object.entries(a.style || {})) assert.deepEqual(b.style[k], v, `${path}.style.${k}`);
            if (a.visibleWhen !== undefined) assert.deepEqual(b.visibleWhen, a.visibleWhen, `${path}.visibleWhen`);
            (a.children || []).forEach((child, i) => check(child, b.children[i], `${path}>${child.type}`));
        };
        authored.forEach((node, i) => check(node, stored[i], `${archetype.name}:${node.type}`));
    });
}

test('the layouts topic is served, holds every skeleton, and the prompt points at it', async () => {
    const served = (await applyToolCall('app_inspect_catalog', { components: ['topic:layouts'] }, freshWrap())).topics.layouts;
    assert.strictEqual(served, renderLayoutsTopic());
    for (const a of LAYOUT_ARCHETYPES) {
        assert.ok(served.includes(`(${a.name}).`), a.name);
        assert.ok(served.includes(renderSkeletonNode(a.sections[0].children[0])));
    }
    // One skeleton alone is a topic of its own.
    const one = (await applyToolCall('app_inspect_catalog', { components: ['topic:layout_kanban_board'] }, freshWrap())).topics.layout_kanban_board;
    assert.ok(one.includes('(kanban_board).') && !one.includes('(dashboard).') && one.length < served.length / 3);
    assert.ok(served.length < 16000, `the topic stays one readable answer (${served.length})`);
    const full = buildSystemPrompt({ ownerContext: 'note' });
    assert.ok(full.includes(askTopic('layouts')));
    assert.ok(!full.includes('Build every screen as one'), 'the single layout recipe is gone');
    assert.match(full, /stretches its FIRST grid row only/);
    const pointer = full.split('\n').find((l) => l.includes(askTopic('layouts')));
    for (const word of ['dashboard', 'list-detail', 'form wizard', 'landing', 'kanban board', 'report']) assert.ok(pointer.includes(word), word);
    // The small band's prompt is unchanged: it names neither topic.
    const core = buildSystemPrompt({ toolset: 'core', catalogMode: 'filtered' });
    assert.ok(!core.includes('topic:layouts') && !core.includes('topic:design_example'));
    assert.ok(!full.includes(served.slice(0, 80)), 'the skeletons are served, not cached');
});

test('the worked design example runs as written and is served on request only', async () => {
    const wrap = freshWrap();
    let sectionId = wrap.def.screens[0].sections[0].id;
    for (const [tool, args] of DESIGN_EXAMPLE_CALLS) {
        const full = { ...args };
        if (tool === 'app_add_section') full.screenId = wrap.def.screens[0].id;
        if (tool === 'app_update_section') full.sectionId = sectionId;
        if (tool === 'app_add_components') full.parentId = sectionId;
        const result = await landed(tool, full, wrap);
        if (tool === 'app_add_section') sectionId = result.sectionId;
    }
    assert.deepEqual(errorsOf(wrap), []);
    assert.strictEqual(wrap.def.design.preset, 'field');
    assert.strictEqual(wrap.def.theme.primary, '#C2410C');
    const served = (await applyToolCall('app_inspect_catalog', { steps: ['topic:design_example'] }, freshWrap())).topics.design_example;
    assert.strictEqual(served, renderDesignExampleTopic());
    assert.match(served, /signatureMoves:\[/);
    const full = buildSystemPrompt({ ownerContext: 'note' });
    assert.ok(full.includes(askTopic('design_example')));
    assert.ok(!full.includes('maintenance crew'), 'the example is not in the cached prompt');
});
