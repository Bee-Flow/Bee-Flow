// @typecheck noImplicitAny
/**
 * What ./nativeAdapterStream hands the provider adapter, and what it does
 * with the adapter's thinking-part events and its usage afterwards.
 *
 * The outbound token guard, the tier defaults and the usage store are handed
 * in as `d` ({ applyTokenMapToMessages, tierDefaults(), usageStore }) by
 * ./nativeAdapterStream: they sit in the server's large import cycle, which
 * this module stays out of.
 */
const { usageLogFields } = require('../../providers/usageNormalizer');
const testChatMod = require('../testChat');
const { placeVolatileBlock } = require('../../llm/promptLayout');
const { sanitizeMessages } = require('../../../utils/messageUtils');
const { toolSetFingerprint, systemPrefixFingerprint } = require('../../llm/promptCacheStability');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * @typedef {import('./turnState').AgentRow} AgentRow
 * @typedef {import('./turnState').ConversationRow} ConversationRow
 * @typedef {import('./turnState').OnEvent} OnEvent
 * @typedef {import('./turnState').ChatMessage} ChatMessage
 * @typedef {import('./turnState').ToolDef} ToolDef
 * @typedef {import('./turnState').MessageMetadata} MessageMetadata
 * @typedef {import('./turnState').ThinkingPart} ThinkingPart
 * @typedef {import('./roundRequest').TierSettings} TierSettings
 * @typedef {import('../../providers/usageNormalizer').RawUsage} RawUsage
 * @typedef {{ applyTokenMapToMessages: typeof import('../../dlp/applyTokenMapToOutbound').applyTokenMapToMessages, usageStore: typeof import('../../../stores/usageStore'), tierDefaults: () => typeof import('../../llm/modelResolver').TIER_DEFAULTS }} SetupDeps
 * @typedef {{ type?: string, name?: string, function?: { name?: string }, [key: string]: unknown }} AdapterTool
 * @typedef {{ maxTokens: number, temperature: number, budgetTokens?: number, reasoningEffort?: string, reasoningSummary?: boolean, verbosity?: string, promptCacheKey?: string, signal?: AbortSignal, timeoutMs?: number, tools?: AdapterTool[], toolChoice?: unknown, userId?: string }} AdapterOptions
 * @typedef {{ partId?: string, text?: string, redacted?: boolean, signature?: string, redactedData?: string }} ThinkingEventData
 * @typedef {{ onEvent: OnEvent, _thinkingParts?: ThinkingPart[], _getThinkingPart: (partId: string) => ThinkingPart }} ThinkingCtx
 */

/**
 * Build OpenAI-format messages for the adapter's normalizeMessages.
 * Funnel through the outbound-prompt guard so any real values smuggled in by
 * memory/compaction/edit-retry/etc. get re-tokenised against the conv's known
 * vault before the LLM ever sees them. Idempotent on already-tokenised
 * content.
 *
 * Two system messages: the stable one first (the adapter puts the 1h cache
 * breakpoint on it), then the per-turn one. The volatile block is omitted
 * entirely when empty so a turn with no dynamic context doesn't emit a blank
 * block.
 *
 * The volatile block is then moved to just before the LAST user message
 * (core/llm/promptLayout.js): every adapter on this branch either extracts
 * system messages wherever they sit (Claude, Google), accepts them anywhere
 * (OpenAI, Azure, Mistral) or folds a late one into the next user turn
 * (local), and a self-hosted prefix cache then keeps the history instead of
 * re-reading it behind the clock line.
 * @param {{ effectiveSystemPrompt: string, effectiveVolatilePrompt: string, finalMessages: ChatMessage[], conversation: ConversationRow }} turn
 * @param {SetupDeps} d
 */
function buildAdapterMessages({ effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, conversation }, d) {
    const _volatileMessage = effectiveVolatilePrompt.trim()
        ? { role: 'system', content: effectiveVolatilePrompt.trimStart() }
        : null;
    const _layout = [
        { role: 'system', content: effectiveSystemPrompt },
        ...(_volatileMessage ? [_volatileMessage] : []),
        ...sanitizeMessages(finalMessages),
    ];
    if (_volatileMessage) placeVolatileBlock(_layout, _volatileMessage);
    return d.applyTokenMapToMessages({
        conversationId: conversation?.id,
        messages: _layout,
    });
}

/**
 * Generation settings from the tier, the per-turn composer choices and the attachment bump.
 * @param {{ agent: AgentRow, modelToUse: string, messageMetadata: MessageMetadata, tierSettings: TierSettings }} turn
 * @param {SetupDeps} d
 * @returns {AdapterOptions}
 */
function generationOptions({ agent, modelToUse, messageMetadata, tierSettings }, d) {
    const isThinkingModel = modelToUse.includes('magistral');
    const TIER_DEFAULTS = d.tierDefaults();
    const tierName = (agent.model && agent.model.startsWith('tier:')) ? agent.model.substring(5) : 'fast';
    /** @type {Record<string, typeof TIER_DEFAULTS.fast>} */
    const defaultsByTier = TIER_DEFAULTS;
    const tierDefaults = defaultsByTier[tierName] || TIER_DEFAULTS.fast;
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

    return {
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
    };
}

/**
 * The adapter's options for this round: generation settings, cache routing, local-runtime guards and tools.
 * @param {{ agent: AgentRow, userId: string, messageMetadata: MessageMetadata, modelToUse: string, conversation: ConversationRow, tools: ToolDef[], signal?: AbortSignal, tierSettings: TierSettings, effectiveSystemPrompt: string, _adapterIsLocal?: boolean, _forceFinalAnswer?: boolean }} turn
 * @param {SetupDeps} d
 * @returns {AdapterOptions}
 */
function buildAdapterOptions({ agent, userId, messageMetadata, modelToUse, conversation, tools, signal, tierSettings, effectiveSystemPrompt, _adapterIsLocal, _forceFinalAnswer }, d) {
    const adapterOptions = generationOptions({ agent, modelToUse, messageMetadata, tierSettings }, d);

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
            .sort((/** @type {{ name?: string, function?: { name?: string } }} */ a, /** @type {{ name?: string, function?: { name?: string } }} */ b) => {
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
    return adapterOptions;
}

/**
 * A thinking-part lifecycle event (`thinking_start`, `thinking_signature`,
 * `thinking_stop`) applied to the turn's parts. The text itself (`thinking`)
 * is the caller's: it also feeds the flat string.
 * @param {string} type
 * @param {ThinkingEventData} data
 * @param {ThinkingCtx} ctx
 */
function applyThinkingPartEvent(type, data, { onEvent, _getThinkingPart }) {
    if (type === 'thinking_start') {
        if (data.partId) {
            const part = _getThinkingPart(data.partId);
            if (data.redacted) part.redacted = true;
            onEvent('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
        }
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
    }
}

/**
 * Route a `thinking` text chunk into the right part when the provider
 * supplied a partId; otherwise append to the most recent part (or open an
 * implicit one).
 * @param {ThinkingEventData} data
 * @param {ThinkingCtx} ctx
 */
function appendThinkingText(data, { _thinkingParts, _getThinkingPart }) {
    if (data.partId) {
        const part = _getThinkingPart(data.partId);
        part.text += data.text;
        return;
    }
    let part = _thinkingParts[_thinkingParts.length - 1];
    if (!part || part.endedAt) {
        part = { id: `auto-${_thinkingParts.length}`, text: '', startedAt: Date.now(), endedAt: null };
        _thinkingParts.push(part);
    }
    part.text += data.text;
}

/**
 * Log usage for a native adapter stream (best effort).
 * @param {{ agent: AgentRow, agentId: string, userId: string, modelToUse: string, messageMetadata: MessageMetadata, conversation: ConversationRow, _adapterStreamUsage: (RawUsage & { stop_reason?: string }) | null, _streamCallStart: number }} turn
 * @param {SetupDeps} d
 */
async function logAdapterUsage({ agent, agentId, userId, modelToUse, messageMetadata, conversation, _adapterStreamUsage, _streamCallStart }, d) {
    try {
        await d.usageStore.logUsage({
            user_id: userId,
            agent_id: agentId,
            agent_name: agent.name,
            agent_type: 'chat',
            model: modelToUse,
            // Adapters emit the normalised shape (providers/usageNormalizer.js)
            // on `done`; an OpenAI-shaped payload is read too.
            ...usageLogFields(_adapterStreamUsage),
            stop_reason: _adapterStreamUsage?.stop_reason || null,
            parent_call_id: messageMetadata.parentCallId || null,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            duration_ms: Date.now() - _streamCallStart,
            organization_id: agent.organization_id || null,
            conversation_id: conversation?.id || null,
        });
    } catch (e) { bestEffort('core/agentRuntime/chatStream/adapterRoundSetup:logAdapterUsage', e); /* ignore usage errors */ }
}

module.exports = {
    buildAdapterMessages, buildAdapterOptions, applyThinkingPartEvent, appendThinkingText, logAdapterUsage,
};
