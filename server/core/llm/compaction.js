// @typecheck
/**
 * Conversation Compaction — Reduce token usage by summarizing old messages.
 *
 * When a conversation exceeds the compaction threshold, older messages are
 * summarized using the fast tier model, and only a summary + the last
 * `recentWindow` messages are sent to the LLM. Long tool results in the recent
 * window are pruned too.
 *
 * OPT-IN. This is a LOSSY rewrite of the conversation: whatever the fast-tier
 * summarizer leaves out is gone for the rest of the chat, and truncated tool
 * results cannot be recovered. On a model with a 1M-token context window that
 * cost buys nothing, so `options.enabled` gates the whole mechanism and the
 * product default is OFF (see core/llm/contextPolicy.js). Providers that
 * support it do the equivalent work server-side and losslessly — Anthropic's
 * `context_management` in core/providers/claude.js.
 *
 * Two things still happen with `enabled: false`:
 *   - nothing at all on a normal turn: messages pass through byte-identical,
 *     tool results included;
 *   - an EMERGENCY fold when the conversation alone is estimated to exceed
 *     `options.overflowTokens` (a fraction of the model's context window).
 *     A summary the user did not ask for beats a hard 400 "prompt is too long".
 */
const log = require('../../telemetry/log');

const COMPACTION_THRESHOLD = 16;  // Default: start compacting after this many messages
const RECENT_WINDOW = 8;         // Default: keep this many recent messages verbatim

/**
 * The synthetic priming turns this module injects, as named constants.
 *
 * These are PROMPT SCAFFOLDING, not conversation: the model never streamed the
 * two acknowledgements and the user never typed the two markers. They exist only
 * to keep user/assistant alternation valid across the compaction boundary.
 *
 * They are exported because the store's read-path normaliser has to recognise
 * them in already-persisted conversations (BFSF-307, where the compacted PROMPT
 * was being written back as the durable history). A copy-pasted literal over
 * there would be a time bomb — reword a prompt here and the filter silently
 * stops matching. Anything that recognises these MUST import them.
 *
 * `startsWith` for the markers (they are followed by the goal / summary text),
 * exact equality for the acknowledgements. Mind the characters: GOAL_ACK uses an
 * em-dash (U+2014), SUMMARY_ACK a straight apostrophe.
 */
const COMPACTION_MARKERS = Object.freeze({
    GOAL_PREFIX: '[Original request — treat this as the authoritative goal for the whole conversation; never ask the user to restate it]',
    GOAL_ACK: 'Understood — I will keep that original goal in mind.',
    SUMMARY_PREFIX: '[Conversation Summary — earlier messages have been compacted]',
    SUMMARY_PREFIX_NO_TEXT: '[Earlier messages have been compacted.',
    SUMMARY_ACK: 'Understood, I have the context from our earlier conversation. Let\'s continue.',
});
const TOOL_RESULT_MAX_LEN = 500; // Truncate tool results beyond this in recent window
// Per-file cap when carrying extracted text forward into the summary block.
// Sized to fit a typical script/spreadsheet without truncation (was 8k, which
// chopped the middle out of most uploads and broke BFSF-162). Anything larger
// still gets head-truncated with a marker pointing at the RustFS storage key.
const SUMMARY_FILE_TEXT_MAX_CHARS = 40_000;

// Unpaired UTF-16 high (D800-DBFF) or low (DC00-DFFF) surrogate. JSON parsers
// downstream of HTTP (notably Anthropic's) reject these, breaking the entire
// compaction call. Strip rather than escape so the summarizer still runs.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function stripLoneSurrogates(s) {
    if (typeof s !== 'string' || !s) return s;
    return s.replace(LONE_SURROGATE_RE, '�');
}

/**
 * Resolve the persisted watermark against the current conversation.
 *
 * The watermark counts how many non-system messages are already folded into
 * `existingSummary`. It is never trusted blindly: history can shrink (edit/
 * retry truncation) or the meta can be stale, in which case the summary would
 * describe messages that no longer exist — discard both and start over.
 * Single source of truth shared by needsSummarization() and compactMessages()
 * so the trigger check can never disagree with the execution.
 */
function _resolveWatermark(convMessages, existingSummary, summaryUpTo) {
    const summary = typeof existingSummary === 'string' && existingSummary ? existingSummary : null;
    if (!summary) return { watermark: 0, summary: null };
    if (!Number.isInteger(summaryUpTo) || summaryUpTo <= 0) return { watermark: 0, summary };
    if (convMessages.length <= summaryUpTo) return { watermark: 0, summary: null };
    return { watermark: summaryUpTo, summary };
}

/**
 * Whether compactMessages() would make a real summarization LLM call for this
 * input. Call sites use this to gate the user-visible "compacting" phase (and
 * its latency expectation) on actual work.
 */
function needsSummarization(messages, options = {}) {
    const convMessages = messages.filter(m => m.role !== 'system');
    const { watermark } = _resolveWatermark(convMessages, options.existingSummary, options.summaryUpTo);
    return !!_foldReason(convMessages, watermark, _resolveSettings(options));
}

/**
 * Normalise the tunables. `enabled` defaults to TRUE so the module keeps its
 * historical behaviour for any caller that doesn't pass a policy; the product
 * default (off) is applied by the call sites via contextPolicy.js.
 */
function _resolveSettings(options = {}) {
    const asInt = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);
    const threshold = asInt(options.threshold, COMPACTION_THRESHOLD);
    return {
        enabled: options.enabled !== false,
        threshold,
        recentWindow: Math.min(asInt(options.recentWindow, RECENT_WINDOW), Math.max(2, threshold - 2)),
        overflowTokens: Number.isFinite(options.overflowTokens) && options.overflowTokens > 0
            ? options.overflowTokens
            : null,
    };
}

/**
 * Rough token size of the conversation as it would be serialised into a
 * prompt. Only used for the overflow guard, so the 4-chars-per-token heuristic
 * in tokenBudget is precise enough — a ±15% error moves the emergency fold by
 * a few turns and nothing else.
 */
function _estimateMessageTokens(msg, estimateTokens) {
    let total = 0;
    if (typeof msg.content === 'string') {
        total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
            if (!part || typeof part !== 'object') continue;
            if (typeof part.text === 'string') total += estimateTokens(part.text);
            // An image costs roughly (w*h)/750 tokens; we don't have the
            // dimensions here, so charge a flat mid-size estimate rather than
            // nothing — a chat full of screenshots is exactly the case the
            // overflow guard exists for.
            else if (part.type === 'image_url' || part.type === 'image') total += 1_600;
            else if (part.type === 'tool_result') total += estimateTokens(
                typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '')
            );
            else if (part.type === 'document') total += 4_000;
        }
    } else if (msg.content != null) {
        total += estimateTokens(JSON.stringify(msg.content));
    }
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            total += estimateTokens(JSON.stringify(tc?.function?.arguments || tc || ''));
        }
    }
    return total;
}

function _estimateConversationTokens(convMessages) {
    const { estimateTokens } = require('./tokenBudget');
    let total = 0;
    for (const msg of convMessages) total += _estimateMessageTokens(msg, estimateTokens);
    return total;
}

/**
 * Fold boundary for the EMERGENCY path.
 *
 * The message-count window (`recentWindow`) is the wrong unit here: the guard
 * fires because of token size, and eight enormous turns are still eight
 * enormous turns. Walk backwards from the end instead and keep as many recent
 * messages as fit in a fraction of the budget, so one fold actually gets the
 * request back under the model's context window.
 *
 * Always keeps at least the final two messages — the current question and what
 * it is answering — even if they alone blow the budget; at that point there is
 * nothing left to fold and truncation is the caller's problem, not ours.
 */
const OVERFLOW_RETAIN_RATIO = 0.5;

function _overflowFoldTarget(convMessages, watermark, settings) {
    const { estimateTokens } = require('./tokenBudget');
    const budget = settings.overflowTokens * OVERFLOW_RETAIN_RATIO;
    let used = 0;
    let target = convMessages.length;
    for (let i = convMessages.length - 1; i > watermark; i--) {
        const kept = convMessages.length - i;
        used += _estimateMessageTokens(convMessages[i], estimateTokens);
        if (used > budget && kept > 2) break;
        target = i;
    }
    // Leave at least one message behind the boundary; otherwise the fold has
    // nothing to summarise and we would spend an LLM call to change nothing.
    return Math.min(target, convMessages.length - 1);
}

/**
 * WHY a fold should run — `null`, `'threshold'` or `'overflow'`.
 *
 * The two triggers are independent and both always apply:
 *
 *   'threshold' — the historical message-count trigger. Only when the org opted
 *                 into compaction.
 *   'overflow'  — the conversation is about to overrun the model's context
 *                 window. This is a safety net, not a preference, so it fires
 *                 whether or not compaction is enabled: a handful of enormous
 *                 turns can blow the window without ever reaching 16 messages,
 *                 and a 400 "prompt is too long" is worse than a summary.
 *
 * The caller needs the reason, not just a boolean: an overflow fold has to use
 * the token-based boundary (`_overflowFoldTarget`) to actually get back under
 * the limit, where a threshold fold uses the fixed recent window.
 */
function _foldReason(convMessages, watermark, settings) {
    const unsummarized = convMessages.length - watermark;
    if (settings.enabled && unsummarized > settings.threshold) return 'threshold';
    if (!settings.overflowTokens) return null;
    // Never fold a conversation that is too short to have a recent window
    // left over — there would be nothing to gain and a summary of two turns
    // is strictly worse than the two turns.
    if (unsummarized <= settings.recentWindow + 1) return null;
    return _estimateConversationTokens(convMessages) > settings.overflowTokens ? 'overflow' : null;
}

/**
 * Compact a message array for efficient LLM consumption.
 *
 * @param {Array} messages - Full message array (system + user/assistant/tool messages)
 * @param {object} [options]
 * @param {string} [options.existingSummary] - Previous compaction summary (from meta_json)
 * @param {number} [options.summaryUpTo] - Watermark: how many non-system messages are already folded into existingSummary
 * @param {string} [options.summaryModelId] - Model to use for summary generation (tier:fast)
 * @param {string|null} [options.userOrgId] - Org ID for EU-mode tier overrides
 * @returns {Promise<{ messages: Array, newSummary: string|null, summaryUpTo: number, didSummarize: boolean }>}
 *   newSummary is the summary the caller should persist (unchanged on the
 *   skip path, null when the watermark invalidated a stale summary).
 */
async function compactMessages(messages, options = {}) {
    // Separate system message(s) from conversation messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const convMessages = messages.filter(m => m.role !== 'system');

    const settings = _resolveSettings(options);
    const { watermark, summary: carriedSummary } = _resolveWatermark(
        convMessages, options.existingSummary, options.summaryUpTo
    );
    const foldReason = _foldReason(convMessages, watermark, settings);
    const mustSummarize = !!foldReason;
    if (foldReason === 'overflow') {
        log.warn(`[Compaction] Overflow guard fired — conversation is within ${settings.overflowTokens} `
            + `tokens of the model context window, folding ${convMessages.length} messages.`);
    }

    // Nothing folded yet and no reason to fold now.
    //
    // With compaction disabled the messages are returned EXACTLY as they came
    // in — no tool-result pruning either. Truncating every tool result to ~700
    // characters on every turn was the single largest silent context loss in
    // the product: it applied to short conversations too, so an agent that
    // read a file or ran a query could no longer see what it got back.
    if (!mustSummarize && watermark === 0) {
        return {
            messages: settings.enabled
                ? [...systemMessages, ...pruneToolResults(convMessages)]
                : [...systemMessages, ...convMessages],
            newSummary: carriedSummary,
            summaryUpTo: 0,
            didSummarize: false,
        };
    }

    // Skip path: the prefix up to the watermark is already folded into
    // carriedSummary — rebuild the summary block from stored text without an
    // LLM call. Fold path: extend the fold to `length - RECENT_WINDOW`.
    let boundary = watermark;
    let effectiveSummary = carriedSummary;
    let didSummarize = false;

    if (mustSummarize) {
        // Split into old (to summarize) and recent (to keep verbatim).
        // The naive boundary `length - RECENT_WINDOW` can land directly on an
        // orphan `tool` message — its matching assistant(tool_use) is the last
        // message in `old`, which gets collapsed into the summary. Anthropic
        // then rejects the request with "unexpected tool_use_id found in
        // tool_result blocks". Walk the boundary forward past every leading
        // tool message so the recent window always starts on a normal turn.
        // (An assistant(tool_use) at the boundary IS fine — its results follow
        // in the recent window.)
        // An overflow fold is sized in TOKENS, not messages: keeping a fixed
        // eight recent turns is no help when those eight are what blew the
        // window. A threshold fold keeps the configured recent window.
        let target = foldReason === 'overflow'
            ? _overflowFoldTarget(convMessages, watermark, settings)
            : convMessages.length - settings.recentWindow;
        if (target < watermark) target = watermark; // never re-fold already-summarized content
        while (target < convMessages.length && convMessages[target].role === 'tool') {
            target++;
        }

        // Only the messages between the old watermark and the new boundary are
        // new to the summarizer; earlier ones are already in carriedSummary.
        // The file inventory covers the whole dropped prefix so the running
        // narrative keeps mentioning every file that lives behind the summary.
        const newlyEvicted = convMessages.slice(watermark, target);
        const inventoryAttachments = collectUniqueAttachments(convMessages.slice(0, target));
        const generated = await generateSummary(
            newlyEvicted, carriedSummary, options.summaryModelId, options.userOrgId, inventoryAttachments
        );
        if (generated) {
            effectiveSummary = generated;
            boundary = target;
            didSummarize = true;
        }
        // On summarizer failure boundary stays at the watermark: the newly
        // evicted messages remain verbatim in the output and the watermark
        // does not advance past content that was never summarized — the fold
        // is retried next turn.
    } else if (convMessages[boundary]?.role === 'tool') {
        // Defensive: a shifted history could park the watermark on a tool
        // message whose tool_use is behind the fold; skip such orphans.
        while (boundary < convMessages.length && convMessages[boundary].role === 'tool') {
            boundary++;
        }
    }

    const droppedMessages = convMessages.slice(0, boundary);
    const recentMessages = convMessages.slice(boundary);

    // Hoist any image_url blocks from the dropped prefix so visual context
    // isn't lost when their text gets collapsed into a summary. Deduped by URL
    // so the same image uploaded once isn't repeated N times. This scans the
    // FULL dropped prefix (not just the newly folded slice) because history is
    // rebuilt from the DB every turn and the summary message is transient —
    // the hoist has to be reproduced on every call, including the skip path.
    const hoistedImages = [];
    const seenUrls = new Set();
    for (const msg of droppedMessages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
            if (part?.type !== 'image_url') continue;
            const url = part.image_url?.url;
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            hoistedImages.push({ type: 'image_url', image_url: { url, detail: part.image_url.detail || 'auto' } });
        }
    }

    // Hoist unique attachment sidecars from the dropped prefix so file context
    // survives compaction. Without this, a PDF uploaded on turn 2 would be
    // visible to the model up to turn 10 (via the historyHydrator extractedText
    // re-injection) and then disappear once compaction folds turn 2 into the
    // summary. We keep per-file extracted text on the summary message itself.
    const hoistedAttachments = collectUniqueAttachments(droppedMessages);

    // Build compacted message array: system + summary-as-context + recent messages
    const compacted = [
        ...systemMessages,
    ];

    // Pin the user's ORIGINAL request verbatim so a long, multi-turn chat never
    // loses the stated goal when older turns are folded into the lossy fast-tier
    // summary — the model would otherwise drift and ask the user to restate it
    // (BFSF-154). Skip if that first user turn is still in the retained window.
    const _firstUserMsg = convMessages.find(m => m && m.role === 'user');
    if (_firstUserMsg && !recentMessages.includes(_firstUserMsg)) {
        let _goalText = '';
        if (typeof _firstUserMsg.content === 'string') _goalText = _firstUserMsg.content;
        else if (Array.isArray(_firstUserMsg.content)) {
            _goalText = _firstUserMsg.content
                .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text).join(' ');
        }
        _goalText = (_goalText || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
        if (_goalText) {
            compacted.push({ role: 'user', content: `${COMPACTION_MARKERS.GOAL_PREFIX}
${_goalText}` });
            compacted.push({ role: 'assistant', content: COMPACTION_MARKERS.GOAL_ACK });
        }
    }

    if (effectiveSummary || hoistedImages.length > 0 || hoistedAttachments.length > 0) {
        const summaryText = effectiveSummary
            ? `${COMPACTION_MARKERS.SUMMARY_PREFIX}
${effectiveSummary}`
            : `${COMPACTION_MARKERS.SUMMARY_PREFIX_NO_TEXT} Files and images from those turns are still attached below.]`;

        // Build the summary content: narrative + extracted text per hoisted
        // file (so the model can still answer detail questions about earlier
        // attachments) + the actual image_url blocks for hoisted images.
        const fileBlocks = hoistedAttachments
            .map(att => {
                const raw = typeof att.extractedText === 'string' ? att.extractedText : '';
                if (!raw) return null;
                if (raw.length <= SUMMARY_FILE_TEXT_MAX_CHARS) {
                    return { type: 'text', text: raw };
                }
                const head = raw.slice(0, SUMMARY_FILE_TEXT_MAX_CHARS - 200);
                const ref = att.storageKey ? ` storageKey=${att.storageKey}` : '';
                return {
                    type: 'text',
                    text: `${head}\n\n[…${att.name || 'file'} truncated for summary; full text available on demand${ref}]`,
                };
            })
            .filter(Boolean);

        const hasMultimodalParts = hoistedImages.length > 0 || fileBlocks.length > 0;
        const summaryContent = hasMultimodalParts
            ? [{ type: 'text', text: summaryText }, ...fileBlocks, ...hoistedImages]
            : summaryText;

        // Carry the sidecar forward too, so any future hydration pass (e.g. on
        // a retry) can still see which files this summary represents.
        const summaryMsg = { role: 'user', content: summaryContent };
        if (hoistedAttachments.length > 0) {
            summaryMsg.attachments = hoistedAttachments.map(({ extractedText, ...rest }) => rest);
        }
        compacted.push(summaryMsg);
        compacted.push({
            role: 'assistant',
            content: COMPACTION_MARKERS.SUMMARY_ACK,
        });
    }

    // The recent window keeps its tool results verbatim unless compaction is
    // actually enabled — see the pass-through branch above for why.
    compacted.push(...(settings.enabled ? pruneToolResults(recentMessages) : recentMessages));

    if (didSummarize) {
        log.info(`[Compaction] Compacted ${convMessages.length} messages → summary + ${recentMessages.length} recent`);
    }

    return { messages: compacted, newSummary: effectiveSummary, summaryUpTo: boundary, didSummarize };
}

/**
 * Collect unique attachment sidecars across an array of messages.
 * Dedupe key prefers storageKey, falls back to url, finally name+type.
 */
function collectUniqueAttachments(messages) {
    const seen = new Set();
    const out = [];
    for (const msg of messages) {
        if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) continue;
        for (const att of msg.attachments) {
            const key = att.storageKey || att.url || `${att.name || ''}::${att.type || ''}`;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(att);
        }
    }
    return out;
}

/**
 * Generate a summary of conversation messages using the fast tier model.
 *
 * If hoistedAttachments are provided, the summarizer is given a separate
 * inventory block and instructed to preserve those file references verbatim.
 * The narrative stays under 200 words; the inventory is rendered alongside.
 */
async function generateSummary(oldMessages, existingSummary, summaryModelId, userOrgId = null, hoistedAttachments = []) {
    const llmClient = require('./llmClient');

    // Build the content to summarize
    let contentToSummarize = '';

    if (existingSummary) {
        contentToSummarize += `Previous summary:\n${existingSummary}\n\n---\n\nNew messages to incorporate:\n`;
    }

    for (const msg of oldMessages) {
        if (msg.role === 'user') {
            let text;
            if (typeof msg.content === 'string') {
                text = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Multimodal content — extract text parts, note images as placeholders
                text = msg.content.map(part => {
                    if (part.type === 'text') return part.text || '';
                    if (part.type === 'image_url') return '[image]';
                    return '';
                }).filter(Boolean).join(' ');
            } else {
                text = '';
            }
            contentToSummarize += `User: ${text.substring(0, 300)}\n`;
        } else if (msg.role === 'assistant') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            contentToSummarize += `Assistant: ${text.substring(0, 300)}\n`;
        } else if (msg.role === 'tool') {
            contentToSummarize += `[Tool result: ${String(msg.content).substring(0, 100)}...]\n`;
        }
    }

    if (hoistedAttachments && hoistedAttachments.length > 0) {
        const inventory = hoistedAttachments
            .map(att => `- ${att.name || 'unnamed'} (${att.type || 'unknown'})`)
            .join('\n');
        contentToSummarize += `\n---\nFiles attached during these turns (full text is preserved separately, do NOT re-summarize their contents in your narrative):\n${inventory}\n`;
    }

    // Resolve model — handle tier: prefix (EU-aware)
    let modelId = summaryModelId || 'tier:fast';
    if (modelId.startsWith('tier:')) {
        try {
            const { resolveModelForTierName } = require('./modelResolver');
            const tierName = modelId.substring(5);
            modelId = await resolveModelForTierName(tierName, { userOrgId, fallback: 'gemini-2.0-flash-lite' });
        } catch (e) {
            modelId = 'gemini-2.0-flash-lite';
        }
    }

    // Strip lone UTF-16 surrogates. Some upstream content (mangled paste,
    // truncated emoji, broken decoder) leaves unpaired D800-DBFF / DC00-DFFF
    // codepoints which Anthropic's JSON parser rejects with
    //   "no low surrogate in string: line 1 column N"
    // and the whole compaction call fails. Replace with U+FFFD so the
    // summarizer still runs and the conversation actually shrinks.
    contentToSummarize = stripLoneSurrogates(contentToSummarize);

    try {
        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: 'You are a conversation summarizer. Produce a concise summary of the conversation below. Include: key topics discussed, important decisions or conclusions, specific file/code/data references named verbatim, and any pending tasks or questions. If a "Files attached during these turns" inventory is provided, mention each file by name in your narrative but do NOT attempt to summarize their contents — the full text is preserved separately. Keep the narrative under 200 words. Output only the summary, no preamble.',
            },
            { role: 'user', content: contentToSummarize },
        ], { maxTokens: 300, temperature: 0.2 });

        const summary = result.content?.trim();
        if (summary) {
            log.info(`[Compaction] Generated summary (${summary.length} chars) using ${modelId}`);
            return summary;
        }
    } catch (err) {
        log.error('[Compaction] Summary generation failed:', err.message);
    }

    // Signal failure to the caller: compactMessages falls back to the skip
    // path so the watermark never advances past messages that were never
    // actually summarized (they stay verbatim; the fold retries next turn).
    return null;
}

/**
 * Prune long tool results in a message array to reduce token count.
 * Only truncates tool result messages, leaves user/assistant intact.
 */
function pruneToolResults(messages) {
    return messages.map(msg => {
        if (msg.role !== 'tool') return msg;

        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        if (content.length <= TOOL_RESULT_MAX_LEN * 2) return msg;

        // Truncate to max length, keeping start and end for context
        const truncated = content.substring(0, TOOL_RESULT_MAX_LEN)
            + '\n...[truncated]...\n'
            + content.substring(content.length - 200);

        return { ...msg, content: truncated };
    });
}

module.exports = {
    compactMessages, needsSummarization, COMPACTION_THRESHOLD, RECENT_WINDOW,
    collectUniqueAttachments, COMPACTION_MARKERS,
};
