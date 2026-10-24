// @typecheck
/**
 * Direct Chat end-of-turn: the steps that settle the assistant TEXT before it
 * is saved. Flush + display-segment join, the raw-payload transparency event,
 * PII token restoration for display, the regex guard on agent output, and the
 * empty-response guard with the Claude no-thinking auto-retry. Split out of
 * finalizeTurn.js; behaviour unchanged.
 *
 * `fullContent` is what is STORED (stays tokenised); `displayContent` is what
 * the user sees. Each step returns the pair it may have changed.
 */

const configStore = require('../../../stores/configStore');
const { checkRegexPatterns } = require('../../../core/privacy/guardrails');
const { applyTokenMapToMessages } = require('../../../core/dlp/applyTokenMapToOutbound');
const log = require('../../../telemetry/log');
const { bestEffort, fallback } = require('../../../utils/bestEffort');

const RAW_BUFFER_MAX = 64 * 1024;

/** Flush the streaming un-tokeniser, join the display segments, fill an empty tool-only reply. */
function settleStreamedContent({ fullContent, streamContentFlush, displaySegments, toolCallRounds, send }) {
    // Release any tail held by the streaming un-tokeniser. The end-of-stream
    // `restoreTokens` also fires a full `content_replace` as a final safety
    // net, but flushing here means a stable token sitting at the very end of
    // the stream gets replaced via the live content channel.
    try { streamContentFlush(); } catch (err) { bestEffort('routes/ai/directChat/finalizeContent:settleStreamedContent', err); /* best-effort */ }

    // BFSF-261: make persistence match the live view: join the earlier rounds'
    // preamble text with the final round. Everything downstream (empty-check,
    // raw-payload capture, PII restore/content_replace, regex guard, save)
    // reads the joined content. The MODEL-facing history is untouched.
    if (displaySegments.hasSegments()) {
        fullContent = displaySegments.joinFinal(fullContent);
    }

    // If LLM returned an empty response after tool calls, send a minimal confirmation
    if (!fullContent.trim() && toolCallRounds > 0) {
        fullContent = 'Done ✓';
        send('content', { text: fullContent });
    }
    return fullContent;
}

/**
 * Transparency: emit the raw (pre-un-tokenise) response once per turn when
 * the org has `showRawPayload` on. Captured BEFORE restoreTokens so the user
 * sees the exact string the LLM produced. Capped at 64 KB.
 */
function emitRawResponse({ fullContent, orgShield, tokenisationInfo, send }) {
    if (!(orgShield?.showRawPayload && fullContent)) return;
    const truncated = fullContent.length > RAW_BUFFER_MAX;
    const rawForClient = truncated ? fullContent.slice(0, RAW_BUFFER_MAX) + '…' : fullContent;
    send('privacy_response_raw', {
        rawResponse: rawForClient,
        truncated,
        timestamp: Date.now(),
    });
    if (tokenisationInfo) {
        tokenisationInfo.rawResponse = rawForClient;
        tokenisationInfo.rawTruncated = truncated;
    }
}

/**
 * PII token restoration for the USER-FACING display channel only. The stored
 * `fullContent` MUST stay tokenised so the next turn's history (fed back to
 * the model) holds no real PII; otherwise a follow-up such as "spell each
 * email character by character" would let the model reformat real values it
 * should never have seen. Returns the display text.
 */
function restoreForDisplay({ fullContent, convId, piiTokenMap, send }) {
    if (!fullContent) return fullContent;
    const { restoreTokens } = require('../../../core/privacy/piiDetection');
    const dlpRunner = require('../../../core/dlp/dlpRunner');
    const convMap = dlpRunner.getConversationTokenMap(convId) || {};
    const mergedMap = { ...convMap, ...(piiTokenMap || {}) };
    if (Object.keys(mergedMap).length === 0) return fullContent;
    const restored = restoreTokens(fullContent, mergedMap);
    if (restored === fullContent) return fullContent;
    log.info(`[DirectChat] 🔓 PII tokens restored for display (${Object.keys(mergedMap).length} tokens in scope, ${fullContent.length}→${restored.length} chars); storage stays tokenised`);
    send('content_replace', { text: restored });
    return restored;
}

/**
 * Check agent output against regex rules, on `displayContent` (un-tokenised):
 * the patterns are designed to match real values like emails, phone numbers
 * and IBANs. Redactions also replace `fullContent` (storage) so the next turn
 * doesn't replay leaked content.
 */
function applyOutputRegexGuard({ fullContent, displayContent, regexConfig, send }) {
    if (!(regexConfig?.enabled && regexConfig?.scope?.agentOutput && displayContent)) return { fullContent, displayContent };
    const matches = checkRegexPatterns(displayContent, regexConfig.rulesWithNames);
    if (matches.length === 0) return { fullContent, displayContent };
    const ruleNames = matches.map(m => m.ruleName).join(', ');
    log.info(`[DirectChat RegexGuard] Agent output violated rules: ${ruleNames}`);
    if (regexConfig.action !== 'redact') {
        send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5, source: 'agent_output' });
        return { fullContent, displayContent };
    }
    let redacted = displayContent;
    for (const rule of regexConfig.rulesWithNames) {
        try {
            const regex = new RegExp(rule.pattern, 'gi');
            redacted = redacted.replace(regex, `[REDACTED: ${rule.name}]`);
        } catch (e) { fallback('routes/ai/directChat/finalizeContent:applyOutputRegexGuard', e); /* skip */ }
    }
    send('content_replace', { text: redacted });
    // redaction is destructive: replace storage too
    return { fullContent: redacted, displayContent: redacted };
}

/** One non-streaming call without thinking; the recovered text, or null. */
async function retryWithoutThinking({ adapter, apiKey, apiUrl, modelId, convId, messages, chatOptions, send }) {
    let autoRetryEnabled = true;
    try {
        const cs = await configStore.getConfig('claude_settings');
        if (cs && cs.autoRetryOnEmpty === false) autoRetryEnabled = false;
    } catch (err) { fallback('routes/ai/directChat/finalizeContent:retryWithoutThinking', err); /* default true */ }
    if (!autoRetryEnabled) return null;
    try {
        log.info('[DirectChat] Empty content with thinking — auto-retrying without thinking');
        send('phase', { type: 'auto_retry_no_thinking' });
        const retryRes = await adapter.chat(apiKey, apiUrl, modelId,
            applyTokenMapToMessages({ conversationId: convId, messages }),
            {
                ...chatOptions,
                reasoningEffort: 'none',
                tools: undefined,
                toolChoice: undefined,
                maxTokens: Math.min(chatOptions.maxTokens || 8192, 8192),
            }
        );
        const retryText = retryRes?.content;
        if (retryText && retryText.trim()) {
            try { send('content_replace', { text: retryText }); } catch (err) { bestEffort('routes/ai/directChat/finalizeContent:retryWithoutThinking#2', err); /* ignore */ }
            log.info(`[DirectChat] Auto-retry recovered ${retryText.length} chars`);
            return retryText;
        }
    } catch (e) {
        log.warn(`[DirectChat] Auto-retry failed: ${e.message}`);
    }
    return null;
}

/**
 * Empty-response guard + Claude auto-retry. When the model emits only tool
 * calls, `fullContent` is empty; saving an empty bubble cascades into
 * title-gen 400s and a confusing error in the chat UI. For Claude adaptive
 * thinking (thinking and output share one max_tokens pot) a heavy turn can
 * spend the budget on thinking: with thinking content in hand, do ONE
 * follow-up call without thinking. Admin-disable via
 * `claude_settings.autoRetryOnEmpty`. Otherwise surface a fallback line.
 */
async function guardEmptyResponse(t) {
    const { fullContent, displayContent, modelId, config, thinkingContent, notebookWriteCommitted, collectedToolHistory, send } = t;
    if (fullContent && fullContent.trim()) return { fullContent, displayContent };
    const isClaude = /claude/i.test(modelId) || config.providerType === 'claude';
    if (isClaude && thinkingContent && thinkingContent.trim()) {
        const recovered = await retryWithoutThinking(t);
        if (recovered) return { fullContent: recovered, displayContent: recovered };
    }
    const fallbackText = notebookWriteCommitted
        ? 'I wrote the answer to your Notebook — open the Notebook panel to view it.'
        : 'The model returned no response. Please try rephrasing your question.';
    log.warn(`[DirectChat] Empty assistant content (toolsUsed=${collectedToolHistory.length > 0}, notebookWriteCommitted=${notebookWriteCommitted}) — surfacing fallback line.`);
    try { send('content_replace', { text: fallbackText }); } catch (err) { bestEffort('routes/ai/directChat/finalizeContent:guardEmptyResponse', err); /* SSE may be closing */ }
    return { fullContent: fallbackText, displayContent: fallbackText };
}

module.exports = {
    settleStreamedContent,
    emitRawResponse,
    restoreForDisplay,
    applyOutputRegexGuard,
    guardEmptyResponse,
};
