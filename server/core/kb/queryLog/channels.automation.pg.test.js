'use strict';

/**
 * The KB query log's automation_ai_step channel, driven through the real search function over the world of
 * channels.pg.test.js (channels.testkit.js). That function is the automation module's, so this file is.
 *
 * Run: cd server && node --test core/kb/queryLog/channels.automation.pg.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useChannelWorld, pg, raw, entry, settle, KB_ON } = require('./channels.testkit');
useChannelWorld();

test('groundAiStepWithKB (automation_ai_step): real runs log with automation, run and step; a dry run does not', async () => {
    const { groundAiStepWithKB } = require('../../automationRunner/aiStepGrounding');
    const deps = { knowledgeSearch: () => require('../../agentRuntime/knowledgeSearch'), kbVisibility: () => ({ filterKbIdsForUser: async (ids) => ids }) };
    const ctx = { userId: 'owner', orgId: 'org1', automationId: 'auto1', runId: 'run1' };
    const step = { id: 'step1', knowledgeBaseIds: [KB_ON] };

    const live = await groundAiStepWithKB(step, ctx, 'notice period', 'live', null, deps);
    assert.ok(live.queryLogHandle);
    await settle(live.queryLogHandle);
    const [row] = await raw();
    assert.equal(row.channel, 'automation_ai_step');
    assert.deepEqual((await entry(row)).channelRef, { automationId: 'auto1', runId: 'run1', stepId: 'step1' });

    await pg.exec('DELETE FROM kb_query_log');
    const dry = await groundAiStepWithKB(step, ctx, 'notice period', 'dry_run', null, deps);
    assert.equal(dry.queryLogHandle, null);
    await settle();
    assert.equal((await raw()).length, 0);
});
