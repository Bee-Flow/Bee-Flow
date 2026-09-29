/**
 * toolDispatcher × kb_search — does the SIMULATION survive the hop?
 *
 * "Test as · group X" (A1c) narrows which knowledge bases a preview turn may
 * read. Two doors hand out the same turn's knowledge: the automatic injection
 * in the knowledge phase, and the `kb_search` TOOL the model may call itself.
 * Narrowing one and leaving the other open is worse than narrowing neither —
 * the editor watches the Sales-only base disappear from the injection and then
 * the model fetches it back, one tool call later, and the preview reads green.
 *
 * THE WOUND THIS TEST EXISTS FOR. Both ENDS of that chain were pinned and the
 * MIDDLE was not: `toolRoundExecutor` put `testAs` on the dispatch context,
 * `kbSearchTools` read `context.testAs`, a static wiring test asserted both —
 * and the dispatcher in between built a fresh object literal that never named
 * the key. Every assertion passed while `context.testAs` was `undefined` at
 * the only place it is read. Two green ends do not make a connected wire.
 *
 * So this test is BEHAVIOURAL, not textual: it calls the real dispatcher with
 * a real context and looks at what the executor was actually handed. A rename,
 * a rebuilt literal or a lost spread fails it; no grep can be satisfied by
 * accident.
 *
 * Plain-script style with an explicit exit, like the two dispatcher tests
 * beside it: requiring the dispatcher pulls modules that keep the loop alive.
 *
 * Run: cd server && node core/tools/toolDispatcher.testAs.test.js
 */

const assert = require('node:assert/strict');
const path = require('path');

const seen = [];
function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The real module's `isKbSearchTool`, a recording `executeKbSearchTool`.
const real = require('../../integrations/kbSearchTools');
inject('../../integrations/kbSearchTools.js', {
    ...real,
    executeKbSearchTool: async (toolName, toolArgs, context) => {
        seen.push({ toolName, toolArgs, context });
        return { results: [] };
    },
});

const { executeTool } = require('./toolDispatcher');

const SIM = { groupId: 'grp-marketing', groupName: 'Marketing', audience: 'group' };

(async () => {
    // ── The simulation reaches the tool that can undo it ──
    seen.length = 0;
    await executeTool('kb_search', { query: 'pricing' }, {
        userId: 'user-editor',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        testAs: SIM,
    });
    assert.equal(seen.length, 1, 'kb_search must reach the executor');
    assert.deepEqual(seen[0].context.testAs, SIM,
        'the turn\'s simulation must survive the dispatcher — without it the tool '
        + 'filters as the plain asker and hands back what the preview hid');

    // ── An ordinary turn says "no simulation" out loud ──
    // `null`, not a missing key: the reader checks the value, and a field that
    // is absent for "no simulation" is indistinguishable from a field that is
    // absent because somebody stopped forwarding it. One of those is fine and
    // the other is this bug.
    seen.length = 0;
    await executeTool('kb_search', { query: 'pricing' }, {
        userId: 'user-editor',
        agentId: 'agent-1',
        conversationId: 'conv-1',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].context.testAs, null,
        'no simulation must arrive as null, never as an absent key');

    // ── The identity fields are still the ones the tool expects ──
    // Forwarding a new key must not have disturbed the three that were already
    // right; this is the cheapest guard against a rebuilt literal.
    assert.equal(seen[0].context.userId, 'user-editor');
    assert.equal(seen[0].context.agentId, 'agent-1');
    assert.equal(seen[0].context.conversationId, 'conv-1');

    console.log('toolDispatcher.testAs: ok');
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
