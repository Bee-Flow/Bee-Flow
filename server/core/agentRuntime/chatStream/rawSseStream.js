/**
 * ONE round over the RAW OpenAI-compatible SSE path — everything the provider
 * adapters do not cover (Scaleway, unknown OpenAI-shaped endpoints).
 *
 * It builds its own request body, parses `data:` frames by hand and keeps the
 * two things the adapter branch gets for free: the client-disconnect signal
 * combined with a 120 s ceiling, and a <think>…</think> splitter for the OSS
 * reasoning models that emit their reasoning as literal text (BFSF-263).
 * The two system halves are joined back into one here — this path has no
 * prompt cache to protect.
 *
 * Moved verbatim out of chatStream.js. Usage is buffered and logged once after
 * the stream ends; the turn's counters and stop reason are the caller's.
 */
const usageStore = require('../../../stores/usageStore');
const { usageLogFields } = require('../../providers/usageNormalizer');
const testChatMod = require('../testChat');
const { sanitizeMessages } = require('../../../utils/messageUtils');
const { applyTokenMapToOutbound } = require('../../dlp/applyTokenMapToOutbound');
const { checkRegexPatterns } = require('../../privacy/guardrails');
const { retryStreamCall } = require('../streamRetry');
const log = require('../../../telemetry/log');

async function streamRawSseRound({
    agent, agentId, userId, messageMetadata, modelToUse, conversation,
    tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
    effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
    headers, apiUrl, _streamCallStart, _thinking,
}) {
    let currentToolCalls = [];
    let contentBuffer = '';

    // ─── Raw fetch SSE streaming (OpenAI-compatible) ──────────────
    // Detect reasoning models that need special handling
    const isReasoningModel = /^o\d|^gpt-5/i.test(modelToUse);
    const isRestrictedTemp = /^o\d|nano|^gpt-5/i.test(modelToUse);
    // Outbound-prompt guard — same invariant as the native-adapter
    // branch above. See applyTokenMapToOutbound.
    // This path is OpenAI-compatible and has no prompt cache to
    // protect, so the two halves are joined back into one system
    // message.
    const _guardedRaw = applyTokenMapToOutbound({
        conversationId: conversation?.id,
        systemPrompt: effectiveSystemPrompt + effectiveVolatilePrompt,
        messages: sanitizeMessages(finalMessages),
    });
    const requestBody = {
        model: modelToUse,
        messages: [{ role: 'system', content: _guardedRaw.systemPrompt }, ..._guardedRaw.messages],
        stream: true,
        stream_options: { include_usage: true }
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
        systemPromptPreview: effectiveSystemPrompt.substring(0, 200) + '...'
    });

    // Combine client disconnect signal with a 120s timeout to prevent indefinite hangs
    const timeoutMs = 120000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

    const response = await retryStreamCall(async () => {
        const resp = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: combinedSignal
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            throw new Error(`API error ${resp.status}: ${errorText}`);
        }
        return resp;
    }, 3, signal);


    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Buffer the latest usage frame and finish_reason; log once after the stream ends.
    // Logging inside the loop caused duplicate rows whenever a server emitted more
    // than one usage frame (and was racy with the inner async path).
    let _sseStreamUsage = null;
    let _sseFinishReason = null;

    // BFSF-263: OSS reasoning models (Qwen3/DeepSeek-R1 via generic
    // OpenAI-compatible endpoints) emit <think>…</think> as literal
    // text at the start of the turn — this legacy raw-fetch path
    // streamed it verbatim into the visible answer. Route string
    // deltas through the splitter so reasoning becomes 'thinking'
    // events (collapsed panel) instead. Instantiated PER ROUND:
    // these models re-think before every tool call.
    // `_emitVisibleText` carries the pre-existing regex-guard +
    // content emission so guarded output still cancels the stream.
    const { createThinkTagSplitter } = require('../../providers/thinkTagStream');
    let _guardTripped = false;
    const _emitVisibleText = (text) => {
        contentBuffer += text;
        // Real-time Agent Output validation - check as we stream
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput) {
            const matches = checkRegexPatterns(contentBuffer, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                log.info(`[RegexGuard] Agent output violated rules during stream: ${ruleNames}`);
                // Cancel remaining stream and send redacted message
                contentBuffer = `I apologize, but I cannot provide that response as it contains content that violates the ${ruleNames} policy.`;
                onEvent('content_replace', { text: contentBuffer }); // Replace all content
                guardrailViolation = ruleNames; // Mark as violation
                reader.cancel(); // Cancel the stream
                _guardTripped = true;
                return;
            }
        }
        onEvent('content', { text });
    };
    const sseThinkSplitter = createThinkTagSplitter({
        onText: _emitVisibleText,
        onThinking: (text) => {
            onEvent('thinking', { text });
            _thinking += text;
        },
    });


    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);

                    // Buffer the latest usage frame — log once after stream completes.
                    if (parsed.usage) {
                        _sseStreamUsage = parsed.usage;
                    }
                    const fr = parsed.choices?.[0]?.finish_reason;
                    if (fr) _sseFinishReason = fr;

                    const delta = parsed.choices?.[0]?.delta;

                    if (delta?.content !== undefined && delta?.content !== null) {
                        // Handle reasoning models: delta.content can be a string OR an object
                        let textChunk = '';
                        if (typeof delta.content === 'string') {
                            textChunk = delta.content;
                        } else if (Array.isArray(delta.content)) {
                            // Reasoning model — array of structured chunks
                            // Format: [{type: "thinking", thinking: [{type: "text", text: "..."}]}]
                            for (const chunk of delta.content) {
                                if (chunk.type === 'thinking' && Array.isArray(chunk.thinking)) {
                                    const thinkText = chunk.thinking
                                        .filter(t => t.type === 'text' && t.text)
                                        .map(t => t.text)
                                        .join('');
                                    if (thinkText) {
                                        onEvent('thinking', { text: thinkText });
                                        _thinking += thinkText;
                                    }
                                } else if (chunk.type === 'text' && chunk.text) {
                                    textChunk += chunk.text;
                                }
                            }
                            if (!textChunk) continue; // Only thinking chunks — skip content processing
                        }

                        if (textChunk) {
                            sseThinkSplitter.push(textChunk);
                            if (_guardTripped) break;
                        }
                    }

                    // Handle tool calls in streaming
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index;
                            if (!currentToolCalls[idx]) {
                                currentToolCalls[idx] = {
                                    id: tc.id || '',
                                    function: { name: '', arguments: '' }
                                };
                            }
                            if (tc.id) currentToolCalls[idx].id = tc.id;
                            if (tc.function?.name) currentToolCalls[idx].function.name = tc.function.name;
                            if (tc.function?.arguments) currentToolCalls[idx].function.arguments += tc.function.arguments;
                        }
                    }
                } catch (e) {
                    // Skip parse errors
                }
            }
        }
    }

    // Release anything the splitter held back (an unclosed <think>
    // runs to end-of-stream as reasoning; a partial tag flushes as
    // text) before the post-stream bookkeeping reads contentBuffer.
    sseThinkSplitter.flush();

    // Log usage once after the SSE stream finishes. Buffering inside
    // the loop and writing here avoids duplicate rows when servers
    // emit multiple usage frames or when [DONE] races the last frame.
    if (_sseStreamUsage) {
        try {
            await usageStore.logUsage({
                user_id: userId,
                agent_id: agentId,
                agent_name: agent.name,
                agent_type: 'chat',
                model: modelToUse,
                // Raw OpenAI-compatible usage frame: the normaliser reads
                // prompt_tokens_details / cache_creation_input_tokens / the rest.
                ...usageLogFields(_sseStreamUsage),
                stop_reason: _sseFinishReason,
                parent_call_id: messageMetadata.parentCallId || null,
                source: testChatMod.usageSourceFor(messageMetadata, 'agent_stream'),
                duration_ms: Date.now() - _streamCallStart,
                organization_id: agent.organization_id || null,
                conversation_id: conversation?.id || null
            });
        } catch (e) { /* ignore usage errors */ }
    }

    return {
        contentBuffer, currentToolCalls, guardrailViolation,
        _sseStreamUsage, _sseFinishReason, _thinking,
    };
}

module.exports = { streamRawSseRound };
