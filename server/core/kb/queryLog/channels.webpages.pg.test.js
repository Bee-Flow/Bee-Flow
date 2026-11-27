'use strict';

/**
 * The KB query log's webpage channel, driven through the real search function over the world of
 * channels.pg.test.js (channels.testkit.js). That function is the webpages module's, so this file is.
 *
 * Run: cd server && node --test core/kb/queryLog/channels.webpages.pg.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const hook = require('./hook.mts');
const { useChannelWorld, pg, raw, settle, KB_ON } = require('./channels.testkit');
useChannelWorld();

test('searchWebpageKB (webpage): an anonymous visitor is never logged; the tool registers on the carrier', async () => {
    const { searchWebpageKB, executeWebpageKBSearchTool } = require('../../webpages/webpageKnowledgeSearch');
    const result = await searchWebpageKB({
        userId: 'author', kbIds: [KB_ON], query: 'notice period',
        log: { channel: 'webpage', channelRef: { webpageId: 'wp1', surface: 'public_share' }, orgId: 'org1', userId: null },
    });
    await settle(hook.handleOf(result));
    assert.equal((await raw()).length, 0, 'webpage needs an acknowledgement, an anonymous visitor cannot give one');

    await pg.exec('DELETE FROM kb_query_log');
    const turn = {};
    await executeWebpageKBSearchTool({ query: 'notice period' }, 'author', [KB_ON], {
        channel: 'webpage', channelRef: { webpageId: 'wp1', surface: 'chat' }, orgId: 'org1', userId: 'author', carrier: turn,
    });
    assert.equal(hook.turnLogsOf(turn).handles().length, 1);
    await settle(...hook.turnLogsOf(turn).handles());
    const [row] = await raw();
    assert.equal(row.user_id, 'author');
    assert.equal(row.channel, 'webpage');
});
