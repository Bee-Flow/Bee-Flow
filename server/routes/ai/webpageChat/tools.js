/**
 * Webpage chat: the tools of one turn (routes/ai/webpageChat.js). The one
 * executor every tool call goes through (slot and extra-file edits, the
 * database, bridges, framework, sources, knowledge and web search,
 * screenshots, the plan proposal), behind the Privacy Shield's tool gate, and
 * the compaction of what the model reads back.
 */

'use strict';

const log = require('../../../telemetry/log');
const webpageStore = require('../../../stores/webpageStore');
const { executeWebpageDocTool } = require('../../../integrations/webpageDocTools');
const { executeProposeWebpagePlan } = require('../../../integrations/webpagePlanTool');
const { isFrameworkTool, executeFrameworkTool } = require('../../../integrations/webpageFramework');
const { executeMultiFileTool, isMultiFileTool } = require('../../../integrations/webpageMultiFileTools');
const { executeDbTool, isDbTool } = require('../../../integrations/webpageDbTools');
const { isAgentSearchTool } = require('../../../integrations/agentSearchTools');
const { isReadUrlTool } = require('../../../integrations/readUrlTools');
// read_url ships with AGENT_SEARCH_TOOLS and is handled as a web tool here.
/**
 * @param {string} name
 */
const isWebTool = (name) => isAgentSearchTool(name) || isReadUrlTool(name);
const { runAgentSearchWithEgress } = require('../../../integrations/agentSearchEgress');
const { executeScreenshotTool, isScreenshotTool } = require('../../../integrations/webpageScreenshotTools');
const { executeBridgeTool, isBridgeTool } = require('../../../integrations/webpageBridgeTools');
const { executeWebpageKBSearchTool } = require('../../../core/webpages/webpageKnowledgeSearch');
const { fallback } = require('../../../utils/bestEffort');

/**
 * @param {string | undefined} slot
 */
function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

/**
 * Strip bulky payloads from tool results before they re-enter the model's
 * message history. The frontend already received the full content via SSE
 * (webpage_doc_update / webpage_extra_update / tool_end), so re-shipping it
 * to the LLM doubles every tool round's prompt size for no benefit and
 * pushes long sessions over context limits faster.
 *
 * Mirrors directChat.js's compactToolResultForLLM but with the rules tuned
 * for the webpage tool surface (file/extra/db).
 */
function compactWebpageToolResult(toolResult) {
    if (typeof toolResult !== 'object' || toolResult === null) return toolResult;

    // Primary slot writes — the new content was streamed to the UI; the model
    // can ask for it back via webpage_file_read if it needs to re-check.
    if (toolResult._action === 'webpage_doc_update') {
        return {
            action: 'webpage_doc_update',
            file: toolResult.file,
            title: toolResult.title,
            message: toolResult.message || `${toolResult.file} updated.`,
        };
    }

    // Extra-file create/update — content already sent to the UI.
    if (toolResult._action === 'webpage_extra_update') {
        return {
            action: 'webpage_extra_update',
            path: toolResult.path,
            meta: toolResult.meta,
            message: toolResult.message || `${toolResult.path} updated.`,
        };
    }
    if (toolResult._action === 'webpage_extra_deleted') {
        return {
            action: 'webpage_extra_deleted',
            path: toolResult.path,
            message: toolResult.message || `${toolResult.path} deleted.`,
        };
    }

    // DB exec — already small; pass through but normalize the shape.
    if (toolResult._action === 'webpage_db_update') {
        return {
            action: 'webpage_db_update',
            multi: !!toolResult.multi,
            changes: toolResult.changes,
            lastInsertRowid: toolResult.lastInsertRowid,
            message: toolResult.message,
        };
    }

    // DB query — cap rows shipped back to the model (UI already has the full
    // payload via tool_end). 50 rows is plenty to summarize/reason over.
    if (Array.isArray(toolResult.rows) && toolResult.rows.length > 50) {
        return {
            ...toolResult,
            rows: toolResult.rows.slice(0, 50),
            truncatedForLlm: true,
            originalRowCount: toolResult.rows.length,
        };
    }

    return toolResult;
}

/**
 * @typedef {Object} CreateToolDispatcherArgs
 * @property {boolean} [planToolAvailable]
 * @property {string[]} kbIds
 */
/**
 * The executor of one turn. `turn` is the turn's shared state (./toolLoop.js):
 * the live slot files and what was written, read and touched, the framework as
 * of the latest round, whether a plan was proposed, and the screenshots queued
 * for a vision-capable model. Returns `dispatchToolCall(toolCall)`, which
 * resolves to the tool message the model reads.
 * @param {CreateToolDispatcherArgs} param0
 */
function createToolDispatcher({
    send, req, shieldGate, planToolAvailable, webpageId, userId, userOrgForTiers,
    kbIds, sources, modelSupportsVision, _dlpConvId,
}, turn) {
    const { liveFiles, dirtySlots, readSlots, touchedExtraPaths, pendingVisionImages } = turn;

    async function dispatchToolCall(toolCall) {
        const toolName = toolCall.function?.name || toolCall.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { fallback('routes/ai/webpageChat/tools:dispatchToolCall', e); /* tool arguments are not valid JSON, call the tool with none */ }

        // Restore DLP tokens before the tool runs, so a write-side tool gets
        // the real value instead of the `[email_1]` placeholder the model was
        // shown. Without this the token was written verbatim into
        // the page/file the tool edits. Search queries keep their tokens so no
        // PII reaches an external search provider — same carve-out as
        // ../directChat/toolExec.js, which this mirrors.
        if (!/^(agent_search|web_search|search|brave_search|browse_web)$/i.test(toolName || '')) {
            try {
                const _argMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId);
                if (_argMap && Object.keys(_argMap).length) {
                    toolArgs = require('../../../core/dlp/applyTokenMapToOutbound').untokeniseToolArgs(toolArgs, _argMap);
                }
            } catch (err) { fallback('routes/ai/webpageChat/tools:dispatchToolCall#2', err); /* best-effort: leave args tokenized on error */ }
        }

        log.info(`[WebpageChat] Tool: ${toolName}(${Object.keys(toolArgs || {}).join(', ')})`);
        send('tool_start', { name: toolName, args: toolArgs });

        // Privacy Shield tool block lists ("Outside tools" / "Own server"),
        // the check direct chat and the agent loop run: a call
        // whose arguments carry a forbidden category is never dispatched.
        const refusal = await shieldGate.refuse(toolName, toolArgs);
        if (refusal) {
            send('tool_end', { name: toolName, result: refusal.uiResult });
            return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: refusal.modelError }) };
        }

        let toolResult;
        if (toolName === 'propose_webpage_plan') {
            // Auto mode strips this tool from the toolset; if the AI
            // somehow still calls it, refuse and tell it to just edit.
            if (!planToolAvailable) {
                toolResult = { error: 'propose_webpage_plan is not available in Auto mode. Just make the edits directly using webpage_file_* / webpage_create_file / webpage_delete_file.' };
            } else {
                toolResult = executeProposeWebpagePlan(toolArgs);
                if (toolResult._action === 'webpage_plan_proposed') {
                    turn.planProposedThisTurn = true;
                    send('webpage_plan_proposed', {
                        planId: toolResult.planId,
                        plan: toolResult.plan,
                    });
                }
            }
        } else if (toolName.startsWith('webpage_file_')) {
            toolResult = executeWebpageDocTool(toolName, toolArgs, liveFiles, { readSlots });
            if (toolResult._action === 'webpage_doc_update') {
                const slot = toolResult.file;
                liveFiles[slot] = toolResult.content;
                dirtySlots.add(slot);
                send('webpage_doc_update', { file: slot, content: toolResult.content, title: toolResult.title });
            }
        } else if (isMultiFileTool(toolName)) {
            toolResult = await executeMultiFileTool(toolName, toolArgs, { webpageId, userId });
            if (toolResult?._action === 'webpage_extra_update') {
                touchedExtraPaths.add(toolResult.path);
                send('webpage_extra_update', { path: toolResult.path, meta: toolResult.meta });
            } else if (toolResult?._action === 'webpage_extra_deleted') {
                touchedExtraPaths.add(toolResult.path);
                send('webpage_extra_deleted', { path: toolResult.path });
            }
        } else if (isDbTool(toolName)) {
            toolResult = await executeDbTool(toolName, toolArgs, { webpageId, userId });
            if (toolResult?._action === 'webpage_db_update') {
                // Lets the file explorer refresh the data.db size badge and
                // the iframe hot-reload if the user wants it.
                send('webpage_db_update', {});
            }
        } else if (isBridgeTool(toolName)) {
            toolResult = await executeBridgeTool(toolName, toolArgs, { webpageId, userId, session: req.session });
        } else if (isFrameworkTool(toolName)) {
            toolResult = await executeFrameworkTool(toolName, toolArgs, { webpageId, userId });
            if (toolResult?._action === 'webpage_framework_changed') {
                turn.currentFramework = toolResult.framework;
                send('webpage_framework_changed', { framework: toolResult.framework });
            } else if (toolResult?._action === 'webpage_runtime_changed') {
                send('webpage_runtime_changed', { runtime: toolResult.runtime });
            }
        } else if (toolName === 'webpage_add_source') {
            try {
                const { ingestTextSource } = require('../../../agents/webpages/sourceIngestion');
                const sourceName = toolArgs.name || 'AI Research';
                const sourceContent = toolArgs.content || '';
                const sourceMeta = toolArgs.metadata || {};
                if (!sourceContent.trim()) {
                    toolResult = { error: 'Content is required to add a source.' };
                } else {
                    const source = await webpageStore.addSource({
                        webpageId, type: 'text', name: sourceName,
                        metadata: sourceMeta,
                        wordCount: sourceContent.split(/\s+/).length,
                    });
                    sources.push({ ...source, metadata: sourceMeta });
                    ingestTextSource(webpageId, source.id, userId, sourceContent, sourceName).catch(err => {
                        log.error(`[WebpageChat] Source ingestion failed:`, err.message);
                    });
                    send('webpage_source_added', {
                        source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta },
                    });
                    toolResult = {
                        success: true,
                        message: `Source "${sourceName}" added to the webpage.`,
                        sourceId: source.id,
                    };
                }
            } catch (err) {
                toolResult = { error: `Failed to add source: ${/** @type {Error} */ (err).message}` };
            }
        } else if (toolName === 'webpage_kb_search') {
            try {
                toolResult = await executeWebpageKBSearchTool(toolArgs, userId, kbIds);
            } catch (err) {
                toolResult = { error: `KB search failed: ${/** @type {Error} */ (err).message}` };
            }
        } else if (isWebTool(toolName)) {
            try {
                toolResult = await runAgentSearchWithEgress(toolName, toolArgs, {
                    source: 'webpage_chat',
                    ids: { organization_id: userOrgForTiers || null, user_id: userId || null, conversation_id: webpageId || null },
                });
            } catch (err) {
                toolResult = { error: `Search failed: ${/** @type {Error} */ (err).message}` };
            }
        } else if (isScreenshotTool(toolName)) {
            try {
                toolResult = await executeScreenshotTool(toolName, toolArgs, { webpageId, userId, modelSupportsVision });
                if (toolResult?._screenshotDataUrl) {
                    // Always show the user the screenshot (reuse the standard
                    // 'image' event → MessageItem renders msg.images).
                    const m = /^data:([^;]+);base64,(.+)$/s.exec(toolResult._screenshotDataUrl);
                    if (m) send('image', { data: m[2], mimeType: m[1], caption: `Screenshot · ${toolResult._screenshotViewport}` });
                    // Give the MODEL the image only if it can see images — as a
                    // user message injected after the tool results (below), since
                    // tool-result content must be a string for Mistral/OpenAI.
                    if (modelSupportsVision) pendingVisionImages.push(toolResult._screenshotDataUrl);
                }
            } catch (err) {
                toolResult = { content: `Screenshot failed: ${/** @type {Error} */ (err).message}` };
            }
        } else {
            toolResult = { error: `Unknown tool: ${toolName}` };
        }

        // The screenshot tool's result is a plain STRING (the diagnostics);
        // the base64 image never goes through tool_end or the tool message.
        const isScreenshotResult = toolResult && typeof toolResult === 'object' && toolResult._screenshotDataUrl;
        send('tool_end', { name: toolName, result: isScreenshotResult ? { message: 'Screenshot captured.' } : toolResult });

        // The full toolResult goes to the UI (SSE above). The compact
        // shape goes back to the model — strips file content the model
        // already wrote and over-large query rows so prompt size doesn't
        // balloon round-over-round.
        // What the model reads, with the categories this tool's class
        // forbids stripped out; the UI got the full result above.
        /**
         * @param {string} content
         */
        const forModel = (content) => shieldGate.forModel(content, toolName);
        if (isScreenshotResult) {
            return { role: 'tool', tool_call_id: toolCall.id, content: await forModel(String(toolResult.content || 'Screenshot captured.')) };
        }
        return {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: await forModel(typeof toolResult === 'string'
                ? toolResult
                : JSON.stringify(compactWebpageToolResult(toolResult))),
        };
    }

    return dispatchToolCall;
}

module.exports = { slotFilename, compactWebpageToolResult, createToolDispatcher };
