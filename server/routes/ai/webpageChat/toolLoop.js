/**
 * Webpage chat: the tool rounds of one turn (routes/ai/webpageChat.js). The
 * tool menu and options, the turn's shared state, the termination monitor's
 * bookkeeping, the Privacy Shield's token addendum and response
 * un-tokeniser, and the multi-round streaming loop with its plan, validation
 * and round-cap exits.
 */

'use strict';

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const terminationStore = require('../../../stores/terminationStore');
const { sanitizeError } = require('../../../core/privacy/errorSanitizer');
const { emitPhase } = require('../../../core/agentRuntime/phaseEvents');
const { WEBPAGE_DOC_TOOLS, WEBPAGE_ADD_SOURCE_TOOL } = require('../../../integrations/webpageDocTools');
const { PROPOSE_WEBPAGE_PLAN_TOOL } = require('../../../integrations/webpagePlanTool');
const { WEBPAGE_SET_FRAMEWORK_TOOL, WEBPAGE_SET_RUNTIME_TOOL } = require('../../../integrations/webpageFramework');
const { WEBPAGE_MULTI_FILE_TOOLS } = require('../../../integrations/webpageMultiFileTools');
const { WEBPAGE_DB_TOOLS } = require('../../../integrations/webpageDbTools');
const { AGENT_SEARCH_TOOLS } = require('../../../integrations/agentSearchTools');
const { WEBPAGE_SCREENSHOT_TOOL } = require('../../../integrations/webpageScreenshotTools');
const { WEBPAGE_BRIDGE_TOOLS } = require('../../../integrations/webpageBridgeTools');
const { WEBPAGE_KB_SEARCH_TOOL } = require('../../../core/webpages/webpageKnowledgeSearch');
const { createToolDispatcher } = require('./tools');
const { createValidationRepair } = require('./validation');
const { fallback, bestEffort } = require('../../../utils/bestEffort');

/**
 * Runs the rounds until the model stops calling tools (or a plan, the round
 * cap or the client ends them). `messages` grows in place. Returns what the
 * end of the turn (./finalize.js) needs.
 */
async function runToolLoop({
    send, req, adapter, apiKey, apiUrl, modelId, messages, tiers, resolvedTier, clientSignal, isGone,
    webpage, webpageId, userId, userOrgForTiers, attachments, chatMode, planExecution,
    kbIds, searchAvailable, framework, html, css, js, sources, modelSupportsVision,
    shieldGate, _dlpConvId, _dlpActive,
}) {
    // Tool list
    const webpageTools = [...WEBPAGE_DOC_TOOLS, ...WEBPAGE_MULTI_FILE_TOOLS, ...WEBPAGE_DB_TOOLS, ...WEBPAGE_BRIDGE_TOOLS, WEBPAGE_ADD_SOURCE_TOOL, WEBPAGE_SET_FRAMEWORK_TOOL, WEBPAGE_SET_RUNTIME_TOOL, WEBPAGE_SCREENSHOT_TOOL];
    // Plan tool exposed ONLY in ask/plan modes — auto mode is "just work,
    // no approval gate". Also dropped on plan-execution turns so the AI
    // can't propose another plan after the user already approved one.
    const planToolAvailable = !planExecution && (chatMode === 'ask' || chatMode === 'plan');
    if (planToolAvailable) webpageTools.push(PROPOSE_WEBPAGE_PLAN_TOOL);
    if (kbIds.length > 0) webpageTools.push(WEBPAGE_KB_SEARCH_TOOL);
    if (searchAvailable) webpageTools.push(...AGENT_SEARCH_TOOLS);

    // Live in-memory file state — kept in sync with tool calls so the
    // model sees its own writes mid-turn.
    const liveFiles = { html, css, js };
    // The state this turn STARTED with. Only three string references, so
    // free, and without this copy the turn's line delta can no longer be
    // measured afterwards: the tools overwrite `liveFiles` in place.
    const preTurnFiles = { ...liveFiles };
    const dirtySlots = new Set();
    // Per-turn read-set: tracks slots the AI called webpage_file_read on so
    // the read-before-edit guard can warn when an edit comes in cold.
    const readSlots = new Set();
    // Post-generation validation bookkeeping (BFSF-222): extra files the
    // AI touched this turn + the framework as of the latest tool round, so
    // the end-of-turn validator knows what to scan. At most ONE repair
    // round per turn.
    const touchedExtraPaths = new Set();
    // Shared with the executor (./tools.js) and the validator (./validation.js),
    // which flip and read the mutable fields round over round.
    const turn = {
        liveFiles, preTurnFiles, dirtySlots, readSlots, touchedExtraPaths,
        validationRepairUsed: false,
        currentFramework: framework,
        // Flips to true when the AI calls propose_webpage_plan — the chat
        // handler exits the streaming/tool loop after the current round so the
        // user gets a chance to approve before any files are touched.
        planProposedThisTurn: false,
        pendingVisionImages: [],
    };

    const tierSettings = tiers[resolvedTier] || {};
    const { TIER_DEFAULTS } = require('../../../core/llm/modelResolver');
    const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
    const chatOptions = {
        // Every adapter.stream call in this turn spreads chatOptions, so
        // one listener cancels the request in flight to the model too.
        signal: clientSignal,
        maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
        temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
    };

    let toolCallRounds = 0;
    // 20 rounds — DB workflows (schema → seed → verify → fix) routinely run
    // long, and partial edits via webpage_file_replace cluster the same way.
    // Opus 4.7 agentic builds were hitting the previous 10-round cap with
    // "no response" tail states. Admin can override via max_tool_rounds_chat.
    const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 20;

    // ── Termination monitor bookkeeping ───────────────────────────────
    // Tracks tokens, latency and the most recent stop_reason so we can
    // log abnormal terminations (max_tokens / max_iterations / error)
    // without persisting any message content.
    const _termStart = Date.now();
    let _termPromptTokens = 0;
    let _termCompletionTokens = 0;
    let _termLastStopReason = null;
    // Attachment metadata — counts + total bytes only, no filenames or
    // content. Helps explain max_tokens stops where the user uploaded a
    // big file and the LLM ran out of room before a useful answer.
    const _termAttachmentCount = Array.isArray(attachments) ? attachments.length : 0;
    const _termAttachmentBytes = (() => {
        if (!Array.isArray(attachments)) return 0;
        let total = 0;
        for (const att of attachments) {
            if (!att?.content || typeof att.content !== 'string') continue;
            if (att.content.startsWith('data:')) {
                // base64 — actual bytes are ~3/4 of the base64 length.
                const comma = att.content.indexOf(',');
                const b64 = comma >= 0 ? att.content.slice(comma + 1) : att.content;
                total += Math.floor(b64.length * 0.75);
            } else {
                total += Buffer.byteLength(att.content, 'utf8');
            }
        }
        return total;
    })();
    const _terminationBase = () => ({
        user_id: userId || null,
        organization_id: userOrgForTiers || null,
        agent_id: webpageId || null,
        agent_name: webpage?.name ? `Webpage: ${webpage.name}` : 'Webpage chat',
        model: modelId || null,
        source: 'webpage_chat',
        conversation_id: webpageId || null,
        iteration_count: toolCallRounds,
        duration_ms: Date.now() - _termStart,
        prompt_tokens: _termPromptTokens,
        completion_tokens: _termCompletionTokens,
        total_tokens: _termPromptTokens + _termCompletionTokens,
        attachment_count: _termAttachmentCount,
        attachment_bytes: _termAttachmentBytes,
    });

    // Screenshots captured this round, queued to be handed to a vision-capable
    // model as a user message after the tool results (tool-result content must
    // be a string for non-Claude providers). Drained inside the tool loop.
    const { pendingVisionImages } = turn;

    const dispatchToolCall = createToolDispatcher({
        send, req, shieldGate, planToolAvailable, webpageId, userId, userOrgForTiers,
        kbIds, sources, modelSupportsVision, _dlpConvId,
    }, turn);
    const maybeBuildValidationRepair = createValidationRepair({ send, webpageId, userId }, turn);

    // Unified streaming loop: every model round streams, so users see
    // text + reasoning + tool calls immediately rather than waiting on
    // blocking chat completions before the first paint.
    // PII token-preservation: when attachment scanning minted tokens, tell the
    // model what the [token]s mean so it echoes them verbatim. Best-effort.
    if (_dlpActive) {
        try {
            const { buildTokenPreservationAddendum } = require('../../../core/dlp/tokenPreservationPrompt');
            const _convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId);
            const _add = buildTokenPreservationAddendum(_convMap);
            if (_add && messages[0]?.role === 'system') messages[0].content += _add;
        } catch (err) { fallback('routes/ai/webpageChat/toolLoop:runToolLoop', err); /* best-effort */ }
    }
    // Response un-tokeniser: restore [token]s minted from attachment PII back to
    // real values as chunks stream (shared by every phase below). Passthrough
    // when the shield is off. Flushed once before send('done').
    const _streamUntok = _dlpActive
        ? require('../../../core/dlp/untokeniseStream').createUntokeniser(() => require('../../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId))
        : null;

    let fullContent = '';
    let streamToolCalls = [];
    let streamThinkingParts = {};

    const streamCallback = (type, data) => {
        if (type === 'text') {
            const _safe = _streamUntok ? _streamUntok.push(data.text) : data.text;
            if (_safe) { fullContent += _safe; send('content', { text: _safe }); }
        } else if (type === 'thinking_start') {
            if (data.partId) {
                streamThinkingParts[data.partId] = { redacted: !!data.redacted };
                send('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
            }
        } else if (type === 'thinking') {
            send('thinking', { text: data.text, partId: data.partId });
        } else if (type === 'thinking_stop') {
            if (data.partId) {
                send('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
            }
        } else if (type === 'tool_use' || type === 'tool_call') {
            streamToolCalls.push({
                id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'function',
                function: {
                    name: data.name || data.function?.name,
                    arguments: typeof data.input !== 'undefined'
                        ? JSON.stringify(data.input || {})
                        : (data.function?.arguments || '{}'),
                },
            });
        } else if (type === 'done') {
            // Adapter signals end-of-stream with usage + stop_reason.
            // Track tokens for the termination monitor and remember the
            // last stop_reason so we can detect max_tokens truncations.
            _termPromptTokens += data?.prompt_tokens || 0;
            _termCompletionTokens += data?.completion_tokens || 0;
            _termLastStopReason = data?.stop_reason || data?.finish_reason || null;
        } else if (type === 'error') {
            send('error', data);
        }
    };

    while (toolCallRounds < MAX_TOOL_ROUNDS) {
        // No new tool round once the user is gone.
        if (isGone()) break;
        fullContent = '';
        streamToolCalls = [];
        streamThinkingParts = {};

        const streamOptions = {
            ...chatOptions,
            tools: webpageTools,
            toolChoice: 'auto',
        };

        // Final pre-LLM phase marker — only on the first round, so the UI
        // status placeholder fades out before the first token arrives.
        if (toolCallRounds === 0) {
            emitPhase(send, 'streaming_start', modelId);
        }

        try {
            await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);
        } catch (err) {
            log.error('[WebpageChat] Stream error:', err.message);
            terminationStore.logTermination({
                ..._terminationBase(),
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch((e) => bestEffort('routes/ai/webpageChat/toolLoop:runToolLoop#2', e));
            send('error', { error: `Chat error: ${err.message}` });
            break;
        }

        if (_termLastStopReason === 'max_tokens' || _termLastStopReason === 'length') {
            terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_tokens' }).catch((e) => bestEffort('routes/ai/webpageChat/toolLoop:runToolLoop#3', e));
        }

        if (streamToolCalls.length === 0) {
            // End of turn — validate what was generated and, on real
            // problems, feed them back for a single repair round
            // (BFSF-222). Stays bounded: one injection per turn, and the
            // repair round still counts against MAX_TOOL_ROUNDS.
            const repair = await maybeBuildValidationRepair();
            if (repair) {
                // A user turn, not a system message: the request has to
                // end on a user turn or Claude rejects it as prefill.
                const { validationRepairTurn } = require('../../../services/webpageValidation');
                messages.push(...validationRepairTurn(fullContent, repair));
                turn.validationRepairUsed = true;
                continue;
            }
            break;
        }

        messages.push({
            role: 'assistant',
            content: fullContent || null,
            tool_calls: streamToolCalls,
        });
        toolCallRounds++;
        const toolResults = await Promise.all(streamToolCalls.map(dispatchToolCall));
        messages.push(...toolResults);

        // Hand any screenshots taken this round to the (vision-capable) model
        // as a user message — so it can actually SEE the page and iterate.
        // image_url blocks are converted to the provider's native image format
        // by the adapter (Claude). Only populated when the model has vision.
        if (pendingVisionImages.length > 0) {
            messages.push({
                role: 'user',
                content: [
                    ...pendingVisionImages.map(url => ({ type: 'image_url', image_url: { url } })),
                    { type: 'text', text: 'Above is the screenshot you just captured. Review the layout, spacing, colour, contrast and alignment, and fix any visual problems before continuing.' },
                ],
            });
            pendingVisionImages.length = 0;
        }

        // Plan proposed — stop the loop. Then run one more streaming
        // round (no tools) so the model can deliver its natural-language
        // "I'll build the following…" message above the plan card.
        if (turn.planProposedThisTurn) {
            fullContent = '';
            streamToolCalls = [];
            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
            } catch (err) {
                log.error('[WebpageChat] Plan wrap-up stream error:', err.message);
                terminationStore.logTermination({
                    ..._terminationBase(),
                    termination_type: 'error',
                    ...sanitizeError(err),
                }).catch((e) => bestEffort('routes/ai/webpageChat/toolLoop:runToolLoop#4', e));
            }
            break;
        }
    }

    // Hit MAX_TOOL_ROUNDS with tool calls still pending — give the model
    // one chance to summarise without offering more tools.
    if (toolCallRounds >= MAX_TOOL_ROUNDS && streamToolCalls.length > 0) {
        terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_iterations' }).catch((e) => bestEffort('routes/ai/webpageChat/toolLoop:runToolLoop#5', e));
        try {
            await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
        } catch (err) {
            log.error('[WebpageChat] Final wrap-up stream error:', err.message);
            terminationStore.logTermination({
                ..._terminationBase(),
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch((e) => bestEffort('routes/ai/webpageChat/toolLoop:runToolLoop#6', e));
        }
    }

    return { _streamUntok, dirtySlots, touchedExtraPaths, liveFiles, preTurnFiles };
}

module.exports = { runToolLoop };
