/**
 * A chat-builder turn starts with the runtime shapes of the draft's tools on
 * the draftWrap.
 *
 * builderTools/refCheck.js and outputFields.js check a binding's path against
 * `draftWrap._runtimeShapes[tool]` (what the tool really returned on this
 * user's last live run, shapeCache.js) before the curated shape — but the
 * route never set it, so a path into a field only the real output carries
 * was refused as unknown in every chat build. A cache that fails must not
 * cost the turn.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.runtimeShapes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

// Before anything that loads the stores: the harness refuses otherwise.
const h = createBuilderStream();
after(() => h.restore());

const shapeCache = require('../../../automation/shapeCache');

const draftRow = () => ({
    id: 'auto_1',
    userId: 'u1',
    title: 'Files',
    description: '',
    definition: {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [
            { id: 'ls', type: 'integration_action', tool: 'nextcloud_list_files', inputs: {} },
            { id: 'rd', type: 'integration_action', tool: 'nextcloud_read_file', inputs: {} },
        ],
        edges: [{ from: 'trg', to: 'ls' }, { from: 'ls', to: 'rd' }],
        vars: {},
    },
});

async function turnSeeing(getShape) {
    const original = shapeCache.getShape;
    shapeCache.getShape = getShape;
    let seen = 'not called';
    try {
        await h.run({
            body: { automationId: 'auto_1', builderSessionId: 'bs_shapes' },
            draft: draftRow(),
            rounds: [{ toolCalls: [call('builder_summarise', {})] }, { text: 'Klaar.' }],
            onTool: async (_name, _args, wrap) => { seen = wrap._runtimeShapes; return { summary: 'ok' }; },
        });
    } finally {
        shapeCache.getShape = original;
    }
    return seen;
}

test('the draft\'s tools get their recorded runtime shapes at turn start', async () => {
    const asked = [];
    const seen = await turnSeeing(async ({ userId, toolName }) => {
        asked.push(`${userId}:${toolName}`);
        return toolName === 'nextcloud_list_files' ? { items: { _array: { name: 'string', etag: 'string' }, _length: 3 } } : null;
    });
    assert.deepStrictEqual(asked.sort(), ['u1:nextcloud_list_files', 'u1:nextcloud_read_file']);
    assert.deepStrictEqual(Object.keys(seen), ['nextcloud_list_files']);
    assert.ok(seen.nextcloud_list_files.items._array.etag);
});

test('a failing shape cache leaves the turn running, with no shapes', async () => {
    const seen = await turnSeeing(async () => { throw new Error('redis down'); });
    assert.deepStrictEqual(seen, {});
});
