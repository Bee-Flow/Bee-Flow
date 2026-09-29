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
 * Moved verbatim out of chatStream.js. Usage is logged here (the adapter's
 * payload shape is this branch's own); the turn's token counters and stop
 * reason are the caller's, and it accumulates them from what comes back.
 */
const usageStore = require('../../../stores/usageStore');
const testChatMod = require('../testChat');
const { placeVolatileBlock } = require('../../llm/promptLayout');
const { sanitizeMessages } = require('../../../utils/messageUtils');
const { applyTokenMapToMessages } = require('../../dlp/applyTokenMapToOutbound');
const { checkRegexPatterns } = require('../../privacy/guardrails');
const { toolSetFingerprint, systemPrefixFingerprint } = require('../../llm/promptCacheStability');
const { retryStreamCall } = require('../streamRetry');
const log = require('../../../telemetry/log');

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

    // Build OpenAI-format messages for the adapter's normalizeMessages.
    // Funnel through the outbound-prompt guard so any real values
    // smuggled in by memory/compaction/edit-retry/etc. get
    // re-tokenised against the conv's known vault before the LLM
    // ever sees them. Idempotent on already-tokenised content.
    //
    // Two system messages: the stable one first (the adapter puts
    // the 1h cache breakpoint on it), then the per-turn one. The
    // volatile block is omitted entirely when empty so a turn with
    // no dynamic context doesn't emit a blank block.
    //
    // The volatile block is then moved to just before the LAST
    // user message (core/llm/promptLayout.js): every adapter on
    // this branch either extracts system messages wherever they
    // sit (Claude, Google), accepts them anywhere (OpenAI, Azure,
    // Mistral) or folds a late one into the next user turn
    // (local), and a self-hosted prefix cache then keeps the
    // history instead of re-reading it behind the clock line.
    const _volatileMessage = effectiveVolatilePrompt.trim()
        ? { role: 'system', content: effectiveVolatilePrompt.trimStart() }
        : null;
    const _layout = [
        { role: 'system', content: effectiveSystemPrompt },
        ...(_volatileMessage ? [_volatileMessage] : []),
        ...sanitizeMessages(finalMessages),
    ];
    if (_volatileMessage) placeVolatileBlock(_layout, _volatileMessage);
    const adapterMessages = applyTokenMapToMessages({
        conversationId: conversation?.id,
        messages: _layout,
    });

    const isThinkingModel = modelToUse.includes('magistral');
    const { TIER_DEFAULTS } = require('../../llm/modelResolver');
    const tierName = (agent.model && agent.model.startsWith('tier:')) ? agent.model.substring(5) : 'fast';
    const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
    const defaultMaxTokens = isThinkingModel ? 40960 : tierDefaults.maxTokens;

    // Auto-bump: attachments routinely require long-form output that
    // fast/standard ceilings clip mid-response. Lift to the writer-tier
    // budget for this turn — tier defaults still apply to non-attachment turns,
    // and higher tiers (deep_thinking @ 40K) keep their ceiling via Math.max.
    const _turnHasAttachments = Array.isArray(messageMetadata?.attachments) && messageMetadata.attachments.length > 0;
    const ATTACHMENT_MIN_MAX_TOKENS = 16384;
    const _resolvedMaxTokens = tierSettings.maxTokens || defaultMaxTokens;
    const _effectiveMaxTokens = _turnHasAttachments
        ? Math.max(_resolvedMaxTokens, ATTACHMENT_MIN_MAX_TOKENS)
        : _resolvedMaxTokens;

    const adapterOptions = {
        maxTokens: _effectiveMaxTokens,
        temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        budgetTokens: tierSettings.budgetTokens || undefined,
        // messageMetadata.reasoningEffort is the per-turn user choice from the composer.
        // It overrides tier defaults when present.
        reasoningEffort: messageMetadata?.reasoningEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
        reasoningSummary: tierSettings.reasoningSummary !== undefined ? tierSettings.reasoningSummary : (tierDefaults.reasoningSummary || false),
        // GPT-5 output-length control. Per-turn override → tier setting → tier default.
        // Only forwarded to GPT-5 models by the adapter; ignored elsewhere.
        verbosity: messageMetadata?.verbosity || tierSettings.verbosity || tierDefaults.verbosity || undefined,
        // Azure-specific: needed for Responses API version check
        apiVersion: config.apiVersion || undefined,
    };

    // Conversation-stable prompt-cache routing hint. A per-conversation
    // key keeps the (byte-stable) system+tools prefix on the same cache
    // shard across turns — much better hit rate than a per-user key.
    // Falls back to userId when there's no conversation id yet.
    adapterOptions.promptCacheKey = conversation?.id
        ? `conv-${conversation.id}`
        : (userId ? String(userId) : undefined);

    if (_adapterIsLocal) {
        // What the raw-fetch path had and the adapter path needs:
        // the client's disconnect signal (a closed tab must free
        // the single slot, not generate to max_tokens for nobody)
        // and the same 120 s ceiling — as a per-chunk stall
        // watchdog here, so a long but live generation is never
        // cut while a wedged one is.
        adapterOptions.signal = signal || undefined;
        adapterOptions.timeoutMs = 120000;
    }


    // `_forceFinalAnswer` withholds the whole tool list for the
    // wrap-up round so the model can only reply in prose.
    if (tools.length > 0 && !_forceFinalAnswer) {
        // Strip internal metadata (_mcp, _n8n etc.) before sending to LLM — providers may reject unknown fields.
        // Sort by tool name so the JSON prefix is byte-stable across turns — required for
        // OpenAI/Azure automatic prefix caching (≥1024-token stable prefix).
        adapterOptions.tools = tools
            .map(t => {
                const { _mcp, _n8n, ...clean } = t;
                return clean;
            })
            .sort((a, b) => {
                const an = a.function?.name || a.name || '';
                const bn = b.function?.name || b.name || '';
                return an.localeCompare(bn);
            });
        // Cache-stability trace: the tool list is serialised ahead
        // of the system prompt, so a change here rebuilds the whole
        // prefix. Logging both fingerprints makes a drifting prefix
        // visible in the logs instead of only on the bill.
        log.info(`[AgentRuntime] prefix fingerprints: tools=${toolSetFingerprint(adapterOptions.tools)} system=${systemPrefixFingerprint(effectiveSystemPrompt)}`);
        // Honour a per-turn tool_choice ('required'/'any'/'none') from the
        // composer; default to 'auto'. The adapter maps this onto the
        // Chat Completions and Responses APIs uniformly.
        adapterOptions.toolChoice = messageMetadata?.toolChoice || 'auto';
    }
    // Stable end-user identifier — OpenAI uses it as a cache-routing hint
    // and for abuse monitoring. Safe to pass the raw userId (opaque string).
    if (userId) adapterOptions.userId = userId;
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
        return providerAdapter.stream(
        config.apiKey, config.url, modelToUse,
        adapterMessages, adapterOptions,
        (type, data) => {
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
            } else if (type === 'thinking_start') {
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    if (data.redacted) part.redacted = true;
                    onEvent('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'thinking') {
                // Route into the right thinking part if provider supplied partId;
                // otherwise append to the most recent part (or open an implicit one).
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    part.text += data.text;
                } else {
                    let part = _thinkingParts[_thinkingParts.length - 1];
                    if (!part || part.endedAt) {
                        part = { id: `auto-${_thinkingParts.length}`, text: '', startedAt: Date.now(), endedAt: null };
                        _thinkingParts.push(part);
                    }
                    part.text += data.text;
                }
                onEvent('thinking', { text: data.text, partId: data.partId });
                _thinking += data.text;
            } else if (type === 'thinking_signature') {
                // Server-side only — persist onto the matching part so Claude
                // replays the reasoning with its signature intact on every later
                // turn. `redactedData` is the equivalent for a redacted_thinking
                // block (no text, no signature — the opaque payload IS the block).
                // Never forwarded to SSE.
                if (data.partId && (data.signature || data.redactedData)) {
                    const part = _getThinkingPart(data.partId);
                    if (data.signature) part.signature = data.signature;
                    if (data.redactedData) part.redactedData = data.redactedData;
                }
            } else if (type === 'thinking_stop') {
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    part.endedAt = Date.now();
                    if (data.redacted) part.redacted = true;
                    onEvent('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'tool_use') {
                // Accumulate tool calls for post-stream processing
                currentToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    function: {
                        name: data.name,
                        arguments: JSON.stringify(data.input || {}),
                    },
                    _thought_signature: data.thought_signature || undefined
                });
            } else if (type === 'tool_use_invalid') {
                // The adapter dropped a malformed call (unparseable
                // args). Collected, not forwarded: if the round ends
                // empty, the guard below nudges the model with what
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
        }
        );
    }, 3, signal);

    // Log usage for native adapter streams
    try {
        await usageStore.logUsage({
            user_id: userId,
            agent_id: agentId,
            agent_name: agent.name,
            agent_type: 'chat',
            model: modelToUse,
            prompt_tokens: _adapterStreamUsage?.prompt_tokens || 0,
            completion_tokens: _adapterStreamUsage?.completion_tokens || 0,
            total_tokens: _adapterStreamUsage?.total_tokens || 0,
            // Adapters normalise to `cached_tokens`; an OpenAI-shaped
            // payload that still carries prompt_tokens_details is read too.
            cached_tokens: _adapterStreamUsage?.cached_tokens
                || _adapterStreamUsage?.prompt_tokens_details?.cached_tokens || 0,
            cache_creation_tokens: _adapterStreamUsage?.cache_creation_tokens || 0,
            reasoning_tokens: _adapterStreamUsage?.reasoning_tokens || 0,
            cache_ttl: _adapterStreamUsage?.cache_ttl || null,
            stop_reason: _adapterStreamUsage?.stop_reason || null,
            parent_call_id: messageMetadata.parentCallId || null,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            duration_ms: Date.now() - _streamCallStart,
            organization_id: agent.organization_id || null,
            conversation_id: conversation?.id || null
        });
    } catch (e) { /* ignore usage errors */ }

    return {
        contentBuffer, currentToolCalls, _invalidToolCalls, guardrailViolation,
        _adapterStreamUsage, _thinking, _thinkingSnapshotFrom,
    };
}

module.exports = { streamNativeAdapterRound };
