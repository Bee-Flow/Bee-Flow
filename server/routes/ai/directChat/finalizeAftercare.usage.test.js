/**
 * The conversation title is a model call, and it writes a usage row: the
 * user, the turn's organisation, source `chat_title`, the title model and the
 * conversation. The provider path returns the title only, so the row has zero
 * tokens; it still says the call happened.
 *
 * Run: cd server && node --test routes/ai/directChat/finalizeAftercare.usage.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { areaOf } = require('../../../shared/usageAreas');

const rows = [];
const titles = [];
const restore = installResolveStub({
    '../../../stores/agentStore': {
        getSystemAgent: async () => null,
        updateDirectConversationTitle: async (convId, title) => { titles.push(title); },
    },
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../core/llm/llmClient': { generateTitleWithProvider: async () => 'Planning the offsite' },
    // The sink as core/llm/surfaceUsage.js requires it.
    '../../stores/usageStore': { logUsage: async (row) => { rows.push(row); } },
});
test.after(() => restore());

const { scheduleTitle } = require('./finalizeAftercare');

test('the title call is logged as chat_title under the user and the turn\'s organisation', async () => {
    const { pendingTitle } = await scheduleTitle({
        conv: { title: '' }, moderationViolation: false, convId: 'c1', userId: 'u1', userOrgId: 'org-1', send: () => {},
        savedMessages: [{ role: 'user', content: 'Plan the offsite' }, { role: 'assistant', content: 'Sure.' }],
        tiers: {}, modelId: 'model-fast', adapter: {}, apiKey: 'k', apiUrl: '',
    });
    await pendingTitle;
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(titles, ['Planning the offsite']);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.source, 'chat_title');
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.model, 'model-fast');
    assert.strictEqual(row.conversation_id, 'c1');
    assert.strictEqual(row.prompt_tokens, 0);
    assert.notStrictEqual(areaOf(row.source), 'other');
});
