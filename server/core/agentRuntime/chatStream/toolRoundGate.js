/**
 * The gate a round's tool calls pass through before anything runs.
 *
 * Two steps, kept together because they are the same decision seen from two
 * sides. First the batch is made honest: identical side-effecting calls are
 * dropped BEFORE the assistant message is built, so no orphan tool_call_id is
 * ever persisted or replayed, and the reasoning that led to these calls is
 * snapshotted onto the message. Then the round's policy is built — per ROUND,
 * because `tools` is a live array a skill activation pushes into — and the
 * round is dispatched.
 *
 * Moved verbatim out of chatStream.js. The caller keeps the control flow (the
 * abort check between the two steps, and what a bail reason does to the loop).
 */
const { dedupeSideEffectToolCalls } = require('../toolCallDedupe');
const { executeToolRound, _stableStringify } = require('../toolRoundExecutor');
const { buildToolPolicy, fallbackToolPolicy, automationConfirmsFor } = require('../toolPolicy');
const log = require('../../../telemetry/log');

function buildRoundAssistantMessage({ currentToolCalls, contentBuffer, onEvent, _snapshotThinkingParts }) {
    // Clear intermediate planning text from the UI — only the final response
    // (from the last iteration without tool calls) should be visible to the user
    if (contentBuffer) {
        onEvent('content_replace', { text: '' });
    }

    // Drop identical side-effecting calls within this batch BEFORE the
    // assistant message is built, so no orphan tool_call_id (a call
    // without a tool result) is ever persisted or replayed to the LLM.
    {
        const { kept, dropped } = dedupeSideEffectToolCalls(currentToolCalls, { stableStringify: _stableStringify });
        if (dropped > 0) {
            log.warn(`[AgentRuntime] Dropped ${dropped} duplicate side-effect tool call(s) in one batch`);
            currentToolCalls = kept;
        }
    }

    const assistantMessage = {
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: currentToolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: tc.function,
            // Preserve thought_signature for Gemini multi-turn tool calls
            _thought_signature: tc._thought_signature || undefined
        })),
        // Interleaved thinking that led to THESE tool calls. Without
        // it the very next round of the same turn re-reads a history
        // in which the model appears to have called the tools for no
        // stated reason — and on Claude the adapter needs the signed
        // blocks to sit in front of the tool_use blocks on replay.
        // Snapshot (not a live reference): _thinkingParts keeps
        // growing as later rounds stream their own reasoning.
        thinking: _snapshotThinkingParts(),
    };

    return { currentToolCalls, assistantMessage };
}

async function dispatchToolRound({
    currentToolCalls, toolCalls, signal, onEvent, messages, durableMessages,
    persistDurable, dlpShield, regexConfig, webSearchGuardEnabled,
    webSearchGuardPiiCategories, toolParamsMap, userAuth, userId, agent,
    agentId, conversation, modelToUse, messageMetadata, onSkillsActivated,
    tools, unattended,
    _failingToolCounts, MAX_TOOL_REPEAT, _toolHistory, _emailDrafts,
    _calendarDrafts, _linkedInDrafts, _mapEmbeds, _audioFiles, _generatedFiles,
    _kbSources, _seenChunkIds, _pendingToolCalls, _pendingToolCounts,
}) {

    // One tool round — arg parsing + DLP restore, the tool-PII
    // policy, probed dispatch with egress + usage logging, result
    // redaction and the post-round persist — see ./toolRoundExecutor.
    // Per-ROUND, not per-turn: `tools` is a live array that
    // onSkillsActivated pushes into, so a policy built once at
    // assembly would refuse the very tools a skill just unlocked.
    // If building it ever throws, `fallbackToolPolicy` rebuilds BOTH
    // gates from the stack that was offered: the name whitelist, and
    // — for an agent that actually has a curated `tools` map — the
    // confirm layer, name by name. Dropping the latter would mean a
    // tool its owner put on 'ask' dispatching with no card, and in an
    // unattended run (where toolStackAssembly's own catch left those
    // tools in the stack on the same failure) a send going out
    // unapproved. An agent without a curated map is untouched.
    let _roundPolicy;
    let _automationConfirms = null;
    try {
        // The per-automation confirm a granted automation carries. It
        // can only be resolved against the assembled stack (the
        // grant is keyed on the automation id, the tool on its
        // name), so it is rebuilt per round like the policy itself.
        _automationConfirms = automationConfirmsFor(tools, agent.config);
    } catch (_) { /* no overrides is the pre-grant behaviour */ }
    try {
        _roundPolicy = buildToolPolicy({
            agentConfig: agent.config, tools, unattended,
            automationConfirms: _automationConfirms,
        });
    } catch (policyErr) {
        log.warn('[AgentRuntime] Tool policy build failed — falling back to a fail-closed policy:', policyErr.message);
        _roundPolicy = fallbackToolPolicy({
            agentConfig: agent.config, tools, unattended,
            automationConfirms: _automationConfirms,
        });
    }

    const _bailReason = await executeToolRound({
        currentToolCalls, toolCalls, signal, onEvent, messages, durableMessages,
        persistDurable, dlpShield, regexConfig, webSearchGuardEnabled,
        webSearchGuardPiiCategories, toolParamsMap, userAuth, userId, agent,
        agentId, conversation, modelToUse, messageMetadata, onSkillsActivated,
        toolPolicy: _roundPolicy,
        _failingToolCounts, MAX_TOOL_REPEAT, _toolHistory, _emailDrafts,
        _calendarDrafts, _linkedInDrafts, _mapEmbeds, _audioFiles, _generatedFiles,
        _kbSources, _seenChunkIds, _pendingToolCalls, _pendingToolCounts,
    });

    return _bailReason;
}

module.exports = { buildRoundAssistantMessage, dispatchToolRound };
