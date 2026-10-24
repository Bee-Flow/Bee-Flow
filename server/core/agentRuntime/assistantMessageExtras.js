/**
 * The pieces ./finalizeTurn puts on (or takes off) the final assistant message
 * of a streaming agent turn: the stray tool-call / think markup stripped from
 * the text, the render-time un-tokenisation of the saved tool history and
 * thinking, and the tokenisation info behind the "Privacy protection" panel.
 *
 * The PII detector and the DLP runner are handed in as `privacy`
 * ({ piiDetection(), dlpRunner() }, lazy, by ./finalizeTurn): they sit in the
 * server's large import cycle, which this module stays out of.
 */
const log = require('../../telemetry/log');

// Cap total thinking size — runaway models can emit hundreds of KB of
// chain-of-thought, bloating conversation rows and slowing reads.
const THINKING_BUDGET = 64 * 1024;

/**
 * Strip raw tool-call XML tags from the response — some models (e.g. Mistral
 * thinking) output <tool_call>/<tool_response> as plain text instead of
 * structured function calls.
 *
 * BFSF-263: also strip COMPLETE <think> pairs that slipped through as a
 * defensive last line — but ONLY on the raw-fetch SSE path (OSS models behind
 * generic endpoints, where in-band reasoning is a real failure mode). Native
 * adapters already deliver reasoning as typed thinking events, so a <think>
 * pair in THEIR final text is intentional content (e.g. the user asked for an
 * example) and must survive.
 */
function stripToolCallMarkup(fullResponse, { useNativeAdapter, onEvent }) {
    if (!fullResponse) return fullResponse;
    const originalLen = fullResponse.length;
    if (!useNativeAdapter) {
        const { stripThinkTags } = require('../providers/thinkTagStream');
        fullResponse = stripThinkTags(fullResponse);
    }
    fullResponse = fullResponse
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
        .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
        .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, '')
        .trim();
    if (fullResponse.length !== originalLen) {
        log.info(`[AgentRuntime] Stripped tool-call XML/think tags from response (${originalLen} → ${fullResponse.length} chars)`);
        // Replace the content in the UI with the cleaned version
        onEvent('content_replace', { text: fullResponse });
    }
    return fullResponse;
}

/**
 * Render-time un-tokenisation for the saved tool history (mutated in place) —
 * mirror of the same pass in the direct-chat turn (routes/ai/directChat/).
 * toolHistory is never fed back to the AI; it surfaces in the "How I got this
 * answer" panel where the user wants real values.
 */
function restoreToolHistoryTokens(toolHistory, conversation, privacy) {
    try {
        const { restoreTokens } = privacy.piiDetection();
        const _convMapTH = privacy.dlpRunner().getConversationTokenMap(conversation?.id);
        if (Object.keys(_convMapTH).length === 0) return;
        for (const t of toolHistory) {
            if (typeof t?.resultPreview === 'string') {
                t.resultPreview = restoreTokens(t.resultPreview, _convMapTH);
            }
            if (t?.args && typeof t.args === 'object') {
                for (const k of Object.keys(t.args)) {
                    if (typeof t.args[k] === 'string') {
                        t.args[k] = restoreTokens(t.args[k], _convMapTH);
                    }
                }
            }
        }
    } catch (err) { log.debug('render-layer best-effort', err); }
}

const _capText = (s) => (typeof s === 'string' && s.length > THINKING_BUDGET)
    ? s.slice(0, THINKING_BUDGET) + '…[thinking truncated]'
    : (typeof s === 'string' ? s : '');

/**
 * The persisted `thinking` field, or undefined when there is none.
 *
 * Persistence format: the structured parts array (with signatures for Claude
 * replay) when there are parts; otherwise the flat string, kept for backwards
 * compat with memory extraction and anything reading the old shape. Both are
 * capped at THINKING_BUDGET.
 *
 * PII tokens are restored in persisted thinking too — same render-layer
 * rationale as the toolHistory pass. Without this the saved chain-of-thought
 * keeps raw placeholder tokens (e.g. [email_1]) that resurface verbatim on
 * reload (BFSF-253). Best-effort; the live stream is handled by the
 * un-tokeniser wrapper.
 */
function persistedThinking(thinkingParts, thinking, conversation, privacy) {
    let _restoreTH = (s) => s;
    try {
        const { restoreTokens } = privacy.piiDetection();
        const _convMapTHK = privacy.dlpRunner().getConversationTokenMap(conversation?.id);
        if (_convMapTHK && Object.keys(_convMapTHK).length > 0) {
            _restoreTH = (s) => (typeof s === 'string' ? restoreTokens(s, _convMapTHK) : s);
        }
    } catch (err) { log.debug('render-layer best-effort', err); }
    if (thinkingParts.length > 0) {
        let budget = THINKING_BUDGET;
        return thinkingParts.map(p => {
            const text = _restoreTH(typeof p.text === 'string' ? p.text : '');
            let outText;
            if (budget <= 0) {
                outText = '';
            } else if (text.length <= budget) {
                outText = text;
                budget -= text.length;
            } else {
                outText = text.slice(0, budget) + '…[thinking truncated]';
                budget = 0;
            }
            return {
                id: p.id,
                text: outText,
                startedAt: p.startedAt,
                endedAt: p.endedAt || Date.now(),
                redacted: p.redacted || undefined,
                signature: p.signature || undefined,
                redactedData: p.redactedData || undefined,
                phase: p.phase || undefined,
            };
        });
    }
    if (thinking) {
        // Legacy path: flat-string thinking without part metadata.
        return _capText(_restoreTH(thinking));
    }
    return undefined;
}

/** The token categories (`[email_1]` → `email`) of a list of tokens. */
function tokenCategories(tokens) {
    const catSet = new Set();
    for (const tok of tokens) {
        const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok);
        if (m) catSet.add(m[1]);
    }
    return [...catSet];
}

/**
 * Privacy / DLP — a tokenisation info for a turn where no new redaction
 * fired, or null. Emits `tokenisation_info` when it builds one, so the badge
 * and panel render live, not only after refresh (the frontend merges it into
 * the in-memory assistant message).
 *
 *   - 'restored': the reply echoed tokens from earlier turns, which the
 *     un-tokeniser (`ut`) swapped back to real values before the user saw
 *     them;
 *   - 'conversation_vault': no echo either, but the conversation has tokens
 *     in its vault — surface the protected-state badge so the user has
 *     continuous visual confirmation that privacy is engaged for this chat.
 *     This is state, not action: PII detection does NOT run on the reply;
 *     the conv map was populated on earlier turns.
 */
function synthesiseTokenisationInfo({ ut, conversation, modelToUse, onEvent }, privacy) {
    if (!ut || typeof ut.getReplacedTokens !== 'function') return null;
    const replaced = ut.getReplacedTokens();
    let info = null;
    if (replaced && replaced.size > 0) {
        const tokenMap = {};
        let totalCount = 0;
        for (const [token, entry] of replaced) {
            tokenMap[token] = entry.value;
            totalCount += entry.count || 0;
        }
        info = {
            source: 'restored',
            action: 'restore',
            count: totalCount,
            categories: tokenCategories(replaced.keys()),
            provider: modelToUse,
            automatic: true,
            tokenMap,
        };
    } else {
        const convMap = privacy.dlpRunner().getConversationTokenMap(conversation?.id) || {};
        const convEntries = Object.entries(convMap);
        if (convEntries.length === 0) return null;
        info = {
            source: 'conversation_vault',
            action: 'protected',
            count: convEntries.length,
            categories: tokenCategories(convEntries.map(([tok]) => tok)),
            provider: modelToUse,
            automatic: true,
            tokenMap: Object.fromEntries(convEntries),
        };
    }
    onEvent?.('tokenisation_info', info);
    return info;
}

module.exports = { stripToolCallMarkup, restoreToolHistoryTokens, persistedThinking, synthesiseTokenisationInfo };
