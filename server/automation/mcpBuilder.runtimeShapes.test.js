/**
 * The builder's draftWrap carries the runtime shapes of the draft's tools.
 *
 * builderTools/refCheck.js and outputFields.js read
 * `draftWrap._runtimeShapes[tool]` — what the tool REALLY returned on this
 * user's last live run (shapeCache.js) — before the curated shape, but nothing
 * ever set it, so a path into a field only the real output has was refused
 * as unknown. Both builder surfaces (the chat route and MCP) now fill it at
 * the start of a turn through loadRuntimeShapes: one cache read per distinct
 * integration_action tool, in parallel, never an error.
 *
 * Run: cd server && node --test automation/mcpBuilder.runtimeShapes.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mcpBuilder = require('./mcpBuilder');

const { loadRuntimeShapes } = mcpBuilder;

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'ls', type: 'integration_action', tool: 'nextcloud_list_files' },
        { id: 'n', type: 'notification' },
        {
            id: 'lp', type: 'loop', overRef: 'steps.ls.output.items', itemVar: 'f',
            body: [{ id: 'rd', type: 'integration_action', tool: 'nextcloud_read_file' }, { id: 'ls2', type: 'integration_action', tool: 'nextcloud_list_files' }],
        },
        { id: 'par', type: 'parallel', branches: [[{ id: 'b1', type: 'integration_action', tool: 'gmail_send' }], { steps: [{ id: 'b2', type: 'integration_action', tool: 'talk_post' }] }] },
    ],
    layers: { sub: { steps: [{ id: 'l1', type: 'integration_action', tool: 'deck_create_card' }] } },
};

test('one read per distinct tool, anywhere in the draft; a tool without a shape is left out', async () => {
    const asked = [];
    const shapes = await loadRuntimeShapes(DEF, 'u1', {
        getShape: async ({ userId, toolName }) => {
            asked.push(`${userId}:${toolName}`);
            return toolName === 'gmail_send' ? null : { items: { _array: { name: 'string' }, _length: 2 } };
        },
    });
    assert.deepEqual(asked.sort(), ['u1:deck_create_card', 'u1:gmail_send', 'u1:nextcloud_list_files', 'u1:nextcloud_read_file', 'u1:talk_post']);
    assert.deepEqual(Object.keys(shapes).sort(), ['deck_create_card', 'nextcloud_list_files', 'nextcloud_read_file', 'talk_post']);
});

test('a cache that throws or hangs costs a shape, never the turn', async () => {
    const shapes = await loadRuntimeShapes(DEF, 'u1', {
        timeoutMs: 50,
        getShape: async ({ toolName }) => {
            if (toolName === 'nextcloud_read_file') throw new Error('redis down');
            if (toolName === 'talk_post') return new Promise(() => {});      // never answers
            return { ok: 'boolean' };
        },
    });
    assert.deepEqual(Object.keys(shapes).sort(), ['deck_create_card', 'gmail_send', 'nextcloud_list_files']);
});

test('an empty or missing draft asks nothing', async () => {
    let asked = 0;
    const getShape = async () => { asked++; return {}; };
    assert.deepEqual(await loadRuntimeShapes(null, 'u1', { getShape }), {});
    assert.deepEqual(await loadRuntimeShapes({ steps: [{ type: 'integration_action' }] }, 'u1', { getShape }), {});
    assert.equal(asked, 0);
});

test('loadDraft puts the shapes on the MCP draftWrap', async () => {
    const automationStore = require('../stores/automationStore');
    const shapeCache = require('./shapeCache');
    const builderCatalog = require('./builderCatalog');
    const saved = { get: automationStore.getAutomation, shape: shapeCache.getShape, cat: builderCatalog.buildCatalogForUser };
    automationStore.getAutomation = async () => ({ id: 'a1', userId: 'u1', title: 'T', definition: DEF });
    shapeCache.getShape = async ({ toolName }) => (toolName === 'nextcloud_list_files' ? { items: { _array: { name: 'string', etag: 'string' }, _length: 3 } } : null);
    builderCatalog.buildCatalogForUser = async () => ({ apps: [], toolNames: new Set() });
    try {
        const { draftWrap } = await mcpBuilder.loadDraft('a1', 'u1');
        assert.deepEqual(Object.keys(draftWrap._runtimeShapes), ['nextcloud_list_files']);
        assert.ok(draftWrap._runtimeShapes.nextcloud_list_files.items._array.etag);
    } finally {
        automationStore.getAutomation = saved.get;
        shapeCache.getShape = saved.shape;
        builderCatalog.buildCatalogForUser = saved.cat;
    }
});
