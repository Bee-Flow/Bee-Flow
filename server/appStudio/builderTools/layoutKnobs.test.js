/**
 * Layout v2 through the AI builder's existing tools: the knobs of the placement and
 * grid_columns groups are written with app_add_components, app_update_component,
 * app_add_section and app_update_section, read back with app_inspect_catalog, and listed in
 * the prompt's extension index.
 *
 * Run: cd server && node --test appStudio/builderTools/layoutKnobs.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall } = require('../builderTools');
const { applyInspectCatalog } = require('./inspectionTools');
const { emptyDefinition } = require('../componentSpecs');
const { extensionItems } = require('../catalogTiers.mts');
const { renderExtensionIndex } = require('../builderPrompt/extensionIndex.mts');
const ops = require('../../shared/appDefinition/definitionOps.mjs');

const draft = () => ({ userId: 'u1', def: emptyDefinition('Layout'), dataModel: { tables: [] }, datasetIds: [] });
const KNOBS = ['spanMd', 'spanSm', 'rowSpan', 'alignSelf', 'sticky', 'stickyOffset', 'columns', 'responsive'];

test('the component tools write the placement knobs and a container column count', async () => {
    const wrap = draft();
    const parentId = wrap.def.screens[0].sections[0].id;
    const added = await applyToolCall('app_add_components', { parentId, components: [
        { tempId: 'card', type: 'card', props: { title: 'Totals' }, style: { span: 8, rowSpan: 2, columns: 4, responsive: 'manual' } },
        { tempId: 'side', type: 'stat', props: { label: 'Open', value: 3 }, style: { span: 4, spanMd: 6, spanSm: 6, sticky: 'top', stickyOffset: 2 } },
    ] }, wrap);
    assert.ok(!added.error, JSON.stringify(added));
    const card = ops.findNode(wrap.def, added.ids.card).node;
    assert.deepEqual([card.style.rowSpan, card.style.columns, card.style.responsive], [2, 4, 'manual']);
    const side = ops.findNode(wrap.def, added.ids.side).node;
    assert.deepEqual([side.style.spanMd, side.style.spanSm, side.style.sticky, side.style.stickyOffset], [6, 6, 'top', 2]);
    assert.equal(wrap.def.schemaVersion, 3);

    const updated = await applyToolCall('app_update_component', { id: added.ids.side, style: { alignSelf: 'start', spanMd: null } }, wrap);
    assert.ok(!updated.error, JSON.stringify(updated));
    const after = ops.findNode(wrap.def, added.ids.side).node;
    assert.equal(after.style.alignSelf, 'start');
    assert.equal(Object.hasOwn(after.style, 'spanMd'), false, 'null clears the knob');
    assert.equal(after.style.spanSm, 6, 'an untouched knob survives the merge');
});

test('the section tools write columns and responsive', async () => {
    const wrap = draft();
    const screenId = wrap.def.screens[0].id;
    const added = await applyToolCall('app_add_section', { screenId, style: { columns: 5 } }, wrap);
    assert.ok(!added.error, JSON.stringify(added));
    assert.equal(ops.findSection(wrap.def, added.sectionId).section.style.columns, 5);

    const updated = await applyToolCall('app_update_section', { sectionId: added.sectionId, style: { columns: null, responsive: 'manual' } }, wrap);
    assert.ok(!updated.error, JSON.stringify(updated));
    const { style } = ops.findSection(wrap.def, added.sectionId).section;
    assert.equal(Object.hasOwn(style, 'columns'), false);
    assert.equal(style.responsive, 'manual');
});

test('a draft that uses none of the knobs keeps the base schema version', async () => {
    const wrap = draft();
    const parentId = wrap.def.screens[0].sections[0].id;
    await applyToolCall('app_add_components', { parentId, components: [{ type: 'heading', props: { text: 'Plain' }, style: { span: 6 } }] }, wrap);
    assert.equal(wrap.def.schemaVersion, 2);
});

test('app_inspect_catalog serves every layout knob with its range and how to use it', () => {
    const names = extensionItems().filter((item) => item.family === 'styleKnobs').map((item) => item.name);
    for (const knob of KNOBS) assert.ok(names.includes(knob), `${knob} is an extension style knob`);

    const out = applyInspectCatalog({ extensions: KNOBS });
    const text = JSON.stringify(out);
    assert.match(text, /style\.spanMd\(1\.\.12\)/);
    assert.match(text, /style\.rowSpan\(1\.\.6\)/);
    assert.match(text, /style\.sticky\(none\|top\|bottom\)/);
    assert.match(text, /style\.columns\(1\.\.12\)/);
    assert.match(text, /style\.responsive\(auto\|manual\)/);
    assert.match(text, /on every type whose style line includes `span`/);
    assert.match(text, /on every type whose style line includes `gap`/);
    assert.match(text, /section, card, container, form, tab, modal and repeater/);

    const index = renderExtensionIndex();
    for (const knob of KNOBS) assert.ok(index.includes(knob), `the extension index lists ${knob}`);
});
