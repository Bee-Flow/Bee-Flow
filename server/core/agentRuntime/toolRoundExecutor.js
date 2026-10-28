/** @typedef {import('./chatStream/turnState').ToolCall} ToolCall */
// @typecheck
/**
 * Streaming agent chat — one tool round of the agentic loop.
 *
 * Executes the model's tool calls for a round: JSON-parse + DLP arg restore,
 * the agent tool policy (name whitelist + confirmation hold), the org tool-PII
 * policy (pre-dispatch block / monitor), the probed dispatch with connection
 * lending and egress logging, the concurrent result PII pre-scan, and the
 * in-order result loop (SSE draft/map/workspace/kb events, usage rows, result
 * redaction + tokenisation, the tool messages for both history arrays) ending
 * in the post-round persist. Also home to the serialisation helpers the round
 * and its caller share. Moved verbatim out of chatStream.js; the bail decision
 * is returned for the loop to act on — `'repeated_failure'`,
 * `'pending_confirmation'`, or null to keep going.
 *
 * ── THE TWO POLICY GATES ────────────────────────────────────────────
 * `toolPolicy` (built per round by the caller from the LIVE tool array) adds
 * two refusals to the ones above, and the ORDER of the second one matters:
 *
 *   1. NAME NOT OFFERED — checked first, before anything reads the arguments.
 *      A name the model was never handed is not a call, it is drift or an
 *      injection, and letting it through reaches the dispatcher's dynamic-name
 *      fallback, which runs the ASKER's own automations outside every agent
 *      policy. Nothing is dispatched, nothing is logged as egress.
 *
 *   2. NEEDS CONFIRMATION — checked LAST, immediately before dispatch, so a
 *      call that a guardrail or the PII policy would refuse is refused rather
 *      than offered to a person for approval. There is no held stream: the
 *      model gets a placeholder result, the turn runs on to `done`, and the
 *      pending call rides out on the assistant message the way an email draft
 *      does. A client that does not draw it shows nothing and hangs on
 *      nothing. The hold is deduplicated and counted per ACTION (name + stable
 *      args), not per call id: an id is fresh every round, so a model that
 *      ignores the placeholder would otherwise re-hold the same action for the
 *      whole round budget — one card per round, and a turn that dies on the
 *      max-iterations throw with nothing persisted.
 *
 * ── BOTH GATES ARE OPT-IN ───────────────────────────────────────────
 * Neither does anything to an agent with no stored `config.tools` — see
 * core/agentRuntime/toolPolicy.js.
 *
 * Gate 1 shipped global for one stage, and that was a behaviour change with no
 * field behind it: before the grants layer a name outside the stack went on to
 * `executeTool`, where the dispatcher resolves it against the caller's own
 * agent-callable automations and Steps, answers a progressive-disclosure name
 * with a "load that group first" hint, and otherwise tries a component tool.
 * Refusing all of that for every agent in the product — to close a hole that
 * only a curated agent had asked to have closed — is the opposite of shipping
 * this invisibly. So the gate follows the same fence as the hold-back:
 * `enforceNames` is on once someone has curated the agent, and an uncurated
 * one gets the pre-grants path plus a warning line naming the tool. Curating
 * an agent is what closes its stack.
 */
/*
 * ── WHERE THE STEPS LIVE ────────────────────────────────────────────
 * This file keeps the orchestration: the per-round state, the per-call
 * pipeline that runs the steps in the order above, the loop brakes and the
 * bail decision. The steps themselves moved verbatim into ./toolRound/:
 *
 *   parseAndGate.js   JSON parse, gate 1 (name offered), gate 2 (confirmation)
 *   piiPolicy.js      tool-PII policy, DLP restore, regex input, argument PII block
 *   dispatch.js       connection lending, probed dispatch, failure egress, regex output
 *   results.js        result PII pre-scan, the in-order result loop, redaction
 *   sideChannels.js   drafts, map, workspace, kb sources, files
 *   toolContent.js    the serialisation helpers (still exported from here)
 *
 * Everything those modules need from the server's large import cycle is
 * required HERE and handed over in `deps` (lazy getters for the lazy
 * requires), so the new modules stay out of the cycle (lint:scc-ratchet) and
 * nothing loads earlier than before. toolRoundExecutor.gateOrder.test.js pins
 * the order of the gates.
 */
const {
    MAX_TOOL_CONTENT_BYTES, truncateToolContent, buildLLMToolContent,
    _flattenToolRoundTrips, _stableStringify,
} = require('./toolRound/toolContent');
const { parseToolCall, gateOfferedName, holdForConfirmation } = require('./toolRound/parseAndGate');
const {
    resolveToolPiiPolicy, restoreDlpArgs, regexInputGuard, monitorCategoriesFor, checkArgumentPii,
} = require('./toolRound/piiPolicy');
const { dispatchToolCall } = require('./toolRound/dispatch');
const { processToolResults } = require('./toolRound/results');
// Egress rows now flow through core/integrationLogging.js (lazy-required at
// the call sites) — the store is no longer used directly here.
const usageStore = require('../../stores/usageStore');
const { untokeniseToolArgs } = require('../dlp/applyTokenMapToOutbound');
const { decideToolCall, previewToolArgs, mayLendOwnerConnection } = require('./toolPolicy');
const { scanCategoriesFor } = require('../privacy/customTypes/plan');
const log = require('../../telemetry/log');

// Lazy, like the per-call require below: orgShield is where tool classes are
// decided, and loading it here would pull the shield into this module's graph.
/**
 * @param {string} name
 */
const _toolClassOf = (name) => require('../privacy/orgShield').classifyToolClass(name);

// What the ./toolRound/ modules use from the import cycle. The getters are
// the lazy requires of the per-call closure, unchanged: each
// one still loads its module on first use, and a test stub that swaps the
// module under these exact require strings still reaches every step.
const deps = {
    decideToolCall, previewToolArgs, mayLendOwnerConnection,
    untokeniseToolArgs, scanCategoriesFor, usageStore,
    toolClassOf: _toolClassOf,
    orgShield: () => require('../privacy/orgShield'),
    dlpRunner: () => require('../dlp/dlpRunner'),
    piiDetection: () => require('../privacy/piiDetection'),
    toolDispatcher: () => require('../tools/toolDispatcher'),
    connectionResolution: () => require('../integrations/connectionResolution'),
    integrationLogging: () => require('../integrations/integrationLogging'),
    toolResultRedact: () => require('../dlp/toolResultRedact'),
};

const testChatMod = require('./testChat');

/**
 * One tool call through every gate, in order. Returns the call's result
 * object (a blocked sentinel for every refusal). Nothing here awaits unless
 * the original closure did — an argument PII scan or the dispatch — so the
 * calls of one batch interleave exactly as before.
 * @param {ToolRoundContext} rc
 * @param {ToolCall} toolCall
 */
async function runToolCall(rc, toolCall) {
    const { signal, onEvent, toolParamsMap } = rc;
    const { toolName, toolArgs: _parsedArgs, refusal: _parseRefusal } = parseToolCall(toolCall);
    if (_parseRefusal) return _parseRefusal;
    let toolArgs = _parsedArgs;

    // Gate 1, ahead of the DLP restore.
    const { verdict: _verdict, refusal: _nameRefusal } = gateOfferedName(rc, deps, { toolCall, toolName, toolArgs });
    if (_nameRefusal) return _nameRefusal;

    const policy = resolveToolPiiPolicy(rc, deps, toolName, toolArgs);
    toolArgs = restoreDlpArgs(rc, deps, toolArgs);

    const fixedParams = toolParamsMap[toolName] || null;
    // Don't log fixedParams directly — they often contain secrets (API keys,
    // tokens, OAuth refresh creds). Just log whether they were present.
    log.info(`[AgentRuntime] Tool lookup: ${toolName}, fixedParams=${fixedParams ? 'present' : 'none'}`);
    onEvent('tool_start', { name: toolName, args: toolArgs });

    // Per-tool abort check: if the client has already disconnected, skip
    // remaining tool work in this batch rather than ploughing on.
    if (signal?.aborted) {
        return {
            toolCall,
            toolName,
            toolArgs,
            finalToolResult: '[Tool execution skipped — client aborted]',
            blocked: true
        };
    }

    const _regexRefusal = regexInputGuard(rc, { toolCall, toolName, toolArgs });
    if (_regexRefusal) return _regexRefusal;

    // ── Pre-dispatch tool-PII block (generalizes the Web Search Guard) ──
    // Args now hold REAL values (detokenized above), so refuse the call
    // if any detected PII category is in this tool-class's block list.
    // Web search with a configured-but-disabled guard stays monitor-only
    // (logged, allowed) to preserve historical behavior.
    const _monitorCats = monitorCategoriesFor(rc, toolName);
    if (policy._blockCats.size > 0 || _monitorCats) {
        const _piiRefusal = await checkArgumentPii(rc, deps, { toolCall, toolName, toolArgs, policy, _monitorCats });
        if (_piiRefusal) return _piiRefusal;
    }

    // Gate 2, last stop before dispatch.
    const _hold = holdForConfirmation(rc, deps, { toolCall, toolName, toolArgs, verdict: _verdict });
    if (_hold) return _hold;

    return dispatchToolCall(rc, deps, { toolCall, toolName, toolArgs, fixedParams, policy });
}

async function executeToolRound({
    currentToolCalls, toolCalls, signal, onEvent, messages, durableMessages,
    persistDurable, dlpShield, regexConfig, webSearchGuardEnabled,
    webSearchGuardPiiCategories, toolParamsMap, userAuth, userId, agent,
    agentId, conversation, modelToUse, messageMetadata, onSkillsActivated,
    toolPolicy = null,
    _failingToolCounts, MAX_TOOL_REPEAT, _toolHistory, _emailDrafts,
    _calendarDrafts, _linkedInDrafts, _mapEmbeds, _audioFiles, _generatedFiles = [],
    _kbSources, _seenChunkIds, _pendingToolCalls = [], _pendingToolCounts = new Map(),
}) {
    // Borrowed-connection attribution for this batch, keyed by
    // toolCall.id — bridges the dispatch closure to the (separate)
    // egress-logging scope. Empty unless lending resolves a grant.
    const _lentByToolCall = new Map();

    // The confirmation brake. `_pendingToolCounts` belongs to the
    // TURN (the caller owns it, like `_failingToolCounts`) and
    // counts how many ROUNDS one action has sat waiting; this Set
    // is per round, so a batch that names the same action twice
    // yields one card and one count instead of two.
    const _heldThisRound = new Set();

    // ── The testchat's two extras (A4) ───────────────────────
    // `_isTestChatRound` widens gate 2 (nothing that is not a read
    // runs unasked); `_toolDecisions` is what the person clicked on
    // the card of a PREVIOUS turn, keyed by the hashed action.
    //
    // The Map is parked back on `messageMetadata`, which is the
    // TURN's object (the route builds one per request and every
    // round is handed the same one). That is what makes "one yes
    // runs one action" true across rounds: a per-round copy would
    // hand the same approval out again on the model's next attempt,
    // and a turn that retries a send three times would send it
    // three times off one click.
    const _isTestChatRound = testChatMod.isTestChat(messageMetadata);
    let _toolDecisions = new Map();
    if (_isTestChatRound) {
        if (!(messageMetadata.toolDecisions instanceof Map)) {
            messageMetadata.toolDecisions =
                testChatMod.normaliseToolDecisions(messageMetadata.toolDecisions);
        }
        _toolDecisions = messageMetadata.toolDecisions;
    }

    // The round context the steps read: the round's inputs plus the
    // per-round state above. `pendingLoopDetected` is the one field a step
    // writes (gate 2's brake).
    const rc = {
        signal, onEvent, dlpShield, regexConfig, webSearchGuardEnabled,
        webSearchGuardPiiCategories, toolParamsMap, userAuth, userId, agent,
        agentId, conversation, modelToUse, messageMetadata, onSkillsActivated,
        toolPolicy, toolCalls, messages, durableMessages, MAX_TOOL_REPEAT,
        _toolHistory, _emailDrafts, _calendarDrafts, _linkedInDrafts, _mapEmbeds,
        _audioFiles, _generatedFiles, _kbSources, _seenChunkIds,
        _pendingToolCalls, _pendingToolCounts,
        _lentByToolCall, _heldThisRound, _isTestChatRound, _toolDecisions,
        pendingLoopDetected: false,
    };

    // Execute all tools in parallel
    const toolExecutionPromises = currentToolCalls.map((toolCall) => runToolCall(rc, toolCall));

    // Wait for all tools to complete. Use allSettled defensively — every
    // path inside the map already returns a sentinel object, but a future
    // refactor that throws synchronously shouldn't take the whole turn down.
    log.info(`[AgentRuntime] Executing ${currentToolCalls.length} tools in parallel...`);
    const settled = await Promise.allSettled(toolExecutionPromises);
    const toolResults = settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        const tc = currentToolCalls[i];
        const name = tc?.function?.name || 'unknown';
        log.error(`[AgentRuntime] Tool '${name}' unexpectedly rejected:`, s.reason?.message || s.reason);
        return {
            toolCall: tc,
            toolName: name,
            toolArgs: {},
            finalToolResult: `[Tool '${name}' failed: ${s.reason?.message || 'unknown error'}]`,
            blocked: true
        };
    });

    // Detect deterministic tool-call loops: if the model has called the
    // same (name, args) tuple and it has failed multiple iterations in a
    // row, stop now rather than burning the iteration budget.
    let _shouldBailOnLoop = false;
    for (const result of toolResults) {
        const fr = result?.finalToolResult;
        // A call parked for approval is not a failing call. Counting
        // it here would end the turn on "a tool kept failing" while
        // the tool has not run at all — so a held call has its OWN
        // brake at the hold above, counting the rounds it stays
        // parked and bailing on this same threshold.
        if (result?.confirmPending === true) continue;
        const looksLikeFailure = result?.blocked === true
            || (typeof fr === 'string' && fr.startsWith('[Tool '));
        if (!looksLikeFailure) continue;
        const key = `${result.toolName}|${_stableStringify(result.toolArgs || {})}`;
        const count = (_failingToolCounts.get(key) || 0) + 1;
        _failingToolCounts.set(key, count);
        if (count >= MAX_TOOL_REPEAT) {
            log.warn(`[AgentRuntime] Tool '${result.toolName}' failed ${count}× with identical args — breaking out of loop to avoid budget burn`);
            _shouldBailOnLoop = true;
        }
    }

    await processToolResults(rc, deps, toolResults);

    // Save conversation after tool execution (so tool calls are persisted)
    log.info(`[AgentStream] Saving conversation with tool calls: ${durableMessages.length} messages`);
    await persistDurable();

    // Why the loop should stop, or null to keep going. A reason rather than a
    // boolean because the two are not interchangeable downstream: the nudge and
    // the sentence the user reads differ, and "a tool kept failing" is a lie
    // about a call that never ran. A real failure wins when both tripped — it
    // is the one the user can act on.
    if (_shouldBailOnLoop) return 'repeated_failure';
    if (rc.pendingLoopDetected) return 'pending_confirmation';
    return null;
}

module.exports = {
    executeToolRound,
    buildLLMToolContent,
    truncateToolContent,
    MAX_TOOL_CONTENT_BYTES,
    _stableStringify,
    _flattenToolRoundTrips,
};

/**
 * @typedef {import('./chatStream/turnState').ToolCall} RoundToolCall
 * @typedef {{ enabled?: boolean, scope?: { toolInput?: boolean, toolOutput?: boolean }, rulesWithNames?: Parameters<typeof import('../privacy/guardrails').checkRegexPatterns>[1] } | null} RoundRegexConfig
 * @typedef {Awaited<ReturnType<typeof import('../integrations/connectionResolution').resolveEffectiveIdentity>>} LentConnection
 * @typedef {typeof deps} ToolRoundDeps
 */

/**
 * What one tool call ends as: its result (or a refusal sentinel) and how it got there.
 * `finalToolResult` is whatever the tool returned — a string or any JSON value.
 * @typedef {{ toolCall: RoundToolCall, toolName: string, toolArgs: Record<string, unknown>, finalToolResult: unknown, blocked: boolean, policyRefused?: boolean, confirmPending?: boolean, confirmDeclined?: boolean, outboundProbe?: Awaited<ReturnType<typeof import('../http/outboundProbe').runWithProbe>>['probe'], dispatchMs?: number, toolClass?: string, blockCats?: string[] }} ToolCallOutcome
 */

/**
 * The inputs of one tool round, as the streaming runtime hands them over.
 * @typedef {{
 *   currentToolCalls: RoundToolCall[], toolCalls: Record<string, unknown>[], signal?: AbortSignal,
 *   onEvent: import('./chatStream/turnState').OnEvent, messages: import('./chatStream/turnState').ChatMessage[], durableMessages: import('./chatStream/turnState').ChatMessage[],
 *   persistDurable: () => Promise<unknown>,
 *   dlpShield: Awaited<ReturnType<typeof import('../privacy/orgShield').resolveShieldFor>>,
 *   regexConfig: RoundRegexConfig, webSearchGuardEnabled: boolean, webSearchGuardPiiCategories: string[],
 *   toolParamsMap: Record<string, unknown>, userAuth: import('./chatStream/turnState').UserAuth, userId: string,
 *   agent: import('./chatStream/turnState').AgentRow, agentId: string, conversation: import('./chatStream/turnState').ConversationRow, modelToUse: string,
 *   messageMetadata: import('./chatStream/turnState').MessageMetadata, onSkillsActivated?: unknown,
 *   toolPolicy?: Parameters<typeof decideToolCall>[0]['policy'],
 *   _failingToolCounts: Map<string, number>, MAX_TOOL_REPEAT: number,
 *   _toolHistory: Record<string, unknown>[], _emailDrafts: Record<string, unknown>[],
 *   _calendarDrafts: Record<string, unknown>[], _linkedInDrafts: Record<string, unknown>[],
 *   _mapEmbeds: Record<string, unknown>[], _audioFiles: Record<string, unknown>[],
 *   _generatedFiles?: Record<string, unknown>[], _kbSources: Record<string, unknown>[],
 *   _seenChunkIds: Set<string>, _pendingToolCalls?: Record<string, unknown>[],
 *   _pendingToolCounts?: Map<string, number>,
 * }} ToolRoundInput
 */

/**
 * The round context the ./toolRound/ steps read: the round's inputs plus the per-round state.
 * @typedef {Omit<ToolRoundInput, 'currentToolCalls' | 'persistDurable' | '_failingToolCounts'> & { _lentByToolCall: Map<string, LentConnection>, _heldThisRound: Set<string>, _isTestChatRound: boolean, _toolDecisions: Map<string, 'approve'|'decline'>, pendingLoopDetected: boolean }} ToolRoundContext
 */
