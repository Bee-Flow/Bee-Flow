/**
 * How deep automations are starting each other right now (handoff 5, round 3).
 *
 * An agent can start a routine as a tool (`agent_call` routines, reusable
 * Steps, a skill linked to a routine). That routine can have an AI step whose
 * agent starts another one, and so on: without a limit, two routines that call
 * each other run until something falls over, each level paying for a model
 * call. This module keeps the chain in an AsyncLocalStorage frame. Every agent
 * start of a routine runs INSIDE the start that called it (the runner awaits
 * the nested run in-process), so the frame follows the chain without anything
 * being threaded through the runner.
 *
 * The limit is on NESTED calls: a chat agent or a scheduled routine starting a
 * routine is depth 1, that routine's agent starting another is depth 2, and
 * the fourth level is refused with `automation_call_depth_exceeded`. A run that
 * resumes later (after an approval or a form) starts a fresh chain; it is no
 * longer inside the call that started it.
 *
 * The frame also carries who is calling (agent, conversation, run), so a
 * refusal can say where the chain came from.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/** At most this many automation starts nested inside each other. */
const MAX_AUTOMATION_CALL_DEPTH = 3;

const storage = new AsyncLocalStorage();

class AutomationCallDepthError extends Error {
    constructor(depth, chain, max) {
        super(`This automation was not started: agents are already ${depth - 1} automation calls deep (the limit is ${max}). `
            + 'Automations that keep starting each other are stopped here. Start the next automation from a step instead, '
            + 'or switch off "Start automations itself" on one of the agent steps in this chain.');
        this.name = 'AutomationCallDepthError';
        this.code = 'automation_call_depth_exceeded';
        this.errorClass = 'automation_call_depth_exceeded';
        this.depth = depth;
        this.max = max;
        this.chain = chain;
    }
}

/** The frame of the automation call we are inside, or null at the top. */
function currentCallFrame() {
    return storage.getStore() || null;
}

/** 0 outside any agent-started automation. */
function currentCallDepth() {
    const f = currentCallFrame();
    return f && Number.isInteger(f.depth) ? f.depth : 0;
}

/**
 * Run `fn` as one more nested automation call, or refuse before it starts.
 *
 * @param {object}   call
 * @param {string}   call.automationId     the routine being started
 * @param {string}   [call.callerAgentId]  the agent that asked for it
 * @param {string}   [call.callerConversationId]
 * @param {string}   [call.callerRunId]    the run the calling agent step is in
 * @param {Function} fn                    starts the routine; receives the frame
 * @param {{ max?: number }} [opts]
 * @throws {AutomationCallDepthError} when the chain is already at the limit
 */
async function runNestedAutomationCall(call, fn, { max = MAX_AUTOMATION_CALL_DEPTH } = {}) {
    const parent = currentCallFrame();
    const depth = (parent && Number.isInteger(parent.depth) ? parent.depth : 0) + 1;
    const chain = [...(parent && Array.isArray(parent.chain) ? parent.chain : []), (call && call.automationId) || null];
    if (depth > max) throw new AutomationCallDepthError(depth, chain, max);
    const frame = {
        depth,
        chain,
        automationId: (call && call.automationId) || null,
        callerAgentId: (call && call.callerAgentId) || null,
        callerConversationId: (call && call.callerConversationId) || null,
        callerRunId: (call && call.callerRunId) || null,
    };
    return storage.run(frame, () => fn(frame));
}

/**
 * The tool-result shape for a refused or failed agent start of a routine: an
 * `{ error, code }` object the model can read, instead of an exception that a
 * chat turn or an AI step would have to unwind.
 */
function toolErrorFor(err) {
    return {
        error: (err && err.message) || 'The automation could not be started.',
        ...(err && err.code ? { code: err.code } : {}),
    };
}

module.exports = {
    MAX_AUTOMATION_CALL_DEPTH,
    AutomationCallDepthError,
    currentCallFrame,
    currentCallDepth,
    runNestedAutomationCall,
    toolErrorFor,
};
