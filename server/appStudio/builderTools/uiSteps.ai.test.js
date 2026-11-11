/**
 * The AI builder reaches the browser steps of schema 3 and the `ui` root through the tools
 * it already has: app_inspect_catalog serves each step's full entry (with how to read the
 * ui root), and app_set_action stores a sequence that uses them as written.
 *
 * Run: cd server && node --test appStudio/builderTools/uiSteps.ai.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applySetActionTool } = require('./definitionTools/actions');
const { applyInspectCatalog } = require('./inspectionTools');
const { emptyDefinition } = require('../componentSpecs');

const UI_KINDS = ['back', 'copy_to_clipboard', 'focus', 'scroll_to', 'set_form_field', 'set_ui', 'wait'];

test('app_inspect_catalog answers every new browser step with its fields and how to use it', () => {
    const r = applyInspectCatalog({ extensions: UI_KINDS });
    const text = JSON.stringify(r);
    for (const kind of UI_KINDS) assert.ok(text.includes(kind), `${kind} answered: ${text.slice(0, 400)}`);
    assert.ok(!r.unknown, JSON.stringify(r.unknown));
    assert.match(text, /ui\.tabs\.<tabsId>\.active/);
    assert.match(text, /ui\.selection\.<gridId>/);
});

test('app_set_action stores a sequence of the new browser steps exactly as written', async () => {
    const wrap = { userId: 'u1', def: emptyDefinition('UI'), dataModel: { tables: [] }, datasetIds: [] };
    const steps = [
        { kind: 'set_ui', nodeId: 'cmp_tabs', state: 'activeTab', value: { kind: 'static', value: 'cmp_tab_b' } },
        { kind: 'set_form_field', form: 'order', field: 'quantity', value: { kind: 'formula', expr: 'ui.selection.cmp_grid[0].quantity' } },
        { kind: 'focus', nodeId: 'cmp_qty' },
        { kind: 'scroll_to', nodeId: 'top' },
        { kind: 'copy_to_clipboard', text: { kind: 'static', value: 'ORD-1' } },
        { kind: 'wait', seconds: 2 },
        { kind: 'back' },
    ];
    const r = await applySetActionTool(wrap, { action: { kind: 'sequence', steps } });
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepEqual(wrap.def.actions[r.actionId].steps, steps);
});
