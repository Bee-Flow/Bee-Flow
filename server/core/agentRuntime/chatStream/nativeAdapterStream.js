// @typecheck
/**
 * ONE round through the provider ADAPTER — every SDK provider and every
 * self-hosted runtime (Ollama, vLLM, llama.cpp, LM Studio, …).
 *
 * The adapter's callback is where the turn's live state is filled in: visible
 * text (regex-guarded as it streams), the thinking parts with their signatures
 * so Claude can replay the reasoning, the tool calls and the ones the adapter
 * had to drop as malformed. Everything the callback touches travels in and
 * back out again, because a retried stream replays from the start and each
 * attempt has to begin from clean per-attempt state.
 *
 * The request (messages, options), the thinking-part bookkeeping and the
 * usage row live in ./adapterRoundSetup. Usage is logged here (the adapter's
 * payload shape is this branch's own); the turn's token counters and stop
 * reason are the caller's, and it accumulates them from what comes back.
 */
const { checkRegexPatterns } = require('../../privacy/guardrails');
const { retryStreamCall } = require('../streamRetry');
const log = require('../../../telemetry/log');
const {
    buildAdapterMessages, buildAdapterOptions, applyThinkingPartEvent, appendThinkingText, logAdapterUsage,
} = require('./adapterRoundSetup');
const usageStore = require('../../../stores/usageStore');
const { applyTokenMapToMessages } = require('../../dlp/applyTokenMapToOutbound');

// What ./adapterRoundSetup works with, handed in (it stays out of the server's
// large import cycle). The tier defaults stay lazily required, as they were.
const SETUP_DEPS = {
    applyTokenMapToMessages, usageStore,
    tierDefaults: () => require('../../llm/modelResolver').TIER_DEFAULTS,
};

const THINKING_PART_EVENTS = new Set(['thinking_start', 'thinking_signature', 'thinking_stop']);

async function streamNativeAdapterRound({
    agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
    tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
    effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
    providerAdapter, _adapterIsLocal, _streamCallStart,
    _thinking, _thinkingParts, _thinkingSnapshotFrom, _getThinkingPart,
}) {
    let currentToolCalls = [];
    let contentBuffer = '';
    // Tool calls the adapter dropped as malformed this round (warn-only in the
    // adapters) — the caller's empty-round guard feeds them back as a targeted
    // nudge instead of reading the round as "done".
    let _invalidToolCalls = [];

    const adapterMessages = buildAdapterMessages({ effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, conversation }, SETUP_DEPS);
    const adapterOptions = buildAdapterOptions({
        agent, userId, messageMetadata, modelToUse, conversation, tools, signal, tierSettings,
        effectiveSystemPrompt, _adapterIsLocal, _forceFinalAnswer,
    }, SETUP_DEPS);
    const mcpToolCount = tools.filter(t => t._mcp || t.function?.name?.startsWith('mcp_')).length;
    if (mcpToolCount > 0) {
        log.info(`[AgentRuntime] 🔌 ${mcpToolCount} MCP tools loaded for LLM`);
    }

    log.info(`[AgentRuntime] Using native ${config.providerType} adapter for streaming`, {
        model: modelToUse,
        budgetTokens: adapterOptions.budgetTokens,
        temperature: adapterOptions.temperature,
        toolsCount: tools.length,
    });

    let _adapterStreamUsage = null;
    const thinkingCtx = { onEvent, _thinkingParts, _getThinkingPart };
    // The adapter's event callback. It closes over this round's live state.
    const onAdapterEvent = (type, data) => {
        if (signal?.aborted) return; // Drop callbacks once client aborted
        if (type === 'text') {
            const textChunk = data.text || '';
            contentBuffer += textChunk;

            // Real-time Agent Output validation
            if (regexConfig?.enabled && regexConfig?.scope?.agentOutput) {
                const matches = checkRegexPatterns(contentBuffer, regexConfig.rulesWithNames);
                if (matches.length > 0) {
                    const ruleNames = matches.map(m => m.ruleName).join(', ');
                    log.info(`[RegexGuard] Agent output violated rules during stream: ${ruleNames}`);
                    contentBuffer = `I apologize, but I cannot provide that response as it contains content that violates the ${ruleNames} policy.`;
                    onEvent('content_replace', { text: contentBuffer });
                    guardrailViolation = ruleNames;
                    return;
                }
            }

            onEvent('content', { text: textChunk });
        } else if (THINKING_PART_EVENTS.has(type)) {
            applyThinkingPartEvent(type, data, thinkingCtx);
        } else if (type === 'thinking') {
            appendThinkingText(data, thinkingCtx);
            onEvent('thinking', { text: data.text, partId: data.partId });
            _thinking += data.text;
        } else if (type === 'tool_use') {
            // Accumulate tool calls for post-stream processing
            currentToolCalls.push({
                id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                function: {
                    name: data.name,
                    arguments: JSON.stringify(data.input || {}),
                },
                _thought_signature: data.thought_signature || undefined,
            });
        } else if (type === 'tool_use_invalid') {
            // The adapter dropped a malformed call (unparseable
            // args). Collected, not forwarded: if the round ends
            // empty, the caller's guard nudges the model with what
            // exactly failed to parse instead of a generic retry.
            _invalidToolCalls.push(data || {});
        } else if (type === 'done') {
            // Capture usage data from adapter
            _adapterStreamUsage = data;
        } else if (type === 'error') {
            onEvent('error', data);
            // An error event after a totally unproductive stream
            // must not finalize as a normal (empty) turn: throw so
            // retryStreamCall can retry the transient cases and
            // the route surfaces the permanent ones. Mid-stream
            // errors that already produced content keep the old
            // behaviour — the partial answer stays visible.
            if (!contentBuffer && currentToolCalls.length === 0) {
                throw new Error(data?.error || data?.message || 'The model stream reported an error');
            }
        }
    };

    // Pass the abort signal through to retryStreamCall so the retry
    // loop bails immediately when the client disconnects. The native
    // provider adapter receives the signal via adapterOptions.
    const _preAttemptThinkingLen = _thinking.length;
    const _preAttemptThinkingParts = _thinkingParts.length;
    await retryStreamCall(() => {
        // A retried stream replays every event from the start.
        // Without this reset, a stream that emitted tool_use frames
        // before dropping leaves those calls in currentToolCalls;
        // the retry re-emits them and BOTH copies execute (duplicate
        // side effects, e.g. two identical YouTrack issues).
        // _thinking/_thinkingParts are turn-scoped → truncate to the
        // pre-attempt snapshot instead of clearing.
        if (contentBuffer) onEvent('content_replace', { text: '' });
        currentToolCalls = [];
        _invalidToolCalls = [];
        contentBuffer = '';
        _adapterStreamUsage = null;
        _thinking = _thinking.slice(0, _preAttemptThinkingLen);
        _thinkingParts.length = _preAttemptThinkingParts;
        // Keep the snapshot cursor inside the truncated array, or the
        // retry's reasoning would be skipped when it is attached to
        // the assistant tool-call message.
        if (_thinkingSnapshotFrom > _thinkingParts.length) _thinkingSnapshotFrom = _thinkingParts.length;
        return providerAdapter.stream(config.apiKey, config.url, modelToUse, adapterMessages, adapterOptions, onAdapterEvent);
    }, 3, signal);

    await logAdapterUsage({ agent, agentId, userId, modelToUse, messageMetadata, conversation, _adapterStreamUsage, _streamCallStart }, SETUP_DEPS);

    return {
        contentBuffer, currentToolCalls, _invalidToolCalls, guardrailViolation,
        _adapterStreamUsage, _thinking, _thinkingSnapshotFrom,
    };
}

module.exports = { streamNativeAdapterRound };
