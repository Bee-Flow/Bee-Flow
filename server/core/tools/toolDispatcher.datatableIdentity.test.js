/**
 * toolDispatcher × datatable_query — WHOSE rows, when the turn is acting as
 * somebody else.
 *
 * The dispatcher's `context.userId` is the INTEGRATION identity, not the person
 * asking. Two callers overwrite it on purpose:
 *
 *   - `userAuth.integrationUserId` — the Support inbox designates an operator
 *     so per-user OAuth tokens resolve (services/supportAiResponder.js:292);
 *   - a lent connection's owner, when `mayLendOwnerConnection` says yes
 *     (agentRuntime/toolRoundExecutor.js, chatWithAgent.js).
 *
 * Both are right for a token and wrong for a ROW. `datatable_query` decides
 * which rows somebody may see, so it reads `context.askerUserId` — and it has
 * no fallback to `userId`, because a caller that does not say who is asking
 * has to get a refusal rather than the widest identity in the room.
 *
 * `mayLendOwnerConnection('datatable_query', …)` answers TRUE today (the name
 * is not in the tool registry, so it looks unattributed and an unattributed
 * name is allowed to lend). Nothing borrows a connection for it in practice
 * because no provider resolves — but "no provider resolves" is an accident of
 * another module, not a refusal, and this is the test that keeps it from
 * becoming one.
 *
 * Plain-script style with an explicit exit, like toolDispatcher.ncScope.test.js:
 * requiring the dispatcher pulls modules that keep the event loop alive.
 *
 * Run: cd server && node core/tools/toolDispatcher.datatableIdentity.test.js
 */

const assert = require('node:assert/strict');
const path = require('path');

const seen = [];
function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The real module's `isDatatableTool`, a recording `executeDatatableTool`.
const real = require('./datatableTools');
inject('./datatableTools.js', {
    ...real,
    executeDatatableTool: async (toolName, toolArgs, context) => {
        seen.push({ toolName, toolArgs, context });
        return { ok: true };
    },
});

const { executeTool } = require('./toolDispatcher');

const ASKER = 'user-asking';
const OPERATOR = 'user-support-operator';

(async () => {
    // ── The acting identity does not decide which rows come back ──
    seen.length = 0;
    await executeTool('datatable_query', { datatable_id: 't1' }, {
        // What the Support inbox turn actually hands the dispatcher.
        userId: OPERATOR,
        askerUserId: ASKER,
        agentId: 'agent-1',
    });
    assert.equal(seen.length, 1, 'the datatable branch ran');
    assert.equal(seen[0].context.userId, ASKER,
        'the rows are read for the person asking, not for the designated operator');
    assert.equal(seen[0].context.agentId, 'agent-1');

    // ── No asker means no read ──
    // A caller that never set `askerUserId` must not silently fall back to the
    // integration identity: that is the widest identity in the room and the
    // one this whole file exists to keep out.
    seen.length = 0;
    await executeTool('datatable_query', { datatable_id: 't1' }, {
        userId: OPERATOR,
        agentId: 'agent-1',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].context.userId, undefined,
        'no asker is passed on as no asker — the executor refuses it');

    // ── Both runtimes actually send it ──
    // Genuinely textual: the field is only worth reading if the two agent-chat
    // dispatch sites write it. A grep, deliberately — wiring one of two
    // dispatches is the same lie in a smaller room, nobody can see which route
    // their call took. Driving toolRoundExecutor.js and chatWithAgent.js for
    // real needs the same ~230-line adapter/store/registry harness
    // core/agentRuntime/toolRoundExecutor.confirm.test.js already stands up
    // for its own, different assertions; a second copy of that harness here
    // just to read one field off the context object is not a cheaper test.
    const fs = require('fs');
    for (const f of ['../agentRuntime/toolRoundExecutor.js', '../agentRuntime/chatWithAgent.js']) {
        const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
        assert.ok(/askerUserId:\s*userId/.test(src), `${f} must pass the real asker through`);
    }

    console.log('toolDispatcher.datatableIdentity: ok');
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
