'use strict';

/**
 * The KB query log's studio_ai_generate channel, driven through the real search function over the world of
 * channels.pg.test.js (channels.testkit.js). That function is the apps module's, so this file is.
 *
 * Run: cd server && node --test core/kb/queryLog/channels.apps.pg.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const hook = require('./hook.mts');
const { useChannelWorld, pg, raw, entry, settle, KB_ON } = require('./channels.testkit');
useChannelWorld();

test('groundWithKB (studio_ai_generate): the viewer is the user, not the app owner; no viewer means no search and no row', async () => {
    const aiRuntime = require('../../../appStudio/aiRuntime');
    const askerContext = require('../askerContext');
    askerContext.askerContext = async () => ({ orgIds: new Set(['org1']), userGroups: [] });
    const app = { id: 'app1', userId: 'owner', organizationId: 'org1' };
    const log = { channel: 'studio_ai_generate', channelRef: { appId: 'app1', actionId: 'act1' }, orgId: 'org1' };

    const ground = await aiRuntime.groundWithKB(app, { knowledgeBaseIds: [KB_ON], query: 'notice period', viewer: { id: 'viewer1' }, log });
    assert.ok(ground.context.includes('two months'));
    const handle = hook.handleOf(ground.chunks);
    assert.ok(handle);
    await settle(handle);
    const [row] = await raw();
    assert.equal(row.channel, 'studio_ai_generate');
    assert.equal(row.user_id, 'viewer1');
    assert.deepEqual((await entry(row)).channelRef, { appId: 'app1', actionId: 'act1' });

    await pg.exec('DELETE FROM kb_query_log');
    const none = await aiRuntime.groundWithKB(app, { knowledgeBaseIds: [KB_ON], query: 'notice period', viewer: null, log });
    assert.deepEqual(none.chunks, []);
    await settle();
    assert.equal((await raw()).length, 0, 'issue #599: nothing is searched without a viewer, so nothing is logged');
});
