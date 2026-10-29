// @typecheck strict
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
 * The request body, the fetch, the per-frame parsing and the usage row live
 * in ./rawSseParts. Usage is buffered and logged once after the stream ends;
 * the turn's counters and stop reason are the caller's.
 */
const { checkRegexPatterns } = require('../../privacy/guardrails');
const log = require('../../../telemetry/log');
const { buildRawRequestBody, fetchRawStream, applySseFrame, logRawUsage } = require('./rawSseParts');
const usageStore = require('../../../stores/usageStore');
const { applyTokenMapToOutbound } = require('../../dlp/applyTokenMapToOutbound');
const { fallback } = require('../../../utils/bestEffort');

// What ./rawSseParts works with, handed in (it stays out of the server's large
// import cycle).
const PARTS_DEPS = { applyTokenMapToOutbound, usageStore };

/**
 * @param {{
 *   agent: import('./turnState').AgentRow, agentId: string, userId: string,
 *   messageMetadata: import('./turnState').MessageMetadata, modelToUse: string,
 *   conversation: import('./turnState').ConversationRow, tools: import('./turnState').ToolDef[],
 *   signal?: AbortSignal, onEvent: import('./turnState').OnEvent,
 *   regexConfig?: import('./roundRequest').RegexConfig | null, guardrailViolation?: string | null,
 *   _forceFinalAnswer?: boolean, effectiveSystemPrompt: string, effectiveVolatilePrompt: string,
 *   finalMessages: import('./turnState').ChatMessage[], tierSettings: import('./roundRequest').TierSettings,
 *   headers: Record<string, string>, apiUrl: string, _streamCallStart: number, _thinking: string,
 * }} turn
 */
async function streamRawSseRound({
    agent, agentId, userId, messageMetadata, modelToUse, conversation,
    tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
    effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
    headers, apiUrl, _streamCallStart, _thinking,
}) {
    // ─── Raw fetch SSE streaming (OpenAI-compatible) ──────────────
    const requestBody = buildRawRequestBody({
        agentId, modelToUse, conversation, tools, _forceFinalAnswer,
        effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
    }, PARTS_DEPS);
    const response = await fetchRawStream({ apiUrl, headers, requestBody, signal });

    // Parse SSE stream
    if (!response.body) throw new Error('The provider answered without a response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // The round's state. The latest usage frame and finish_reason are buffered
    // and logged once after the stream ends: logging inside the loop caused
    // duplicate rows whenever a server emitted more than one usage frame (and
    // was racy with the inner async path).
    /** @type {import('./rawSseParts').RawRoundState} */
    const rs = {
        contentBuffer: '', currentToolCalls: [], thinking: _thinking,
        usage: null, finishReason: null, guardTripped: false,
    };

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
    const _emitVisibleText = (/** @type {string} */ text) => {
        rs.contentBuffer += text;
        // Real-time Agent Output validation - check as we stream
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput) {
            const matches = checkRegexPatterns(rs.contentBuffer, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                log.info(`[RegexGuard] Agent output violated rules during stream: ${ruleNames}`);
                // Cancel remaining stream and send redacted message
                rs.contentBuffer = `I apologize, but I cannot provide that response as it contains content that violates the ${ruleNames} policy.`;
                onEvent('content_replace', { text: rs.contentBuffer }); // Replace all content
                guardrailViolation = ruleNames; // Mark as violation
                reader.cancel(); // Cancel the stream
                rs.guardTripped = true;
                return;
            }
        }
        onEvent('content', { text });
    };
    const sseThinkSplitter = createThinkTagSplitter(/** @type {Parameters<typeof createThinkTagSplitter>[0]} */ ({
        onText: _emitVisibleText,
        onThinking: (/** @type {string} */ text) => {
            onEvent('thinking', { text });
            rs.thinking += text;
        },
    }));

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            let verdict;
            try {
                verdict = applySseFrame(JSON.parse(data), rs, { splitter: sseThinkSplitter, onEvent });
            } catch (e) { fallback('core/agentRuntime/chatStream/rawSseStream:streamRawSseRound', e); /* Skip parse errors */ }
            if (verdict === 'break') break;
        }
    }

    // Release anything the splitter held back (an unclosed <think>
    // runs to end-of-stream as reasoning; a partial tag flushes as
    // text) before the post-stream bookkeeping reads contentBuffer.
    sseThinkSplitter.flush();

    await logRawUsage({
        agent, agentId, userId, modelToUse, messageMetadata, conversation,
        usage: rs.usage, finishReason: rs.finishReason, _streamCallStart,
    }, PARTS_DEPS);

    return {
        contentBuffer: rs.contentBuffer, currentToolCalls: rs.currentToolCalls, guardrailViolation,
        _sseStreamUsage: rs.usage, _sseFinishReason: rs.finishReason, _thinking: rs.thinking,
    };
}

module.exports = { streamRawSseRound };
