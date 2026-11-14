// @typecheck strict
/**
 * Direct Chat: the steps of one tool call (usecases/ai/directChat/toolExec.js runs them in order
 * and keeps every guard's place): the DLP token restore, the notebook-write
 * gate, the web-search guard (regex rules, then the PII scan), the tool
 * itself by kind, and the activity row.
 *
 * `streamed` only changes the wording of log lines: the pre-check round and
 * the streamed round say which one they are.
 */

const { checkRegexPatterns } = require('../../../core/privacy/guardrails');
const toolDisclosure = require('../../../core/tools/toolDisclosure');
const { executeTool: dispatchTool } = require('../../../core/tools/toolDispatcher');
const { runWithProbe, markLocal } = require('../../../core/http/outboundProbe');
const { resolveIntegration: resolveIntegrationMeta } = require('../../../core/integrations/integrationToolMap');
const { isBuilderTool, executeBuilderTool } = require('../../../integrations/webpageBuilderTools');
const { isDocumentTool, executeDocumentTool } = require('../../../integrations/documentBuilderTools');
const { isDbTool, executeDbTool } = require('../../../integrations/webpageDbTools');
const { executeProposeWebpagePlan } = require('../../../integrations/webpagePlanTool');
const { untokeniseToolArgs } = require('../../../core/dlp/applyTokenMapToOutbound');
const { isNotebookWriteTool } = require('./notebookWriteGate');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const log = require('../../../telemetry/log');
const { searchGuardText, searchGuardEvent, buildDispatchOptions, buildEgressArgs } = require('./toolExecPayloads');
const { fallback, bestEffort } = require('../../../utils/bestEffort');

/**
 * @typedef {import('./toolExec').ToolCtx} ToolCtx
 * @typedef {import('./toolExec').ToolCall} ToolCall
 * @typedef {import('./toolExec').ToolResult} ToolResult
 * @typedef {{ [arg: string]: any }} ToolArgs  the model's arguments for one call (untrusted JSON)
 * @typedef {{ role: 'tool', tool_call_id: string | undefined, content: string }} ToolMessage
 * What running the tool came to: the result (a thrown dispatch becomes an
 * error result), the outbound probe of a dispatched call, and the error the
 * activity row carries.
 * @typedef {{ [field: string]: any }} ToolAnswer  what a tool handed back, as its callers read it (an object; a few tools hand back text or nothing)
 * @typedef {{ toolResult: ToolAnswer, outboundProbe: object | null, toolError: unknown }} Ran
 */

// A search keeps its DLP tokens: the query (or the address of a page read)
// leaves Bee Flow, so the real value is not restored into it.
// nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored alternation of fixed names, no repetition: linear
const KEEPS_TOKENS = /^(agent_search|web_search|search|brave_search|browse_web|read_url)$/i;

/**
 * Restores the conversation's DLP tokens in the arguments of a tool that is
 * not a search, so write-side tools (docs, sheets, mail, calendar) get the
 * real value and not the [email_1] placeholder. Best-effort.
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {string | null | undefined} convId
 * @returns {ToolArgs}
 */
function restoreDlpTokens(toolName, toolArgs, convId) {
    if (KEEPS_TOKENS.test(toolName || '')) return toolArgs; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- KEEPS_TOKENS is an anchored list of tool names
    try {
        const _argMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(convId);
        if (_argMap && Object.keys(_argMap).length) return untokeniseToolArgs(toolArgs, _argMap);
    } catch (err) { fallback('usecases/ai/directChat/toolExec:executeDirectChatToolCall#2', err); /* best-effort */ }
    return toolArgs;
}

/**
 * The notebook-write gate: a notebook write the user did not ask for is
 * answered here, not by removing the tools from the turn's tool list, so
 * the tool list (and with it the provider's cached prompt prefix) stays
 * stable across the conversation. See ./notebookWriteGate.js.
 * @param {ToolCall} toolCall
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 * @returns {ToolMessage | null}
 */
function notebookWriteRefusal(toolCall, toolName, toolArgs, ctx) {
    const _nbGate = ctx.notebookWriteGate;
    if (!(_nbGate && _nbGate.allowed === false && isNotebookWriteTool(toolName))) return null;
    log.info(`[DirectChat] ${toolName} rejected by notebook-write gate`);
    ctx.send('tool_start', { name: toolName, args: toolArgs });
    ctx.send('tool_end', { name: toolName, result: '[Notebook write skipped — not requested]' });
    return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: _nbGate.reason }) };
}

/**
 * The regex guardrails on a search query: a match blocks the search and
 * leaves an audit row.
 * @param {ToolCall} toolCall
 * @param {string} toolName
 * @param {string} guardText
 * @param {ToolCtx} ctx
 * @param {boolean} streamed
 * @returns {ToolMessage | null}
 */
function regexSearchRefusal(toolCall, toolName, guardText, ctx, streamed) {
    if (!ctx.regexConfig?.enabled) return null;
    const qMatches = checkRegexPatterns(guardText, ctx.regexConfig.rulesWithNames);
    if (!(qMatches.length > 0)) return null;
    const ruleNames = qMatches.map((/** @type {{ ruleName: string }} */ m) => m.ruleName).join(', ');
    log.info(`[DirectChat WebSearchGuard] ${streamed ? 'Streamed search' : 'Search'} query BLOCKED by regex: ${ruleNames}`);
    guardrailEventStore.logGuardrailEvent(
        searchGuardEvent(ctx, 'regex', ruleNames, 'search_blocked'),
    ).catch((/** @type {unknown} */ e) => bestEffort('usecases/ai/directChat/toolExec:executeDirectChatToolCall#3', e));
    ctx.send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
    return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
}

/**
 * The PII scan of a search query. A hit is always logged for monitoring; it
 * blocks the search only when the Web Search Guard is on. A scan that fails
 * lets the search through (fail-open).
 * @param {ToolCall} toolCall
 * @param {string} toolName
 * @param {string} guardText
 * @param {ToolCtx} ctx
 * @param {boolean} streamed
 * @returns {Promise<ToolMessage | null>}
 */
async function piiSearchRefusal(toolCall, toolName, guardText, ctx, streamed) {
    try {
        const { detectPii } = require('../../../core/privacy/piiDetection');
        const piiResult = await detectPii(guardText, ctx.webSearchGuardPiiCategories);
        if (piiResult?.hasPii) {
            const cats = [...new Set(piiResult.entities.map((/** @type {{ label: string }} */ e) => e.label))].join(', ');
            guardrailEventStore.logGuardrailEvent(
                searchGuardEvent(ctx, 'pii', cats, ctx.webSearchGuardEnabled ? 'search_blocked' : 'pii_detected'),
            ).catch((/** @type {unknown} */ e) => bestEffort('usecases/ai/directChat/toolExec:executeDirectChatToolCall#4', e));
            if (ctx.webSearchGuardEnabled) {
                log.info(`[DirectChat WebSearchGuard] ${streamed ? 'Streamed search' : 'Search'} query BLOCKED by PII (${cats})`);
                ctx.send('tool_end', { name: toolName, result: `[Web search blocked — query contains sensitive information (${cats})]` });
                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: `Web search blocked — query contains sensitive personal information (${cats}). Please rephrase without PII.` }) };
            }
            log.info(`[DirectChat WebSearchGuard] PII detected in ${streamed ? 'streamed ' : ''}search query (${cats}) — monitoring only, search allowed`);
        }
        log.info(`[DirectChat WebSearchGuard] ${streamed ? 'Streamed search' : 'Search'} query PII check passed`);
    } catch (piiErr) {
        log.warn(`[DirectChat WebSearchGuard] PII check failed (fail-open):`, /** @type {Error} */ (piiErr).message);
    }
    return null;
}

/**
 * The Web Search Guard: a search query, or what a page read sends out (its
 * address and find text leave Bee Flow the same way a query does), is held
 * to the regex rules and then scanned for PII. The refusal the model reads,
 * or null (a promise of one when the scan runs) when the call may go ahead.
 * @param {ToolCall} toolCall
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 * @param {boolean} streamed
 * @returns {ToolMessage | null | Promise<ToolMessage | null>}
 */
function searchGuardRefusal(toolCall, toolName, toolArgs, ctx, streamed) {
    const _guardText = searchGuardText(toolName, toolArgs);
    if (!_guardText) return null;
    const blocked = regexSearchRefusal(toolCall, toolName, _guardText, ctx, streamed);
    if (blocked) return blocked;
    if (!(ctx.webSearchGuardPiiCategories && ctx.webSearchGuardPiiCategories.length > 0)) return null;
    return piiSearchRefusal(toolCall, toolName, _guardText, ctx, streamed);
}

/** @param {unknown} toolResult @returns {Ran} */
const ran = (toolResult) => ({ toolResult: /** @type {ToolAnswer} */ (toolResult), outboundProbe: null, toolError: null });

/**
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 */
function proposeWebpagePlan(toolArgs, ctx) {
    const toolResult = executeProposeWebpagePlan(toolArgs);
    if (toolResult._action === 'webpage_plan_proposed') {
        ctx.markWebpagePlanProposed();
        ctx.send('webpage_plan_proposed', {
            planId: toolResult.planId,
            plan: toolResult.plan,
        });
    }
    return toolResult;
}

/**
 * A document tool. Proposed changes to a page show as suggestions in the
 * open editor, which does not reload (nothing was written): ids and a count
 * only. A tool that WROTE tells the open Documents editor to reload, since
 * the user may be looking at this very document; a read does not, or the
 * reader's caret and scroll position would be thrown away for nothing.
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 */
async function runDocumentTool(toolName, toolArgs, ctx) {
    // orgId decides which letterhead a new document is handed.
    const toolResult = await executeDocumentTool(toolName, toolArgs, { userId: ctx.userId, orgId: ctx.userOrgId || null, conversationId: /** @type {string | undefined} */ (/** @type {unknown} */ (ctx.convId || null)), documentScope: ctx.documentScope });
    if (toolResult && toolResult.suggested > 0 && toolResult.batchId && !toolResult.error) {
        ctx.send('document_suggestions', { documentId: toolResult.documentId, batchId: toolResult.batchId, count: toolResult.suggested });
    }
    if (toolName !== 'document_read' && toolResult && toolResult.documentId && !toolResult.error && !toolResult.batchId) {
        ctx.send('document_update', {
            documentId: toolResult.documentId,
            name: toolResult.name,
            url: toolResult.url,
        });
    }
    return toolResult;
}

/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 */
async function runWebpageBuilderTool(toolName, toolArgs, ctx) {
    const builderOut = await executeBuilderTool(toolName, toolArgs, { userId: ctx.userId, readSlots: ctx.webpageBuilderReadSlots });
    if (builderOut.webpageUpdate) {
        const { webpageId, file, content, title } = builderOut.webpageUpdate;
        ctx.send('webpage_doc_update', { webpageId, file, content, title });
    }
    return builderOut.result;
}

/**
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 */
async function runWebpageDbTool(toolName, toolArgs, ctx) {
    const dbWebpageId = toolArgs?.webpageId;
    if (!dbWebpageId) return { error: 'webpageId is required — pass the id returned by create_webpage.' };
    const { webpageId: _wp, ...dbArgs } = toolArgs || {};
    const toolResult = /** @type {ToolResult | undefined} */ (await executeDbTool(toolName, dbArgs, { webpageId: dbWebpageId, userId: ctx.userId }));
    if (toolResult?._action === 'webpage_db_update') {
        ctx.send('webpage_db_update', { webpageId: dbWebpageId });
    }
    return toolResult;
}

/**
 * Every other tool goes through the dispatcher, under the outbound probe.
 * The inner function never throws THROUGH runWithProbe: a throw would
 * discard the probe (peer IP, TLS name, the markLocal flag), exactly the
 * audit fields a failed call whose bytes already left the box needs. Same
 * wrap as chatStream/engine.
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 * @param {Record<string, unknown> | null} tierOverrides
 * @param {boolean} streamed
 * @returns {Promise<Ran>}
 */
async function dispatchUnderProbe(toolName, toolArgs, ctx, tierOverrides, streamed) {
    const dispatched = await runWithProbe(async () => {
        const preMeta = resolveIntegrationMeta(toolName, toolArgs || {});
        if (preMeta?.isLocal) markLocal(preMeta.label || preMeta.integration);
        try {
            return { ok: true, value: await dispatchTool(toolName, toolArgs, buildDispatchOptions(ctx, tierOverrides)) };
        } catch (err) {
            return { ok: false, error: err };
        }
    });
    if (dispatched.result?.ok) return { toolResult: /** @type {ToolAnswer} */ (dispatched.result.value), outboundProbe: dispatched.probe, toolError: null };
    const err = dispatched.result?.error || new Error('tool dispatch failed');
    log.error(`[DirectChat] ${streamed ? 'Streamed tool' : 'Tool'} execution failed for ${toolName}:`, err);
    return { toolResult: { error: err.message }, outboundProbe: dispatched.probe, toolError: err };
}

/**
 * Runs the tool by its kind: tool loading, the webpage plan, a document
 * tool, a webpage builder or database tool, else the dispatcher. A kind
 * that answers without waiting answers synchronously.
 * @param {string} toolName
 * @param {ToolArgs} toolArgs
 * @param {ToolCtx} ctx
 * @param {Record<string, unknown> | null} tierOverrides
 * @param {boolean} streamed
 * @returns {Ran | Promise<Ran>}
 */
function runTool(toolName, toolArgs, ctx, tierOverrides, streamed) {
    if (toolName === toolDisclosure.LOAD_TOOLS_TOOL_NAME) return ran(ctx.applyLoadTools(toolArgs));
    if (toolName === 'propose_webpage_plan') return ran(proposeWebpagePlan(toolArgs, ctx));
    if (isDocumentTool(toolName)) return runDocumentTool(toolName, toolArgs, ctx).then(ran);
    if (isBuilderTool(toolName)) return runWebpageBuilderTool(toolName, toolArgs, ctx).then(ran);
    if (isDbTool(toolName)) return runWebpageDbTool(toolName, toolArgs, ctx).then(ran);
    return dispatchUnderProbe(toolName, toolArgs, ctx, tierOverrides, streamed);
}

/**
 * The integration activity row, through the one shared write path
 * (core/integrations/integrationLogging.js): the minimal metadata row is
 * ALWAYS written; the org's monitorIntegrations toggle only gates the PII
 * content scan. A thrown dispatch reaches here too: `toolError` marks the
 * row's status 'error'. Not waited for, and never fails the call.
 * @param {ToolCtx} ctx
 * @param {Parameters<typeof buildEgressArgs>[1]} call
 */
function logEgress(ctx, call) {
    try {
        const { logToolEgress } = require('../../../core/integrations/integrationLogging');
        logToolEgress(buildEgressArgs(ctx, call));
    } catch (e) { bestEffort('usecases/ai/directChat/toolExec:executeDirectChatToolCall#6', e); /* ignore */ }
}

module.exports = { restoreDlpTokens, notebookWriteRefusal, searchGuardRefusal, runTool, logEgress };
