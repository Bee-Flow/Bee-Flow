/**
 * The nesting limit on agents starting routines, and the caller trace that
 * rides along (handoff 5, round 3). Dependencies go in as arguments; no
 * module mocking.
 *
 * Run: cd server && node --test automation/automationCallDepth.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const depth = require('./automationCallDepth');
const { dispatchAgentCallableTool, dispatchStepTool, callerTraceOf, runnerTraceOptions } = require('./agentCallableTools');

function routine(id) {
    return {
        id, userId: 'u1', isActive: true, title: id,
        definition: { trigger: { kind: 'agent_call', toolName: id } },
    };
}

test('three nested starts run, the fourth is refused with a code', async () => {
    const seen = [];
    const nest = (n) => depth.runNestedAutomationCall({ automationId: `r${n}` }, async (frame) => {
        seen.push(frame.depth);
        if (n < 4) return nest(n + 1);
        return 'bottom';
    });
    await assert.rejects(nest(1), (e) => {
        assert.strictEqual(e.code, 'automation_call_depth_exceeded');
        assert.strictEqual(e.depth, 4);
        assert.deepStrictEqual(e.chain, ['r1', 'r2', 'r3', 'r4']);
        assert.match(e.message, /the limit is 3/);
        assert.doesNotMatch(e.message, /[–—]/);
        return true;
    });
    assert.deepStrictEqual(seen, [1, 2, 3]);
});

test('siblings do not add up: depth follows the chain, not the count', async () => {
    const depths = [];
    await depth.runNestedAutomationCall({ automationId: 'a' }, async () => {
        for (const id of ['b', 'c', 'd', 'e']) {
            await depth.runNestedAutomationCall({ automationId: id }, async (f) => { depths.push(f.depth); });
        }
    });
    assert.deepStrictEqual(depths, [2, 2, 2, 2]);
    assert.strictEqual(depth.currentCallDepth(), 0, 'nothing leaks outside the call');
});

test('a refusal reads as a tool result for the model', () => {
    const e = new depth.AutomationCallDepthError(4, ['a'], 3);
    assert.deepStrictEqual(depth.toolErrorFor(e), { error: e.message, code: 'automation_call_depth_exceeded' });
    assert.deepStrictEqual(depth.toolErrorFor(new Error('nope')), { error: 'nope' });
});

test('the trace names the agent, the conversation and the calling run', () => {
    assert.deepStrictEqual(
        callerTraceOf({ userId: 'u1', callerAgentId: 'agt_step', agentId: 'agt_chat', conversationId: 'c1', runScope: { runId: 'run2', rootRunId: 'run1' } }),
        { callerAgentId: 'agt_step', callerConversationId: 'c1', callerRunId: 'run2', callerRootRunId: 'run1' },
    );
    assert.deepStrictEqual(callerTraceOf({ agentId: 'agt_chat' }).callerAgentId, 'agt_chat');
    assert.deepStrictEqual(callerTraceOf(null), { callerAgentId: null, callerConversationId: null, callerRunId: null, callerRootRunId: null });
});

test('startedByUserId is set only when a person in a conversation started it', () => {
    assert.deepStrictEqual(
        runnerTraceOptions({ callerAgentId: 'a', callerConversationId: 'c' }, { userId: 'u1' }),
        { callerAgentId: 'a', callerConversationId: 'c', startedByUserId: 'u1' },
    );
    assert.deepStrictEqual(
        runnerTraceOptions({ callerAgentId: 'a', callerConversationId: null }, { userId: 'u1' }),
        { callerAgentId: 'a', callerConversationId: null },
    );
});

test('an agent-called routine carries the caller and never reuses parent_run_id', async () => {
    let seenOpts = null;
    const deps = {
        automationStore: { getAutomation: async (id) => routine(id) },
        automationRunner: { executeAutomation: async (_a, opts) => { seenOpts = opts; return { lastOutput: { ok: 1 } }; } },
    };
    const out = await dispatchAgentCallableTool({ id: 'r1', userId: 'u1' }, { q: 1 }, {
        userId: 'u1', callerAgentId: 'agt_1', runScope: { runId: 'run9', rootRunId: 'run9' },
    }, deps);
    assert.deepStrictEqual(out, { ok: 1 });
    assert.strictEqual(seenOpts.callerAgentId, 'agt_1');
    assert.strictEqual(seenOpts.callerConversationId, null);
    assert.strictEqual(seenOpts.parentRunId, undefined, 'parent_run_id means "the run this replays"');
    assert.strictEqual(seenOpts.rootRunId, undefined, 'root_run_id folds a run into another journey');
    assert.strictEqual(seenOpts.triggerKind, 'agent_call');
});

test('routines that keep calling each other stop at the limit, with the reason', async () => {
    let starts = 0;
    const deps = {
        automationStore: { getAutomation: async (id) => routine(id) },
        automationRunner: {
            // Each run's agent step starts the same routine again.
            executeAutomation: async (a) => {
                starts += 1;
                return { lastOutput: await dispatchAgentCallableTool({ id: a.id, userId: 'u1' }, {}, { userId: 'u1', callerAgentId: 'agt' }, deps) };
            },
        },
    };
    await assert.rejects(
        dispatchAgentCallableTool({ id: 'loop', userId: 'u1' }, {}, { userId: 'u1' }, deps),
        (e) => e.code === 'automation_call_depth_exceeded',
    );
    assert.strictEqual(starts, 3);
});

test('a reusable Step started by an agent counts toward the same limit', async () => {
    const calls = [];
    const runner = { runStepAsTool: async (id, args, ctx) => { calls.push({ id, ctx, depth: depth.currentCallDepth() }); return 'ok'; } };
    const out = await depth.runNestedAutomationCall({ automationId: 'outer1' }, () => depth.runNestedAutomationCall({ automationId: 'outer2' },
        () => dispatchStepTool({ id: 'blk1', userId: 'u1' }, {}, { userId: 'u1', agentId: 'agt', conversationId: 'c1' }, { automationRunner: runner })));
    assert.strictEqual(out, 'ok');
    assert.strictEqual(calls[0].depth, 3);
    assert.strictEqual(calls[0].ctx.callerAgentId, 'agt');
    assert.strictEqual(calls[0].ctx.startedByUserId, 'u1');
    await assert.rejects(
        depth.runNestedAutomationCall({ automationId: 'o1' }, () => depth.runNestedAutomationCall({ automationId: 'o2' }, () => depth.runNestedAutomationCall({ automationId: 'o3' },
            () => dispatchStepTool({ id: 'blk1', userId: 'u1' }, {}, { userId: 'u1' }, { automationRunner: runner })))),
        (e) => e.code === 'automation_call_depth_exceeded',
    );
});
