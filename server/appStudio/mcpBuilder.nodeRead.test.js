/**
 * App Studio over MCP — app_get_node (full component read) and the "no change
 * does not save" rule of app_update_component.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');
const appStore = require('../stores/studioAppStore');
const dataStore = require('../stores/studioAppDataStore');

const LONG = 'A long explanation that the compact draft would cut off. '.repeat(8);

function appRow() {
    return {
        id: 'app_1', name: 'A', organizationId: null, definitionVersion: 4,
        definition: {
            schemaVersion: 1,
            meta: { name: 'A' },
            screens: [{
                id: 'scr_ccc333', name: 'Home',
                sections: [{
                    id: 'sec_ddd444', name: 'S',
                    children: [
                        { id: 'cmp_aaa111', type: 'text', props: { text: LONG }, style: { span: 12 } },
                        { id: 'cmp_bbb222', type: 'text', props: { text: 'Short' }, style: { span: 6 } },
                    ],
                }],
            }],
        },
    };
}

function withStubs(canWrite, fn) {
    const restore = [];
    const stub = (mod, key, value) => { restore.push([mod, key, mod[key]]); mod[key] = value; };
    const saves = [];
    stub(appStore, 'getStudioApp', async () => appRow());
    stub(appStore, 'canWriteStudioApp', () => canWrite);
    stub(appStore, 'saveDefinition', async (_id, _user, _def, opts) => { saves.push(opts); return { ok: true, version: (opts.expectedVersion || 0) + 1 }; });
    stub(dataStore, 'getDataModel', async () => null);
    stub(dataStore, 'listDatasets', async () => []);
    return Promise.resolve(fn(saves)).finally(() => {
        for (const [mod, key, prev] of restore.reverse()) mod[key] = prev;
    });
}

test('app_get_node returns the full props untruncated and reports unknown ids', () => withStubs(true, async () => {
    const { result } = await mcpBuilder.callTool('app_get_node', { appId: 'app_1', ids: ['cmp_aaa111', 'cmp_zzz999'] }, { userId: 'u1' });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].id, 'cmp_aaa111');
    assert.equal(result.nodes[0].props.text, LONG);
    assert.deepEqual(result.unknownIds, ['cmp_zzz999']);
    assert.equal(result.error, undefined);
}));

test('app_get_node enforces the same access check as app_get_draft', () => withStubs(false, async () => {
    const node = await mcpBuilder.callTool('app_get_node', { appId: 'app_1', ids: ['cmp_aaa111'] }, { userId: 'intruder' });
    const draft = await mcpBuilder.callTool('app_get_draft', { appId: 'app_1' }, { userId: 'intruder' });
    assert.match(node.result.error, /not found, or this token's user cannot edit it/);
    assert.equal(node.result.error, draft.result.error);
    assert.equal(node.result.nodes, undefined);
}));

test('app_get_node needs ids, answers at most 40 and is advertised read-only', () => withStubs(true, async () => {
    const none = await mcpBuilder.callTool('app_get_node', { appId: 'app_1', ids: [] }, { userId: 'u1' });
    assert.match(none.result.error, /ids is required/);
    const many = Array.from({ length: 45 }, (_, i) => `cmp_q${String(i).padStart(5,'0')}`);
    const { result } = await mcpBuilder.callTool('app_get_node', { appId: 'app_1', ids: many }, { userId: 'u1' });
    assert.equal(result.unknownIds.length, 40);
    assert.equal(result.skipped.length, 5);
    const tool = mcpBuilder.buildToolList().find((t) => t.name === 'app_get_node');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(tool.inputSchema.required.includes('appId') && tool.inputSchema.required.includes('ids'));
}));

test('an update without any change says so and does not save or bump the version', () => withStubs(true, async (saves) => {
    const { result } = await mcpBuilder.callTool('app_update_component', { appId: 'app_1', id: 'cmp_bbb222', props: { text: 'Short' } }, { userId: 'u1' });
    assert.equal(result.changed, false);
    assert.match(result.note, /No change/);
    assert.equal(result.version, 4);
    assert.equal(saves.length, 0);
}));

test('a real update still saves and bumps the version', () => withStubs(true, async (saves) => {
    const { result } = await mcpBuilder.callTool('app_update_component', { appId: 'app_1', id: 'cmp_bbb222', props: { text: 'Changed' } }, { userId: 'u1' });
    assert.equal(result.error, undefined);
    assert.notEqual(result.changed, false);
    assert.equal(saves.length, 1);
    assert.equal(result.version, 5);
}));
