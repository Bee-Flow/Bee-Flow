// @typecheck
/**
 * The pieces of ./rawSseStream: the request body, the fetch (retried, with
 * the client-disconnect signal combined with a 120 s ceiling), one parsed
 * `data:` frame applied to the round's state, and the usage row.
 *
 * The outbound token guard and the usage store are handed in as `d`
 * ({ applyTokenMapToOutbound, usageStore }) by ./rawSseStream: they sit in the
 * server's large import cycle, which this module stays out of.
 */
const { usageLogFields } = require('../../providers/usageNormalizer');
const testChatMod = require('../testChat');
const { sanitizeMessages } = require('../../../utils/messageUtils');
const { retryStreamCall } = require('../streamRetry');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * @typedef {import('./turnState').AgentRow} AgentRow
 * @typedef {import('./turnState').ConversationRow} ConversationRow
 * @typedef {import('./turnState').OnEvent} OnEvent
 * @typedef {import('./turnState').ChatMessage} ChatMessage
 * @typedef {import('./turnState').ToolDef} ToolDef
 * @typedef {import('./turnState').MessageMetadata} MessageMetadata
 * @typedef {import('./roundRequest').TierSettings} TierSettings
 * @typedef {import('../../providers/usageNormalizer').RawUsage} RawUsage
 * @typedef {{ id: string, function: { name: string, arguments: string } }} RawToolCall
 * @typedef {{ contentBuffer: string, currentToolCalls: RawToolCall[], thinking: string, usage: RawUsage | null, finishReason: string | null, guardTripped: boolean }} RawRoundState
 * @typedef {{ type?: string, text?: string, thinking?: { type?: string, text?: string }[] }} StructuredChunk
 * @typedef {{ index: number, id?: string, function?: { name?: string, arguments?: string } }} ToolCallDelta
 * @typedef {{ usage?: RawUsage, choices?: { finish_reason?: string, delta?: { content?: string | StructuredChunk[] | null, tool_calls?: ToolCallDelta[] } }[] }} SseFrame
 * @typedef {{ applyTokenMapToOutbound: typeof import('../../dlp/applyTokenMapToOutbound').applyTokenMapToOutbound, usageStore: typeof import('../../../stores/usageStore') }} RawPartsDeps
 * @typedef {{ model: string, messages: unknown[], stream: boolean, stream_options: { include_usage: boolean }, temperature?: number, reasoning_effort?: string, tools?: unknown[], tool_choice?: string }} RawRequestBody
 */

/**
 * The OpenAI-compatible request body for this round.
 * @param {{ agentId: string, modelToUse: string, conversation: ConversationRow, tools: ToolDef[], _forceFinalAnswer?: boolean, effectiveSystemPrompt: string, effectiveVolatilePrompt: string, finalMessages: ChatMessage[], tierSettings: TierSettings }} turn
 * @param {RawPartsDeps} d
 * @returns {RawRequestBody}
 */
function buildRawRequestBody({ agentId, modelToUse, conversation, tools, _forceFinalAnswer, effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings }, d) {
    // Detect reasoning models that need special handling
    const isReasoningModel = /^o\d|^gpt-5/i.test(modelToUse);
    const isRestrictedTemp = /^o\d|nano|^gpt-5/i.test(modelToUse);
    // Outbound-prompt guard — same invariant as the native-adapter
    // branch. See applyTokenMapToOutbound.
    // This path is OpenAI-compatible and has no prompt cache to
    // protect, so the two halves are joined back into one system
    // message.
    const _guardedRaw = d.applyTokenMapToOutbound({
        conversationId: conversation?.id,
        systemPrompt: effectiveSystemPrompt + effectiveVolatilePrompt,
        messages: sanitizeMessages(finalMessages),
    });
    /** @type {RawRequestBody} */
    const requestBody = {
        model: modelToUse,
        messages: [{ role: 'system', content: _guardedRaw.systemPrompt }, ..._guardedRaw.messages],
        stream: true,
        stream_options: { include_usage: true },
    };
    // Only set temperature for models that support it
    if (!isRestrictedTemp) {
        requestBody.temperature = tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7;
    }
    // Enable reasoning for capable models
    if (isReasoningModel) {
        requestBody.reasoning_effort = 'medium';
    }

    // Same wrap-up rule as the native-adapter branch: no tools on
    // the forced final round.
    if (tools.length > 0 && !_forceFinalAnswer) {
        requestBody.tools = tools.map(t => {
            const { _mcp, _n8n, ...clean } = t;
            return clean;
        });
        requestBody.tool_choice = 'auto';
    }

    // Debug logging: what is being sent to the LLM
    log.info(`[AgentRuntime] Request to LLM:`, {
        agentId,
        model: modelToUse,
        toolsCount: tools.length,
        toolNames: tools.map(t => t.function?.name),
        systemPromptPreview: effectiveSystemPrompt.substring(0, 200) + '...',
    });
    return requestBody;
}

/**
 * POST the body and resolve to the streaming response; a non-2xx throws (and is retried).
 * @param {{ apiUrl: string, headers: Record<string, string>, requestBody: RawRequestBody, signal?: AbortSignal }} req
 */
function fetchRawStream({ apiUrl, headers, requestBody, signal }) {
    // Combine client disconnect signal with a 120s timeout to prevent indefinite hangs
    const timeoutMs = 120000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

    return retryStreamCall(async () => {
        const resp = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: combinedSignal,
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            throw new Error(`API error ${resp.status}: ${errorText}`);
        }
        return resp;
    }, 3, signal);
}

/**
 * The visible text of a delta whose `content` is an array — reasoning
 * models send structured chunks: [{type: "thinking", thinking: [{type:
 * "text", text: "..."}]}]. Thinking text goes out as `thinking` events and
 * into `rs.thinking`.
 * @param {StructuredChunk[]} content
 * @param {RawRoundState} rs
 * @param {OnEvent} onEvent
 */
function textOfStructuredContent(content, rs, onEvent) {
    let textChunk = '';
    for (const chunk of content) {
        if (chunk.type === 'thinking' && Array.isArray(chunk.thinking)) {
            const thinkText = chunk.thinking
                .filter(t => t.type === 'text' && t.text)
                .map(t => t.text)
                .join('');
            if (thinkText) {
                onEvent('thinking', { text: thinkText });
                rs.thinking += thinkText;
            }
        } else if (chunk.type === 'text' && chunk.text) {
            textChunk += chunk.text;
        }
    }
    return textChunk;
}

/**
 * Accumulate streamed tool-call fragments by index.
 * @param {RawToolCall[]} currentToolCalls
 * @param {ToolCallDelta[]} toolCallDeltas
 */
function mergeToolCallDeltas(currentToolCalls, toolCallDeltas) {
    for (const tc of toolCallDeltas) {
        const idx = tc.index;
        if (!currentToolCalls[idx]) {
            currentToolCalls[idx] = {
                id: tc.id || '',
                function: { name: '', arguments: '' },
            };
        }
        if (tc.id) currentToolCalls[idx].id = tc.id;
        if (tc.function?.name) currentToolCalls[idx].function.name = tc.function.name;
        if (tc.function?.arguments) currentToolCalls[idx].function.arguments += tc.function.arguments;
    }
}

/**
 * Apply one parsed SSE frame to the round state `rs`. Returns 'break' when
 * the output guard tripped (the caller stops reading this batch of lines).
 * @param {SseFrame} parsed
 * @param {RawRoundState} rs
 * @param {{ splitter: { push: (text: string) => void }, onEvent: OnEvent }} ctx
 */
function applySseFrame(parsed, rs, { splitter, onEvent }) {
    // Buffer the latest usage frame — log once after stream completes.
    if (parsed.usage) {
        rs.usage = parsed.usage;
    }
    const fr = parsed.choices?.[0]?.finish_reason;
    if (fr) rs.finishReason = fr;

    const delta = parsed.choices?.[0]?.delta;

    if (delta?.content !== undefined && delta?.content !== null) {
        // Handle reasoning models: delta.content can be a string OR an object
        let textChunk = '';
        if (typeof delta.content === 'string') {
            textChunk = delta.content;
        } else if (Array.isArray(delta.content)) {
            textChunk = textOfStructuredContent(delta.content, rs, onEvent);
            if (!textChunk) return undefined; // Only thinking chunks — skip content processing
        }

        if (textChunk) {
            splitter.push(textChunk);
            if (rs.guardTripped) return 'break';
        }
    }

    // Handle tool calls in streaming
    if (delta?.tool_calls) mergeToolCallDeltas(rs.currentToolCalls, delta.tool_calls);
    return undefined;
}

/**
 * Log usage once after the SSE stream finishes. Buffering inside the loop and
 * writing here avoids duplicate rows when servers emit multiple usage frames
 * or when [DONE] races the last frame.
 * @param {{ agent: AgentRow, agentId: string, userId: string, modelToUse: string, messageMetadata: MessageMetadata, conversation: ConversationRow, usage: RawUsage | null, finishReason: string | null, _streamCallStart: number }} turn
 * @param {RawPartsDeps} d
 */
async function logRawUsage({ agent, agentId, userId, modelToUse, messageMetadata, conversation, usage, finishReason, _streamCallStart }, d) {
    if (!usage) return;
    try {
        await d.usageStore.logUsage({
            user_id: userId,
            agent_id: agentId,
            agent_name: agent.name,
            agent_type: 'chat',
            model: modelToUse,
            // Raw OpenAI-compatible usage frame: the normaliser reads
            // prompt_tokens_details / cache_creation_input_tokens / the rest.
            ...usageLogFields(usage),
            stop_reason: finishReason,
            parent_call_id: messageMetadata.parentCallId || null,
            source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
            duration_ms: Date.now() - _streamCallStart,
            organization_id: agent.organization_id || null,
            conversation_id: conversation?.id || null,
        });
    } catch (e) { bestEffort('core/agentRuntime/chatStream/rawSseParts:logRawUsage', e); /* ignore usage errors */ }
}

module.exports = { buildRawRequestBody, fetchRawStream, applySseFrame, logRawUsage };
