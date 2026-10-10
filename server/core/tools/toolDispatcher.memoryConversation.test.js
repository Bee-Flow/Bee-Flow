/**
 * toolDispatcher × memory tools: the conversation id reaches the tool.
 *
 * memory_remember stores `source_conversation_id` from `context.conversationId`
 * (the "Remembered" chip and "delete this chat's memories" depend on it). The
 * dispatcher builds a fresh context object for the executor, so a key it does
 * not name is lost. Behavioural, like toolDispatcher.testAs.test.js.
 *
 * Plain-script style with an explicit exit (requiring the dispatcher keeps the
 * event loop alive).
 *
 * Run: cd server && node core/tools/toolDispatcher.memoryConversation.test.js
 */

const assert = require('node:assert/strict');

const seen = [];
// The dispatcher reads `executeMemoryTool` off the module at call time, so a
// recording replacement on the module object is enough.
const memoryTools = require('../../integrations/memoryTools');
memoryTools.executeMemoryTool = async (name, args, context) => { seen.push({ name, args, context }); return { ok: true }; };

const { executeTool } = require('./toolDispatcher');

(async () => {
    await executeTool('memory_remember', { type: 'fact', content: 'Works in Utrecht' }, {
        userId: 'u1', orgId: 'org1', agentId: 'agent-1', conversationId: 'conv-9',
    });
    assert.equal(seen.length, 1, 'memory_remember must reach the executor');
    assert.equal(seen[0].context.conversationId, 'conv-9', 'tool-saved memories need the conversation id');
    assert.equal(seen[0].context.orgId, 'org1');
    assert.equal(seen[0].context.userId, 'u1');

    seen.length = 0;
    await executeTool('memory_remember', { type: 'fact', content: 'x y z' }, { userId: 'u1' });
    assert.equal(seen[0].context.conversationId, null, 'absent conversation arrives as null');

    console.log('toolDispatcher.memoryConversation: ok');
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
