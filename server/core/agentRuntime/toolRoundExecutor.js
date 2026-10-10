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
const { sanitizeToolResult } = require('../../utils/sanitize');
// Egress rows now flow through core/integrationLogging.js (lazy-required at
// the call sites) — the store is no longer used directly here.
const { resolveIntegration } = require('../integrations/integrationToolMap');
const { runWithProbe, markLocal } = require('../http/outboundProbe');
const usageStore = require('../../stores/usageStore');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { checkRegexPatterns } = require('../privacy/guardrails');
const { untokeniseToolArgs } = require('../dlp/applyTokenMapToOutbound');
const { decideToolCall, previewToolArgs, mayLendOwnerConnection } = require('./toolPolicy');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { scanCategoriesFor } = require('../privacy/customTypes/plan');
const log = require('../../telemetry/log');

// Lazy, like the per-call require below: orgShield is where tool classes are
// decided, and loading it here would pull the shield into this module's graph.
const _toolClassOf = (name) => require('../privacy/orgShield').classifyToolClass(name);

// Agent tools whose result carries the `documentId` of a Studio document they wrote.
const STUDIO_WRITE_TOOLS = new Set(['create_presentation']);

/**
 * Serialize a tool result for the LLM's tool message.
 *
 * The server stores "internal" fields on tool results (prefixed with `_`,
 * or the `_action` dispatch field) which chatStream intercepts to emit SSE
 * events or save persistence state. The LLM only needs the *outcome*; sending
 * the bulky UI-facing payload (e.g. kb_sources' `_sources` duplicates `results`
 * at full 3000-char content) wastes tokens and distracts the model.
 *
 * Rules:
 *   - Strings pass through verbatim.
 *   - Special-case workspace_update → tiny confirmation.
 *   - Otherwise: drop every key starting with `_` (e.g. `_action`, `_sources`)
 *     and drop known noise fields (`instruction`, `resultCount`) that are
 *     superseded by the agent's system prompt.
 */
// Hard cap on tool result string fed to the model. A misbehaving tool that
// returns several megabytes of JSON can blow the context window or rack up
// token charges; truncate with a clear marker so the model knows.
const MAX_TOOL_CONTENT_BYTES = 128 * 1024;
function truncateToolContent(s) {
    if (typeof s !== 'string') return s;
    if (s.length <= MAX_TOOL_CONTENT_BYTES) return s;
    return s.slice(0, MAX_TOOL_CONTENT_BYTES) + `\n…[tool output truncated at ${MAX_TOOL_CONTENT_BYTES} chars]`;
}
function buildLLMToolContent(finalToolResult) {
    if (typeof finalToolResult === 'string') return truncateToolContent(finalToolResult);
    if (finalToolResult == null || typeof finalToolResult !== 'object') {
        return truncateToolContent(JSON.stringify(finalToolResult));
    }

    // Strip bulky notebook content — LLM only needs the confirmation message.
    if (finalToolResult._action === 'workspace_update' && finalToolResult.message) {
        return JSON.stringify({ action: 'notebook_updated', message: finalToolResult.message });
    }

    const NOISE_KEYS = new Set(['instruction', 'resultCount']);
    const clean = {};
    for (const [k, v] of Object.entries(finalToolResult)) {
        if (k.startsWith('_')) continue;     // Internal dispatch / UI-only fields
        if (NOISE_KEYS.has(k)) continue;     // Redundant with system prompt
        clean[k] = v;
    }
    return truncateToolContent(JSON.stringify(clean));
}

// Withholding the tool list is only half of a wrap-up round: the tool
// ROUND-TRIP has to leave the transcript with it. The Anthropic Messages API
// rejects a request that carries `tool_use`/`tool_result` blocks with no
// `tools` defined ("Requests which include `tool_use` or `tool_result` blocks
// must define tools"), and core/providers/claude.js only sets `params.tools`
// when `options.tools?.length > 0` while its normalizeMessages still converts
// the assistant `tool_calls` and `role:'tool'` rows into those blocks — so on
// the agent-chat default provider the wrap-up round 400'd and the turn ended
// on the same error banner the bail exists to avoid. Flattening each call and
// its result into plain prose keeps the context, keeps the request valid on
// every provider, and leaves no structured tool surface to call back into.
function _flattenToolRoundTrips(msgs) {
    const nameById = new Map();
    const out = [];
    for (const m of msgs) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const lines = [];
            for (const tc of m.tool_calls) {
                const fn = (tc && tc.function) || {};
                const name = fn.name || 'tool';
                if (tc && tc.id) nameById.set(tc.id, name);
                const args = typeof fn.arguments === 'string'
                    ? fn.arguments
                    : JSON.stringify(fn.arguments || {});
                lines.push(`[Called tool ${name} with ${args}]`);
            }
            const head = typeof m.content === 'string' ? m.content : '';
            out.push({ role: 'assistant', content: [head, ...lines].filter(Boolean).join('\n') });
            continue;
        }
        if (m && m.role === 'tool') {
            const name = nameById.get(m.tool_call_id) || 'tool';
            const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            out.push({ role: 'user', content: `[Result of tool ${name}]\n${body}` });
            continue;
        }
        out.push(m);
    }
    return out;
}
function _stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(_stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + _stableStringify(value[k])).join(',') + '}';
}

const testChatMod = require('./testChat');

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
                let _pendingLoopDetected = false;

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

                // Execute all tools in parallel
                const toolExecutionPromises = currentToolCalls.map(async (toolCall) => {
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
                            toolCall,
                            toolName,
                            toolArgs,
                            finalToolResult: `[Tool '${toolName}' arguments were not valid JSON: ${jsonParseError}. Please re-emit the tool call with well-formed JSON.]`,
                            blocked: true
                        };
                    }

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
                            toolCall, toolName, toolArgs,
                            finalToolResult: `[Tool '${toolName}' is not available to this agent and was not called. Use only the tools you were given.]`,
                            blocked: true,
                            policyRefused: true,
                        };
                    }

                    // Org tool-PII policy for this tool's CLASS (external = data leaves
                    // the box, internal = on-box). Resolved once per tool call and
                    // reused by the pre-dispatch block check AND the result-redaction
                    // step below. classifyToolClass lives in orgShield (single source
                    // of truth shared with the admin route/UI).
                    const { classifyToolClass: _classifyToolClass } = require('../privacy/orgShield');
                    const _toolClass = _classifyToolClass(toolName, toolArgs);
                    const _piiThreshold = (typeof dlpShield?.piiDetectionConfidenceThreshold === 'number')
                        ? dlpShield.piiDetectionConfidenceThreshold : 0.7;
                    const _blockCats = new Set((dlpShield?.toolPiiPolicy?.[_toolClass]?.blockCategories) || []);
                    // Legacy Web Search Guard: its category list still BLOCKS external
                    // tools, but only when the guard is actually enabled. Orgs that
                    // picked categories with the guard DISABLED stay monitor-only
                    // (logged, not blocked) — handled in the guard below.
                    if (_toolClass === 'external' && webSearchGuardEnabled && Array.isArray(webSearchGuardPiiCategories)) {
                        for (const c of webSearchGuardPiiCategories) _blockCats.add(c);
                    }

                    // Restore DLP tokens in outbound tool args so EVERY tool —
                    // including web/agent search — receives the real value, not the
                    // [email_1] placeholder (BFSF-171). The block policy above is now
                    // the only thing that withholds PII from a tool.
                    try {
                        const _argMap = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
                        if (_argMap && Object.keys(_argMap).length) toolArgs = untokeniseToolArgs(toolArgs, _argMap);
                    } catch (_) { /* best-effort: leave args tokenized on error */ }

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

                    // Regex Guardrails - Tool Input scope
                    if (regexConfig?.enabled && regexConfig?.scope?.toolInput) {
                        const matches = checkRegexPatterns(JSON.stringify(toolArgs), regexConfig.rulesWithNames);
                        if (matches.length > 0) {
                            const ruleNames = matches.map(m => m.ruleName).join(', ');
                            log.info(`[RegexGuard] Tool input violated rules: ${ruleNames}`);
                            onEvent('tool_end', { name: toolName, result: `[Tool input blocked - violates ${ruleNames} policy]` });
                            return {
                                toolCall,
                                toolName,
                                toolArgs,
                                finalToolResult: `[Tool input blocked - violates ${ruleNames} policy]`,
                                blocked: true
                            };
                        }
                    }

                    // ── Pre-dispatch tool-PII block (generalizes the Web Search Guard) ──
                    // Args now hold REAL values (detokenized above), so refuse the call
                    // if any detected PII category is in this tool-class's block list.
                    // Web search with a configured-but-disabled guard stays monitor-only
                    // (logged, allowed) to preserve historical behavior.
                    const _isSearchTool = /^(agent_search|web_search|search|brave_search|browse_web|read_url)$/i.test(toolName || '');
                    const _monitorCats = (_isSearchTool && !webSearchGuardEnabled
                        && Array.isArray(webSearchGuardPiiCategories) && webSearchGuardPiiCategories.length)
                        ? webSearchGuardPiiCategories : null;
                    if (_blockCats.size > 0 || _monitorCats) {
                        const { detectPii } = require('../privacy/piiDetection');
                        const _checkCats = [...new Set([..._blockCats, ...(_monitorCats || [])])];
                        let _argPii = null, _guardErr = false;
                        try {
                            _argPii = await detectPii(JSON.stringify(toolArgs || {}), _checkCats, _piiThreshold);
                        } catch (e) {
                            _guardErr = true;
                            log.warn('[ToolPiiGuard] arg PII check failed:', e.message);
                        }
                        // A degraded scan is NOT a clean scan. detectPii returns
                        // { degraded: true, entities: [] } WITHOUT throwing when the
                        // guard is unreachable or the model isn't loaded, so treating
                        // only thrown errors as failure let a degraded result fall
                        // through to `_argPii?.hasPii === false` and dispatch the tool
                        // with unredacted args. That is an egress path, and it gets
                        // strictly worse under GLiNER-only: today a degraded response
                        // still carries regex hits, afterwards it carries nothing.
                        // (detectPii returning null means the guard isn't installed at
                        // all — that stays fail-open, matching every other consumer.)
                        if (!_guardErr && _argPii?.degraded) {
                            _guardErr = true;
                            log.warn('[ToolPiiGuard] arg PII scan degraded:',
                                _argPii.degradedReason || 'unknown');
                        }

                        if (_guardErr) {
                            // Fail-closed ONLY for block-action orgs with an active block
                            // list; otherwise fail-open (matches the legacy guard).
                            if (_blockCats.size > 0 && dlpShield?.privacyAction === 'block') {
                                onEvent('tool_end', { name: toolName, result: `[Tool blocked — PII guard unavailable (fail-closed)]` });
                                return {
                                    toolCall, toolName, toolArgs,
                                    finalToolResult: `[Tool '${toolName}' was not called: the PII guard is unavailable and org policy fails closed. Ask the user to retry shortly.]`,
                                    blocked: true,
                                };
                            }
                            // else fall through and execute (fail-open)
                        } else if (_argPii?.hasPii) {
                            // A span an org's own data type won still carries
                            // the built-in categories it covered (alsoCategories).
                            const _hitsAny = (e, cats) => cats.has(e.category)
                                || (Array.isArray(e.alsoCategories) && e.alsoCategories.some(c => cats.has(c)));
                            const _logLabel = (e) => (isCustomTypeId(e.category) ? e.category : e.label);
                            const _blockedHits = _argPii.entities.filter(e => _hitsAny(e, _blockCats));
                            if (_blockedHits.length > 0) {
                                const _labels = [...new Set(_blockedHits.map(e => e.label))].join(', ');
                                guardrailEventStore.logGuardrailEvent({
                                    organization_id: agent.organization_id || null,
                                    user_id: userId, agent_id: agentId, agent_name: agent.name,
                                    conversation_id: conversation?.id || null,
                                    violation_type: 'pii', violation_categories: _labels,
                                    direction: 'output', action_taken: 'tool_blocked',
                                    // Een testbeurt schrijft onder zijn eigen bron en als
                                    // droogloop — zie testChat.js.
                                    source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                                    is_dry_run: testChatMod.isDryRunTurn(messageMetadata),
                                    model: modelToUse,
                                }).catch(() => {});
                                log.info(`[ToolPiiGuard] '${toolName}' (${_toolClass}) BLOCKED — args contain ${[...new Set(_blockedHits.map(_logLabel))].join(', ')}`);
                                onEvent('tool_end', { name: toolName, result: `[Tool blocked — arguments contain sensitive information (${_labels})]` });
                                return {
                                    toolCall, toolName, toolArgs,
                                    finalToolResult: `[Tool '${toolName}' was not called: its arguments contained ${_labels}, which org policy forbids sending to ${_toolClass} tools. Continue without that information or ask the user how to proceed.]`,
                                    blocked: true,
                                };
                            }
                            // Monitor-only (search guard configured but disabled): log, allow.
                            if (_monitorCats) {
                                const _monHits = _argPii.entities.filter(e => _hitsAny(e, new Set(_monitorCats)));
                                if (_monHits.length > 0) {
                                    const _monLabels = [...new Set(_monHits.map(e => e.label))].join(', ');
                                    guardrailEventStore.logGuardrailEvent({
                                        organization_id: agent.organization_id || null,
                                        user_id: userId, agent_id: agentId, agent_name: agent.name,
                                        conversation_id: conversation?.id || null,
                                        violation_type: 'pii', violation_categories: _monLabels,
                                        direction: 'output', action_taken: 'pii_detected',
                                        source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                                        is_dry_run: testChatMod.isDryRunTurn(messageMetadata),
                                        model: modelToUse,
                                    }).catch(() => {});
                                    log.info(`[ToolPiiGuard] PII in ${toolName} args (${[...new Set(_monHits.map(_logLabel))].join(', ')}) — monitor-only, allowed`);
                                }
                            }
                        }
                    }

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
                            _pendingLoopDetected = true;
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

                    // Use unified tool dispatcher — supports integrations + components.
                    // Wrap in runWithProbe so any outbound fetch via probedFetch
                    // records the actual peer IP for the egress dashboard.
                    // Catch per-tool exceptions so one failing tool doesn't reject the
                    // whole batch — the model receives the error as a tool result and
                    // can decide how to react.
                    const { executeTool: dispatchTool } = require('../tools/toolDispatcher');

                    // Connection lending (GATED, default off): a shared agent run
                    // by another user may borrow the OWNER's named connection for
                    // this tool (full delegation). Inert — and zero DB cost —
                    // unless INTEGRATION_CONNECTION_LENDING_ENABLED is set; with it
                    // off, effUserId === userId so behavior is unchanged. Never
                    // overrides an explicit acting identity.
                    let effUserId = userAuth?.integrationUserId || userId;
                    let lentConnection = null;
                    try {
                        const cr = require('../integrations/connectionResolution');
                        // `actAs` is the OWNER's per-app answer to "may this
                        // run on my connection?", and until now nothing asked
                        // it: a lend grant alone borrowed the connection for
                        // every tool of that provider, so an app the owner had
                        // deliberately left on "as the person asking" borrowed
                        // it anyway. The whole question — including which
                        // agents it may be asked of at all — lives in
                        // `mayLendOwnerConnection`, because chatWithAgent has
                        // to ask exactly the same one. It never throws, and
                        // this block's catch already falls back to
                        // bring-your-own if anything here does.
                        const _mayLend = mayLendOwnerConnection(toolName, agent?.config);
                        if (cr.isLendingEnabled() && !userAuth?.integrationUserId && _mayLend) {
                            if (!userAuth.__runCtx) userAuth.__runCtx = await cr.runningUserContext(userId);
                            const ov = await cr.resolveEffectiveIdentity({
                                toolName, runningUserId: userId,
                                runningUserOrgId: userAuth.__runCtx.orgId,
                                runningUserGroups: userAuth.__runCtx.groups,
                                ownerUserId: agent.owner_id || null,
                                resourceType: 'agent', resourceId: agent.id,
                            });
                            if (ov) { effUserId = ov.integrationUserId; lentConnection = ov; _lentByToolCall.set(toolCall.id, ov); }
                        }
                    } catch (_) { /* fail closed to bring-your-own */ }

                    let toolResult;
                    let outboundProbe;
                    const dispatchT0 = Date.now();
                    {
                        // The wrapped fn NEVER throws through runWithProbe: a
                        // throw used to discard the probe (peer IP, TLS name)
                        // and with it the audit row — a failed call whose bytes
                        // had already left the box was simply not in the ledger.
                        const probed = await runWithProbe(async () => {
                            const preMeta = resolveIntegration(toolName, toolArgs || {});
                            if (preMeta?.isLocal) markLocal(preMeta.label || preMeta.integration);
                            try {
                                return {
                                    ok: true,
                                    value: await dispatchTool(toolName, toolArgs, {
                                        userId: effUserId,
                                        // The person who actually asked, never
                                        // an acting or borrowed identity.
                                        // `effUserId` above is the INTEGRATION
                                        // identity: the Support inbox's
                                        // operator (userAuth.integrationUserId)
                                        // or a lent connection's owner. That is
                                        // right for an OAuth token and wrong
                                        // for anything that decides which ROWS
                                        // somebody may see — a datatable read
                                        // keyed on it would answer as the
                                        // operator while the asker watches.
                                        // Tools that make access decisions of
                                        // their own read this one.
                                        askerUserId: userId,
                                        // "Test as · group X" (A1c). Only the
                                        // KB door reads it, and only to take
                                        // bases away; it is not an identity
                                        // and it never reaches a permission,
                                        // an entitlement or a connection.
                                        testAs: messageMetadata.testAs || null,
                                        session: userAuth?.session,
                                        userAuth,
                                        // Automation/cowork runs set this: there is no one
                                        // present to approve an email draft, so a
                                        // composed mail must actually go out instead of
                                        // parking forever. Absent (normal chat) it stays
                                        // false and the draft-preview flow is unchanged.
                                        autoSend: !!messageMetadata.autoSend,
                                        // Pinned so the line above can't promote custom
                                        // integrations to unattended dispatch, which
                                        // their runner refuses outright.
                                        unattended: false,
                                        fixedParams: fixedParams,
                                        agentId: agent.id,
                                        // This path holds a call on 'ask' until the
                                        // person approved it, so the dispatcher may
                                        // run an automation granted on 'ask'.
                                        confirmLayer: true,
                                        conversationId: conversation.id,
                                        send: onEvent,
                                        req: messageMetadata.req || null,
                                        // BFSF-254: browser timezone (used by calendar
                                        // tools; already in the "Now:" prompt line).
                                        timezone: messageMetadata.timezone || null,
                                        nanoBananaSettings: messageMetadata.nanoBananaSettings || null,
                                        onImageGenerated: (data) => {
                                            onEvent('image', data);
                                        },
                                        // Org context — activate_skill (and other org-scoped
                                        // tools) need it; was previously only set when a lent
                                        // connection overrode it below, which silently broke
                                        // dynamic-skill activation on the agent streaming path.
                                        orgId: messageMetadata.orgId || agent.organization_id || null,
                                        // Per-chat memory controls, for memory_search / memory_remember.
                                        memoryReadEnabled: messageMetadata.memoryReadEnabled,
                                        memoryWriteEnabled: messageMetadata.memoryWriteEnabled,
                                        // Skill-scoped app enablement: lets activate_skill
                                        // widen the integration toolbelt mid-conversation.
                                        onSkillsActivated,
                                        ...(lentConnection ? { orgId: lentConnection.integrationOrgId, lentConnection } : {}),
                                    }),
                                };
                            } catch (err) {
                                return { ok: false, error: err };
                            }
                        });
                        outboundProbe = probed.probe;
                        if (!probed.result?.ok) {
                            const toolErr = probed.result?.error;
                            log.error(`[AgentRuntime] Tool '${toolName}' threw:`, toolErr?.message || toolErr);
                            const errMsg = toolErr?.message || String(toolErr);
                            // Failed calls get an egress row too — with status.
                            try {
                                const { logToolEgress } = require('../integrations/integrationLogging');
                                const _lentErr = _lentByToolCall.get(toolCall.id) || null;
                                logToolEgress({
                                    toolName,
                                    toolArgs,
                                    error: toolErr,
                                    probe: outboundProbe,
                                    source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                                    isDryRun: testChatMod.isDryRunTurn(messageMetadata),
                                    model: modelToUse,
                                    durationMs: Date.now() - dispatchT0,
                                    session: userAuth?.session || null,
                                    ids: {
                                        organization_id: agent.organization_id || null,
                                        user_id: userId,
                                        agent_id: agentId,
                                        agent_name: agent.name,
                                        conversation_id: conversation?.id || null,
                                        acting_user_id: _lentErr ? _lentErr.integrationUserId : null,
                                        connection_id: _lentErr ? _lentErr.connectionId : null,
                                        grant_id: _lentErr ? _lentErr.grantId : null,
                                    },
                                });
                            } catch (_) { /* never fail the turn on logging */ }
                            return {
                                toolCall,
                                toolName,
                                toolArgs,
                                finalToolResult: `[Tool '${toolName}' failed: ${errMsg}]`,
                                blocked: true
                            };
                        }
                        toolResult = probed.result.value;
                    }

                    // Regex Guardrails - Tool Output scope
                    let finalToolResult = toolResult;
                    if (regexConfig?.enabled && regexConfig?.scope?.toolOutput) {
                        const matches = checkRegexPatterns(JSON.stringify(toolResult), regexConfig.rulesWithNames);
                        if (matches.length > 0) {
                            const ruleNames = matches.map(m => m.ruleName).join(', ');
                            log.info(`[RegexGuard] Tool output violated rules: ${ruleNames}`);
                            finalToolResult = `[Tool output redacted - contains ${ruleNames} content]`;
                        }
                    }

                    return {
                        toolCall,
                        toolName,
                        toolArgs,
                        finalToolResult,
                        outboundProbe,
                        blocked: false,
                        // The egress logger runs in the results loop — a DIFFERENT
                        // scope — so the dispatch duration must travel on the result
                        // object like outboundProbe does. Referencing dispatchT0
                        // from the loop was a silent ReferenceError inside the
                        // logging try/catch: no success row was ever written.
                        dispatchMs: Date.now() - dispatchT0,
                        // Carry the resolved tool-PII policy out to the result loop
                        // (different scope) so it can redact blocked-category PII and
                        // tokenize the rest before the result is shown to the model.
                        toolClass: _toolClass,
                        blockCats: [..._blockCats],
                    };
                });

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

                // ── Pre-scan tool results for PII, CONCURRENTLY ────────────────
                // The redaction scan used to sit inside the sequential loop
                // below, so N tool results meant N serialised guard round-trips
                // of up to MAX_TOOL_CONTENT_BYTES each, all on the critical
                // path before the next model round. Hoisting it here overlaps
                // them; the loop stays sequential so ordering, the token map
                // and conversation bookkeeping are untouched.
                //
                // Bounded deliberately. The guard's own semaphore is 2
                // (GUARD_PII_MAX_CONCURRENCY), so an unbounded fan-out would
                // not finish sooner — it would queue there, and a 10-tool round
                // would hold both slots and push a CONCURRENT user's
                // pre-first-token scan behind the whole burst.
                const _TOOL_SCAN_CONCURRENCY = 3;
                // privacy_scan_knowledge_bases=false: the org does not want
                // knowledge-base content tokenised. Such a result is still held to
                // the tool class's block list (strip, never tokenise).
                const _kbTokenisingOff = (r) => dlpShield?.privacy_scan_knowledge_bases === false
                    && (r.finalToolResult?._action === 'kb_sources' || r.toolName === 'kb_search');
                const _preScans = new Array(toolResults.length).fill(null);
                if (dlpShield?.enabled) {
                    const { detectPii: _detectPii } = require('../privacy/piiDetection');
                    const _preThreshold = (typeof dlpShield.piiDetectionConfidenceThreshold === 'number')
                        ? dlpShield.piiDetectionConfidenceThreshold : 0.7;
                    let _nextIdx = 0;
                    const _scanWorker = async () => {
                        for (;;) {
                            const i = _nextIdx++;
                            if (i >= toolResults.length) return;
                            const content = buildLLMToolContent(toolResults[i].finalToolResult);
                            if (typeof content !== 'string' || content.length === 0) continue;
                            const scanStr = content.slice(0, MAX_TOOL_CONTENT_BYTES);
                            const entry = { content, scanStr, threshold: _preThreshold, pii: null, failed: false };
                            try {
                                // Every built-in category, as before, plus the
                                // org's own data types that are hidden from the
                                // AI or blocked for this tool's class.
                                const _kbOff = _kbTokenisingOff(toolResults[i]);
                                const _resBlock = Array.isArray(toolResults[i].blockCats) ? toolResults[i].blockCats : [];
                                if (_kbOff && _resBlock.length === 0) continue; // nothing to strip, nothing to tokenise
                                const _resCats = _kbOff ? _resBlock : scanCategoriesFor(dlpShield, _toolClassOf(toolResults[i].toolName));
                                entry.pii = await _detectPii(scanStr, _resCats, _preThreshold);
                            } catch (e) {
                                // Fail-open, exactly as the in-loop version did.
                                entry.failed = true;
                                log.warn('[ToolResultDlp] result scan failed (fail-open):', e.message);
                            }
                            _preScans[i] = entry;
                        }
                    };
                    await Promise.all(
                        Array.from({ length: Math.min(_TOOL_SCAN_CONCURRENCY, toolResults.length) },
                                   () => _scanWorker()),
                    );
                }

                // Process results in order
                for (let _resIdx = 0; _resIdx < toolResults.length; _resIdx++) {
                    const result = toolResults[_resIdx];
                    const _preScan = _preScans[_resIdx];
                    const { toolCall, toolName, toolArgs, finalToolResult, outboundProbe } = result;
                    const _resBlockCats = new Set(Array.isArray(result.blockCats) ? result.blockCats : []);

                    toolCalls.push({ name: toolName, args: toolArgs, result: finalToolResult });
                    // Track for persistence
                    _toolHistory.push({
                        name: toolName,
                        args: toolArgs,
                        status: 'done',
                        resultPreview: (typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(finalToolResult || '')).slice(0, 200),
                    });
                    // Sanitize tool result before streaming to client to prevent API key exposure
                    onEvent('tool_end', { name: toolName, result: sanitizeToolResult(finalToolResult) });

                    // A tool that WROTE a Studio document (a presentation kept in the
                    // library): same event as direct chat, so open Documents lists and
                    // editors refresh. Only on a real document id, never on a plain
                    // tool result that merely mentions one.
                    if (STUDIO_WRITE_TOOLS.has(toolName) && finalToolResult?.documentId && !finalToolResult.error) {
                        onEvent('document_update', {
                            documentId: finalToolResult.documentId,
                            name: finalToolResult.file?.name || finalToolResult.name,
                            url: finalToolResult.documentUrl || finalToolResult.url,
                        });
                    }

                    // Emit email_draft SSE event for user approval (with dedup).
                    // Use a key derived via _stableStringify so the dedup is order-stable —
                    // JSON.stringify on object literals respects insertion order, and the
                    // model can produce slightly different draft object shapes that still
                    // mean the same draft.
                    if (finalToolResult?._action === 'email_draft') {
                        const draftKey = _stableStringify({ to: finalToolResult.draft?.to, subject: finalToolResult.draft?.subject, body: finalToolResult.draft?.body });
                        const alreadySent = _emailDrafts.some(d => _stableStringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
                        if (!alreadySent) {
                            onEvent('email_draft', finalToolResult.draft);
                            _emailDrafts.push({ ...finalToolResult.draft, status: 'pending' });
                        }
                    }
                    // Emit calendar_draft SSE event for user approval (with dedup).
                    // Key on the real draft fields, not the never-present
                    // summary/start/end which made dedup a no-op (BFSF-123).
                    if (finalToolResult?._action === 'calendar_draft') {
                        const calKey = (d) => _stableStringify({ action: d?.action, title: d?.title, startTime: d?.startTime, endTime: d?.endTime, eventId: d?.eventId });
                        const draftKey = calKey(finalToolResult.draft);
                        const alreadySent = _calendarDrafts.some(d => calKey(d) === draftKey);
                        if (!alreadySent) {
                            onEvent('calendar_draft', finalToolResult.draft);
                            _calendarDrafts.push({ ...finalToolResult.draft, status: 'pending' });
                        }
                    }
                    // Emit linkedin_draft SSE event for user approval
                    if (finalToolResult?._action === 'linkedin_draft') {
                        onEvent('linkedin_draft', finalToolResult.draft);
                        _linkedInDrafts.push({ ...finalToolResult.draft, status: 'pending' });
                    }


                    // Emit map_embed SSE event so map renders persist on messages
                    if (finalToolResult?._action === 'map_embed' && finalToolResult._mapEmbed) {
                        onEvent('map_embed', finalToolResult._mapEmbed);
                        _mapEmbeds.push(finalToolResult._mapEmbed);
                    }

                    // Emit workspace_update SSE event so frontend updates panel.
                    // Render-time un-tokenisation: stored content keeps the raw
                    // `[person_N]` tokens (so notebook_read in a later turn still
                    // works for the AI), but the user-facing SSE replaces them
                    // with the real values from the conversation token map.
                    if (finalToolResult?._action === 'workspace_update' && finalToolResult.content && finalToolResult.content.trim()) {
                        const { restoreTokens } = require('../privacy/piiDetection');
                        const _convMapForWs = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
                        const rendered = restoreTokens(finalToolResult.content, _convMapForWs);
                        onEvent('workspace_update', { content: rendered });
                    }

                    // Emit kb_sources SSE event so frontend shows knowledge base sources.
                    // Turn-local dedup: if a chunk_id has already been seen in a prior
                    // kb_search this turn, drop it from every surface (UI, persistence,
                    // AND the tool response the LLM will see).
                    if (finalToolResult?._action === 'kb_sources' && finalToolResult._sources?.length > 0) {
                        const keepIdx = [];
                        const resultsArr = Array.isArray(finalToolResult.results) ? finalToolResult.results : [];
                        finalToolResult._sources.forEach((src, i) => {
                            // A LIVE table row has no chunk id — it was never
                            // ingested — but it has a stable identity of its
                            // own, and falling through to the title/content
                            // hash would let one edited cell re-cite the same
                            // row twice in a turn.
                            const rowKey = (src.datatableId && src.rowId)
                                ? `datatable:${src.datatableId}:${src.rowId}`
                                : null;
                            const id = resultsArr[i]?.chunk_id
                                || rowKey
                                || (src.title || '') + '::' + (src.section || '') + '::' + (src.content || '').slice(0, 80);
                            if (!_seenChunkIds.has(id)) {
                                _seenChunkIds.add(id);
                                keepIdx.push(i);
                            }
                        });
                        const filteredSources = keepIdx.map(i => finalToolResult._sources[i]);
                        const filteredResults = keepIdx.map(i => resultsArr[i]).filter(Boolean);
                        const dropped = finalToolResult._sources.length - filteredSources.length;
                        if (dropped > 0) {
                            log.info(`[KBSearch] Turn-local dedup: dropped ${dropped} already-seen chunk(s) from kb_search result`);
                        }
                        // Mutate so downstream LLM serialization (buildLLMToolContent) sees the trimmed set.
                        finalToolResult._sources = filteredSources;
                        finalToolResult.results = filteredResults;
                        if (filteredSources.length > 0) {
                            onEvent('kb_sources', { sources: filteredSources });
                            _kbSources.push(...filteredSources);
                        }
                    }

                    // Track audio files for persistence (sent via SSE by the tool)
                    if (finalToolResult?.audioUrl) {
                        _audioFiles.push({ url: finalToolResult.audioUrl, source: toolName });
                    }
                    // A file a tool built (a deck): a card under the reply, whatever
                    // the model writes about it — and persisted with the message.
                    if (finalToolResult?.file && typeof finalToolResult.file === 'object') {
                        _generatedFiles.push(finalToolResult.file);
                        onEvent('file', finalToolResult.file);
                    }

                    // Log tool invocation for the per-tool dashboard. These rows
                    // intentionally carry zero token counts — tool execution
                    // doesn't consume model tokens. Cost-bearing queries
                    // (summary, by-model, by-source) filter `tool_name IS NULL`
                    // so these rows don't inflate call count or distort cost.
                    try {
                        await usageStore.logUsage({
                            user_id: userId,
                            agent_id: agentId,
                            agent_name: agent.name,
                            agent_type: 'chat',
                            model: modelToUse,
                            tool_name: toolName,
                            source: testChatMod.usageSourceFor(messageMetadata, 'agent_chat'),
                            organization_id: agent.organization_id || null,
                            conversation_id: conversation?.id || null,
                            parent_call_id: messageMetadata.parentCallId || null,
                        });
                    } catch (e) { /* ignore */ }

                    // ── Integration Activity Logging (async, non-blocking) ──
                    // One shared write path (core/integrationLogging.js): the
                    // minimal metadata row is ALWAYS written; the org's
                    // monitorIntegrations toggle only gates the PII scan.
                    //
                    // ONLY for successfully-dispatched calls: blocked sentinels
                    // either never dispatched (no bytes left — a row would be
                    // fabricated egress) or errored inside the map closure,
                    // where the error path already wrote a status='error' row.
                    // Logging them here again produced double rows and false
                    // 'success' statuses.
                    if (result.blocked !== true) try {
                        const { logToolEgress } = require('../integrations/integrationLogging');
                        const resultText = typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(finalToolResult || '');
                        const _lent = _lentByToolCall.get(toolCall.id) || null;
                        logToolEgress({
                            toolName,
                            toolArgs,
                            result: finalToolResult,
                            probe: outboundProbe || null,
                            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                            isDryRun: testChatMod.isDryRunTurn(messageMetadata),
                            model: modelToUse,
                            durationMs: result.dispatchMs,
                            session: userAuth?.session || null,
                            ids: {
                                organization_id: agent.organization_id || null,
                                user_id: userId,
                                agent_id: agentId,
                                agent_name: agent.name,
                                conversation_id: conversation?.id || null,
                                // Borrowed-connection attribution (null for bring-your-own runs).
                                acting_user_id: _lent ? _lent.integrationUserId : null,
                                connection_id: _lent ? _lent.connectionId : null,
                                grant_id: _lent ? _lent.grantId : null,
                            },
                            // Reuse the redaction scan instead of issuing a SECOND guard
                            // call for the same bytes. Both scan with categories=null, so
                            // when the thresholds agree and this text is genuinely a prefix
                            // of what was already scanned, the entities within range are
                            // exactly what a fresh scan would return.
                            //
                            // The prefix is CHECKED, not assumed: buildLLMToolContent()
                            // strips underscore-prefixed and noise keys and can restructure
                            // an object result, so _preScan.scanStr equals resultText only
                            // for plain-string tool results.
                            //
                            // Deliberately NOT "fixed" by auditing _preScan.content instead:
                            // that is what reaches the MODEL, whereas this row audits what
                            // came through the INTEGRATION. Stripped `_`-prefixed / UI-only
                            // fields can carry PII that reaches the user but not the model.
                            fullScan: async (_payloadText, threshold) => {
                                const logText = resultText.slice(0, 5000);
                                if (_preScan && !_preScan.failed && _preScan.pii
                                    && _preScan.threshold === threshold
                                    && _preScan.scanStr.startsWith(logText)) {
                                    const entities = (_preScan.pii.entities || [])
                                        .filter(e => e.offset + e.length <= logText.length);
                                    return { hasPii: entities.length > 0, entities };
                                }
                                const { detectPii } = require('../privacy/piiDetection');
                                return detectPii(logText, scanCategoriesFor(dlpShield, _toolClassOf(toolName)), threshold);
                            },
                        });
                    } catch (e) { /* ignore integration logging errors */ }

                    // ── Scan the tool RESULT for PII before the model sees it ──
                    // Detect "incoming" PII that arrives THROUGH a tool (web-search
                    // hits, contacts, calendar attendees, KB chunks via kb_search…).
                    //   (a) drop blocked-category PII — the refuse-class policy applies
                    //       to incoming data too;
                    //   (b) tokenize the remaining PII into the conversation map so it
                    //       round-trips: restored for the user on the response stream
                    //       (createUntokeniser) and restored to real values if the model
                    //       later passes it into another tool (untokeniseToolArgs).
                    // Fail-open everywhere: never drop the turn over a scan error.
                    let _toolContent = _preScan ? _preScan.content : buildLLMToolContent(finalToolResult);
                    if (dlpShield?.enabled && _preScan && !_preScan.failed) {
                        try {
                            const _dlpRunner = require('../dlp/dlpRunner');
                            const { redactAndTokenizeToolResult } = require('../dlp/toolResultRedact');
                            const _scanStr = _preScan.scanStr;
                            const _resPii = _preScan.pii;      // scanned concurrently above
                            // KB result with tokenising off: only blocked categories count.
                            if (_resPii?.entities && _kbTokenisingOff(result)) {
                                _resPii.entities = _resPii.entities.filter(e => _resBlockCats.has(e.category)
                                    || (Array.isArray(e.alsoCategories) && e.alsoCategories.some(c => _resBlockCats.has(c))));
                            }
                            if (_resPii?.hasPii && _resPii.entities?.length) {
                                const _existing = _dlpRunner.getConversationTokenMap(conversation?.id) || {};
                                const _r = redactAndTokenizeToolResult(_scanStr, _resPii.entities, _resBlockCats, _existing);
                                // Merge result-minted tokens into the conv map (round-trip + DB write-through).
                                if (_r.tokenMap && Object.keys(_r.tokenMap).length) _dlpRunner.mergeTokenMap(conversation?.id, _r.tokenMap);
                                if (_r.blockedCount > 0) {
                                    guardrailEventStore.logGuardrailEvent({
                                        organization_id: agent.organization_id || null,
                                        user_id: userId, agent_id: agentId, agent_name: agent.name,
                                        conversation_id: conversation?.id || null,
                                        violation_type: 'pii', violation_categories: _r.redactedLabels.join(', '),
                                        direction: 'input', action_taken: 'tool_result_redacted',
                                        source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                                        is_dry_run: testChatMod.isDryRunTurn(messageMetadata),
                                        model: modelToUse,
                                    }).catch(() => {});
                                    log.info(`[ToolResultDlp] '${toolName}' result redacted (${(_r.redactedLogLabels || []).join(', ')})`);
                                }
                                // tokenize-then-truncate so a [token] span is never split.
                                _toolContent = truncateToolContent(_r.content);
                            }
                        } catch (e) {
                            log.warn('[ToolResultDlp] result scan failed (fail-open):', e.message);
                        }
                    }
                    // Real history: later turns read pruned tool results back out
                    // of the transcript, and the UI filters them out on render.
                    const toolMsg = {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: _toolContent,
                    };
                    messages.push(toolMsg);
                    durableMessages.push(toolMsg);
                }

                // Save conversation after tool execution (so tool calls are persisted)
                log.info('[AgentStream] Saving conversation with tool calls:', JSON.stringify(durableMessages.slice(-3), null, 2));
                await persistDurable();

    // Why the loop should stop, or null to keep going. A reason rather than a
    // boolean because the two are not interchangeable downstream: the nudge and
    // the sentence the user reads differ, and "a tool kept failing" is a lie
    // about a call that never ran. A real failure wins when both tripped — it
    // is the one the user can act on.
    if (_shouldBailOnLoop) return 'repeated_failure';
    if (_pendingLoopDetected) return 'pending_confirmation';
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
