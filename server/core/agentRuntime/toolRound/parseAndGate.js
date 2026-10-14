// @typecheck
/**
 * One tool call, before anything reads its arguments for real: the JSON
 * parse, gate 1 (was this name offered?) and gate 2 (does a person have to
 * say yes first?). See ../toolRoundExecutor.js for why the two gates sit
 * where they do — gate 1 FIRST, gate 2 LAST before dispatch — and for the
 * order the round runs them in.
 *
 * Moved verbatim out of the per-call closure of executeToolRound. `rc` is the
 * round context executeToolRound builds (the round's inputs plus its
 * per-round state); `deps` carries what sits in the server's large import
 * cycle (toolPolicy), so this module stays out of it.
 */
const { _stableStringify } = require('./toolContent');
const testChatMod = require('../testChat');
const log = require('../../../telemetry/log');

/**
 * Parse the model's arguments. A parse failure is surfaced as the call's
 * result (`refusal`), so the model can self-correct.
 * @returns {{ toolName: string, toolArgs: object, refusal: object|null }}
 */
function parseToolCall(toolCall) {
    const toolName = toolCall.function.name;
    let toolArgs = {};
    let jsonParseError = null;
    try {
        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
    } catch (e) {
        toolArgs = {};
        jsonParseError = e.message || 'invalid JSON';
    }
    // Surface the parse failure as a tool result so the model can self-correct
    // instead of silently retrying with empty args.
    if (jsonParseError) {
        return {
            toolName,
            toolArgs,
            refusal: {
                toolCall,
                toolName,
                toolArgs,
                finalToolResult: `[Tool '${toolName}' arguments were not valid JSON: ${jsonParseError}. Please re-emit the tool call with well-formed JSON.]`,
                blocked: true
            },
        };
    }
    return { toolName, toolArgs, refusal: null };
}

/**
 * Gate 1. Returns the policy verdict (gate 2 reads it later) and, for a
 * refused name, the sentinel result.
 * @returns {{ verdict: object, refusal: object|null }}
 */
function gateOfferedName(rc, deps, { toolCall, toolName, toolArgs }) {
    const { onEvent, toolPolicy } = rc;
    const { decideToolCall } = deps;
    // ── Gate 1: was this name actually offered? ──────────────
    // Ahead of the DLP restore on purpose: a refused call must
    // not have real values put back into its arguments, and it
    // has nothing to gain from them either.
    const _verdict = decideToolCall({ toolName, policy: toolPolicy });
    if (_verdict.reason === 'not_offered_unenforced') {
        // Nobody has curated this agent, so the name gate is
        // not armed for it and the call goes on to the
        // dispatcher exactly as it did before the grants layer
        // (its own dynamic-name lookup may still claim it).
        // Logged all the same: this is the shape of drift and
        // of an injected automation name, and it should be
        // visible without changing what a legacy agent does.
        log.warn(`[AgentRuntime] Tool '${toolName}' was not offered this round — ` +
            'passing it to the dispatcher: this agent has no stored tool grants, so the ' +
            'name gate is off. Curate the agent to close the stack.');
    }
    if (_verdict.action === 'refuse') {
        log.warn(`[AgentRuntime] Refused tool '${toolName}' — ${_verdict.reason} (not in this round's stack)`);
        // tool_start only: the result loop below emits the
        // matching tool_end for every entry it processes, and
        // the UI timeline pairs them. An early tool_end here
        // would be the second one for this call.
        onEvent('tool_start', { name: toolName, args: toolArgs });
        return {
            verdict: _verdict,
            refusal: {
                toolCall, toolName, toolArgs,
                finalToolResult: `[Tool '${toolName}' is not available to this agent and was not called. Use only the tools you were given.]`,
                blocked: true,
                policyRefused: true,
            },
        };
    }
    return { verdict: _verdict, refusal: null };
}

/**
 * Gate 2. Returns the sentinel result for a held or declined call, or null
 * when the call may be dispatched. Synchronous on purpose: in the original
 * closure nothing between the policy checks and the dispatch awaited when no
 * argument scan ran, and the order of the batch's SSE events depends on it.
 */
function holdForConfirmation(rc, deps, { toolCall, toolName, toolArgs, verdict: _verdict }) {
    const {
        onEvent, MAX_TOOL_REPEAT, _pendingToolCalls, _pendingToolCounts,
        _heldThisRound, _isTestChatRound, _toolDecisions,
    } = rc;
    const { previewToolArgs } = deps;
    // ── Gate 2: does a person have to say yes first? ─────────
    // Last stop before dispatch, so everything that would have
    // been refused outright already has been — nobody is asked
    // to approve a call a guardrail was going to block anyway.
    //
    // A TESTCHAT (A4) only ever ADDS to this gate. It holds
    // everything that does not demonstrably read, whatever the
    // agent's own `confirm` says, so trying out a concept can
    // never be the thing that sends a real mail. An upgrade
    // only: it can turn 'run' into 'confirm', never the other
    // way round, so no call that a policy holds is released
    // here.
    let _confirmAction = _verdict.action;
    if (_isTestChatRound && _confirmAction === 'run'
        && testChatMod.holdsEffect(toolName, _verdict.effect)) {
        _confirmAction = 'confirm';
    }
    if (_confirmAction === 'confirm') {
        // Keyed on the ACTION, never on the call: `toolCall.id`
        // is fresh every round, so an id-keyed dedupe never sees
        // a repeat and a model that ignores the placeholder below
        // earns one card per round for one action. This is the
        // key `_failingToolCounts` uses, so "the same call again"
        // means the same thing to both brakes.
        const _pendingKey = `${toolName}|${_stableStringify(toolArgs)}`;
        // The same key, hashed, is what the card carries and
        // what a decision quotes back. Hashed because the raw
        // arguments must not travel to a client and back — and
        // because a decision then means ONE action rather than
        // "this tool, with anything in it".
        const _argsKey = testChatMod.argsKeyFor(toolName, _stableStringify(toolArgs));
        const _decision = _toolDecisions.get(_argsKey);
        if (_decision === 'approve') {
            // The person said yes to exactly this. Consumed —
            // one yes runs one action, and a model that repeats
            // the call gets a fresh card instead of a free pass.
            _toolDecisions.delete(_argsKey);
            _confirmAction = 'run';
            log.info(`[AgentRuntime] '${toolName}' approved by the user — running it`);
            onEvent('tool_confirm', {
                callId: toolCall.id, toolName, effect: _verdict.effect,
                preview: previewToolArgs(toolArgs), argsKey: _argsKey,
                status: 'approved',
            });
        } else if (_decision === 'decline') {
            _toolDecisions.delete(_argsKey);
            onEvent('tool_confirm', {
                callId: toolCall.id, toolName, effect: _verdict.effect,
                preview: previewToolArgs(toolArgs), argsKey: _argsKey,
                status: 'declined',
            });
            return {
                toolCall, toolName, toolArgs,
                finalToolResult: `The user declined '${toolName}'. It has not run and must not be attempted again this turn. Tell the user you did not do it.`,
                blocked: true,
                confirmDeclined: true,
            };
        }
    }
    if (_confirmAction === 'confirm') {
        const _pendingKey = `${toolName}|${_stableStringify(toolArgs)}`;
        const _argsKey = testChatMod.argsKeyFor(toolName, _stableStringify(toolArgs));
        let _heldRounds = _pendingToolCounts.get(_pendingKey) || 0;
        const _firstThisRound = !_heldThisRound.has(_pendingKey);
        if (_firstThisRound) {
            _heldThisRound.add(_pendingKey);
            _heldRounds += 1;
            _pendingToolCounts.set(_pendingKey, _heldRounds);
        }
        // One card per action per turn. A second card for a call
        // the user is already looking at is not a second thing to
        // approve, and the resume flow quotes the first callId.
        if (_firstThisRound && _heldRounds === 1) {
            const pending = {
                callId: toolCall.id,
                toolName,
                effect: _verdict.effect,
                preview: previewToolArgs(toolArgs),
                // What a decision quotes back. Persisted with
                // the rest of the card, so a reload can still
                // answer the question it is looking at.
                argsKey: _argsKey,
                status: 'pending',
            };
            _pendingToolCalls.push(pending);
            onEvent('tool_confirm', pending);
        }
        // A parked call is not a failing call, so it stays out of
        // `_failingToolCounts` — but it is not free either. The
        // turn has a finite round budget, and burning it here ends
        // on the max-iterations throw, which never reaches
        // finalizeTurn: no assistant reply, and the card the user
        // is looking at is never persisted. A RECURRING hold
        // therefore bails on the same threshold as a repeated
        // failure.
        if (_heldRounds >= MAX_TOOL_REPEAT) {
            log.warn(`[AgentRuntime] '${toolName}' held for confirmation ${_heldRounds}× with identical arguments — wrapping up the turn`);
            rc.pendingLoopDetected = true;
        }
        log.info(`[AgentRuntime] Holding '${toolName}' (${_verdict.effect}) for confirmation`);
        return {
            toolCall, toolName, toolArgs,
            // Deliberately NOT phrased as a failure: the model
            // has to be able to finish its turn around this,
            // the way it already narrates an email draft.
            finalToolResult: _heldRounds > 1
                ? `Still waiting for the user to approve '${toolName}'. It has not run, and asking again will not run it. Tell the user what you are waiting for and stop.`
                : `Waiting for the user to approve '${toolName}'. It has not run. Tell the user what you are about to do and stop — do not call it again.`,
            blocked: true,
            confirmPending: true,
        };
    }
    return null;
}

module.exports = { parseToolCall, gateOfferedName, holdForConfirmation };
