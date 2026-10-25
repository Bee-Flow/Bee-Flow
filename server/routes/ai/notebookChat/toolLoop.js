// @typecheck
/**
 * Notebook chat: the tool rounds of one turn (routes/ai/notebookChat.js).
 * The tool menu and options, the one executor every tool call goes through
 * (document writes, new sources, knowledge and web search), and the
 * multi-round streaming loop with its Privacy Shield gates.
 *
 * The document the turn edits lives in a `doc` state object, shared with the
 * end of the turn (./finalize.js):
 *   currentDocContent / currentDocMd  the model's view (token space)
 *   written                           a notebook_doc_* tool wrote this turn
 *   aiLastWrite / aiVersionDoc        the last applied AI edit (real values)
 *   persistAiDocWrite / aiContributors from agents/notebooks/aiDocWriter.js
 */

'use strict';

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const notebookStore = require('../../../stores/notebookStore');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { countWords } = require('../../../utils/text');
const { NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL, executeNotebookDocTool } = require('../../../integrations/notebookDocTools');
const { AGENT_SEARCH_TOOLS, isAgentSearchTool } = require('../../../integrations/agentSearchTools');
const { isReadUrlTool } = require('../../../integrations/readUrlTools');
// read_url ships with AGENT_SEARCH_TOOLS and is handled as a web tool here.
const isWebTool = (/** @type {string} */ name) => isAgentSearchTool(name) || isReadUrlTool(name);
const { runAgentSearchWithEgress } = require('../../../integrations/agentSearchEgress');
const { executeNotebookKBSearchTool, NOTEBOOK_KB_SEARCH_TOOL } = require('../../../core/kb/notebookKnowledgeSearch');
const { emitPhase } = require('../../../core/agentRuntime/phaseEvents');
const dlpRunner = require('../../../core/dlp/dlpRunner');
const { createUntokeniser } = require('../../../core/dlp/untokeniseStream');
const { applyTokenMapToMessages, untokeniseToolArgs } = require('../../../core/dlp/applyTokenMapToOutbound');
const { fallback } = require('../../../utils/bestEffort');

// What the model is told when a write is refused, in words it can pass on.
const VIEWER_WRITE_REFUSAL = 'This user can view this notebook but not change it, so the document and its sources were left as they are. Answer in the chat instead.';
const CONFLICT_REFUSAL = 'The document was changed by someone else while you were working, so your edit was NOT applied. It was kept in the version history as a proposal the user can compare and restore. Tell the user, and offer to redo the edit on the current text.';

/**
 * @typedef {(event: string, data: unknown) => void} Send
 * @typedef {ReturnType<typeof import('../../../stores/notebook/rowMappers').mapSourceRow>} Source
 * @typedef {Awaited<ReturnType<typeof import('../../../core/privacy/orgShield').resolveShieldFor>>} Shield
 * @typedef {{ name?: string, content?: string, metadata?: Record<string, unknown>, title?: string, find_text?: string,
 *   replace_text?: string, query?: string, top_k?: number, [key: string]: unknown }} ToolArgs
 */

/**
 * A viewer's turn gets the read tool only: offering a write the server
 * would refuse just teaches the model to promise changes it cannot make.
 * @param {{ canWrite: boolean, kbIds: string[], searchAvailable: boolean }} opts
 */
function buildToolList({ canWrite, kbIds, searchAvailable }) {
    /** @type {Array<{ type: string, function?: { name: string, description?: string, parameters?: object } }>} */
    const notebookTools = canWrite
        ? [...NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL]
        : NOTEBOOK_DOC_TOOLS.filter(t => t.function?.name === 'notebook_doc_read');

    // Add KB search tool so the AI can explicitly search notebook sources
    if (kbIds.length > 0) {
        notebookTools.push(NOTEBOOK_KB_SEARCH_TOOL);
    }

    // Add web search tools if available (searchAvailable computed earlier for system prompt)
    if (searchAvailable) {
        notebookTools.push(...AGENT_SEARCH_TOOLS);
    }
    return notebookTools;
}

/**
 * The provider options of every round, from the tier's settings.
 * @param {{ tiers: import('../../../core/llm/modelResolver').TierMap, resolvedTier: string, requestedEffort?: string }} opts
 */
function buildChatOptions({ tiers, resolvedTier, requestedEffort }) {
    const tierSettings = tiers[resolvedTier] || {};
    const { TIER_DEFAULTS } = require('../../../core/llm/modelResolver');
    const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
    const chatOptions = {
        maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
        temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        // Pass an explicit reasoning effort. Without it, Claude 4.x adaptive
        // thinking defaults to 'medium' and can burn the entire (fast-tier,
        // 4096-token) budget on thinking, ending the stream with EMPTY content
        // and no document edit — the "stuck in reasoning" symptom (BFSF-177).
        reasoningEffort: requestedEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || 'low',
    };
    // Give thinking + answer headroom so a low tier doesn't share a tiny pot.
    if (chatOptions.reasoningEffort && chatOptions.reasoningEffort !== 'none') {
        chatOptions.maxTokens = Math.max(chatOptions.maxTokens || 0, 8192);
    }
    return chatOptions;
}

/**
 * Single tool executor — used for every tool the model calls, in every
 * round. Performs side-effects (doc update, source added, legal citation
 * feed-through) and returns the result object handed back to the model.
 * @param {{ doc: import('./finalize').TurnDoc, canWrite: boolean, aborted: () => boolean, notebook: import('./finalize').Notebook,
 *   notebookId: string, userId: string, userOrgForTiers: string | null, sources: Partial<Source>[], kbIds: string[],
 *   readySources: Source[], send: Send, seams: import('./finalize').Seams }} turn
 */
function makeNotebookToolExecutor({ doc, canWrite, aborted, notebook, notebookId, userId, userOrgForTiers, sources, kbIds, readySources, send, seams }) {
    return async (/** @type {string} */ toolName, /** @type {ToolArgs} */ toolArgs) => {
        if (toolName.startsWith('notebook_doc_')) {
            const r = executeNotebookDocTool(toolName, toolArgs, doc.currentDocContent, doc.currentDocMd);
            if (r && r._action === 'notebook_doc_update') {
                // Refused BEFORE anything is snapshotted, persisted or sent:
                // a viewer's editor must never show text that was not saved.
                if (!canWrite) {
                    log.info(`[NotebookChat] refused an AI document write for a viewer of ${notebookId}`);
                    return { error: VIEWER_WRITE_REFUSAL };
                }
                // Restore tokens → real values BEFORE persisting + displaying.
                // The editor is the user's work product and must never store or
                // show `[person_1]` (the doc-side analogue of untokeniseToolArgs
                // for write tools). The conv map holds the doc/source/chat tokens.
                // Rich-text restore: the document is HTML/Markdown, so a token
                // typed in italic/bold can be split by inline markup or have its
                // brackets/underscore escaped — restoreTokensInRichText tolerates
                // that, where plain restoreTokens would leave `[person_1]` raw.
                const { restoreTokensInRichText } = require('../../../core/privacy/piiDetection');
                const _docMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                const realHtml = restoreTokensInRichText(r.content, _docMap);
                const realMd = r.contentMd != null ? restoreTokensInRichText(r.contentMd, _docMap) : null;
                // Refuse to persist a document rewrite for a turn the user
                // cancelled. The write is the one irreversible side effect
                // in this loop, so it gets the last-moment check.
                if (aborted()) {
                    log.info(`[NotebookChat] turn aborted — discarding AI doc write for ${notebookId}`);
                    return { ...r, _aborted: true };
                }
                // PERSIST the AI's edit (an AI-written document used to live
                // only in the browser editor and was lost on refresh), but
                // only over the version the page had: never blindly over a
                // newer save by the user or a colleague.
                let saved;
                try {
                    saved = await doc.persistAiDocWrite(realHtml, realMd);
                } catch (e) {
                    log.error('[NotebookChat] AI doc persist failed:', e.message);
                    saved = { ok: false };
                }
                if (saved.conflict) return { error: CONFLICT_REFUSAL };
                if (!saved.ok) {
                    log.warn(`[NotebookChat] AI doc write not persisted for notebook ${notebookId}`);
                    return { error: 'The edit could not be saved, so the document was left as it was. Tell the user and suggest trying again.' };
                }
                doc.written = true;
                // Keep the in-memory mirror in TOKEN-space so a chained
                // notebook_doc_read/replace later in the same turn keeps matching
                // the tokenized text the model saw.
                doc.currentDocContent = r.content;
                if (r.contentMd != null) doc.currentDocMd = r.contentMd;
                doc.aiLastWrite = { html: realHtml, markdown: realMd };
                doc.aiVersionDoc = saved.html ? { html: saved.html, markdown: null } : doc.aiLastWrite;
                // Client applies real HTML; the real Markdown mirror is persisted
                // alongside so a later notebook GET serves real values directly.
                // While co-editing the page's editor follows the live document and
                // ignores this; `version` is omitted then (the engine owns it).
                send('notebook_doc_update', { content: realHtml, title: r.title, ...(saved.version != null ? { version: saved.version } : {}) });
            }
            return r;
        }
        if (toolName === 'notebook_add_source') {
            if (!canWrite) return { error: VIEWER_WRITE_REFUSAL };
            const { ingestTextSource, MAX_SOURCE_TEXT_CHARS, MAX_SOURCES_PER_NOTEBOOK } = require('../../../agents/notebooks/sourceIngestion');
            const sourceName = toolArgs.name || 'AI Research';
            // The model may echo tokens (`[person_1]`) in the content it asks us
            // to save as a new source. Restore to real values before ingest so the
            // stored source + its embeddings hold real text (sources are stored
            // raw/real; tokenization happens at query-time in step B4).
            const { restoreTokens } = require('../../../core/privacy/piiDetection');
            const _srcMap = dlpRunner.getConversationTokenMap(notebookId) || {};
            const sourceContent = restoreTokens(toolArgs.content || '', _srcMap);
            const sourceMeta = toolArgs.metadata || {};
            if (!sourceContent.trim()) return { error: 'Content is required to add a source.' };
            if (sourceContent.length > MAX_SOURCE_TEXT_CHARS) return { error: `That text is too long to add as one source (over ${MAX_SOURCE_TEXT_CHARS.toLocaleString('en-US')} characters). Add it in smaller parts.` };
            if (await notebookStore.countSources(notebookId) >= MAX_SOURCES_PER_NOTEBOOK) return { error: `This notebook already holds the maximum of ${MAX_SOURCES_PER_NOTEBOOK} sources. Ask the user to remove some first.` };
            const source = await notebookStore.addSource({
                notebookId, type: 'text', name: sourceName, metadata: sourceMeta,
                wordCount: countWords(sourceContent),
            });
            sources.push({ ...source, metadata: sourceMeta });
            ingestTextSource(notebookId, source.id, userId, sourceContent, sourceName)
                .catch(err => log.error('[NotebookChat] Source ingestion failed:', err.message));
            send('notebook_source_added', { source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta } });
            void seams.feed().sourcesAdded({ projectId: notebook.projectId, notebookId, actorId: userId });
            return { success: true, message: `Source "${sourceName}" added and indexing.`, sourceId: source.id };
        }
        if (toolName === 'notebook_kb_search') {
            return await executeNotebookKBSearchTool(toolArgs, notebook.userId, kbIds, readySources);
        }
        if (isWebTool(toolName)) {
            return await runAgentSearchWithEgress(toolName, toolArgs, {
                source: 'notebook_chat',
                ids: { organization_id: userOrgForTiers || null, user_id: userId || null, conversation_id: notebookId || null },
            });
        }
        return { error: `Unknown tool: ${toolName}` };
    };
}

/**
 * Multi-round streaming agentic loop (mirrors direct chat).
 * Every round streams content + reasoning + tool calls; tools stay
 * enabled across rounds so the model can chain (search → get → verify →
 * draft), all streamed, with tool_start/tool_end events the shared chat
 * renderer already understands. Fixes the previous one-shot truncation.
 * @param {{ messages: import('../../../utils/messageUtils').WireMessage[], notebookTools: ReturnType<typeof buildToolList>,
 *   chatOptions: ReturnType<typeof buildChatOptions>,
 *   executeNotebookTool: ReturnType<typeof makeNotebookToolExecutor>,
 *   repeatGuard: ReturnType<typeof import('../../../core/agentRuntime/toolRepeatGuard').createToolRepeatGuard>,
 *   toolPiiGate: typeof import('../../../core/privacy/toolPiiGate'), adapter: import('../../../core/providers/base'),
 *   apiKey: string, apiUrl: string, modelId: string, turnSignal: AbortSignal, aborted: () => boolean, send: Send,
 *   notebookId: string, userId: string, userOrgForTiers: string | null, docShield: Shield, orgShieldConfig: Shield }} turn
 * @returns {Promise<{ fullContent: string, _untok: import('./finalize').Untokeniser }>}
 */
async function runToolLoop({
    messages, notebookTools, chatOptions, executeNotebookTool, repeatGuard, toolPiiGate,
    adapter, apiKey, apiUrl, modelId, turnSignal, aborted, send,
    notebookId, userId, userOrgForTiers, docShield, orgShieldConfig,
}) {
    const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 15;
    // The tool block lists, with this turn's attribution on their audit rows.
    const shieldGate = toolPiiGate.toolLoopGate({
        shield: orgShieldConfig, tag: 'NotebookChat',
        audit: (/** @type {object} */ fields) => guardrailEventStore.logGuardrailEvent({
            organization_id: userOrgForTiers || null, user_id: userId || null, conversation_id: notebookId || null,
            ...fields, source: 'notebook', model: modelId || null,
        }),
    });
    let fullContent = '';
    emitPhase(send, 'streaming_start', modelId);

    // Un-tokenise the streamed answer for DISPLAY (Model 1): the model emits
    // tokens (it's instructed to preserve them); the user must only ever see
    // real values. LIVE getter so tokens minted mid-turn (doc/KB/tool scans)
    // are picked up. Storage (`fullContent`) stays tokenized — it is restored
    // on reload via the persisted map (see GET /:id/conversation). Mirrors
    // directChat.js. Spans the whole turn; flushed once after the loop.
    const _untok = createUntokeniser(() => dlpRunner.getConversationTokenMap(notebookId));

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        // Don't start another provider call / tool round for a dead client.
        if (aborted()) { log.info('[NotebookChat] turn aborted — stopping tool loop'); break; }
        const isFinalRound = round === MAX_TOOL_ROUNDS;
        let roundText = '';
        /** @type {Array<{ id: string, type: string, function: { name: string, arguments: string }, name?: string }>} */
        const roundToolCalls = [];
        /**
         * @param {string} type
         * @param {{ text?: string, id?: string, name?: string, input?: unknown, [key: string]: unknown }} data
         */
        const streamCallback = (type, data) => {
            if (type === 'text') {
                // Accumulate tokenized text for storage; stream un-tokenised text
                // (buffered so a token split across SSE chunks isn't shown raw).
                roundText += data.text; fullContent += data.text;
                const safe = _untok.push(data.text);
                if (safe) send('content', { text: safe });
            }
            else if (type === 'thinking') send('thinking', { text: _untok.restore(data.text) });
            else if (type === 'thinking_start') send('thinking_start', data || {});
            else if (type === 'thinking_stop') send('thinking_stop', data || {});
            else if (type === 'tool_use') {
                roundToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    type: 'function',
                    function: { name: data.name, arguments: JSON.stringify(data.input || {}) },
                });
            } else if (type === 'error') send('error', data);
        };

        const streamOptions = {
            ...chatOptions,
            // The turn already aborts on disconnect; the signal has to
            // reach the adapter too, or the request to the model keeps
            // generating after the user pressed stop.
            signal: turnSignal,
            // Tools stay enabled every round except a final safety round,
            // which forces a textual answer if the model hits the cap.
            tools: isFinalRound ? undefined : notebookTools,
            toolChoice: isFinalRound ? undefined : 'auto',
        };

        try {
            // Re-tokenise known real values across the WHOLE outbound payload
            // (client-sent history goes raw otherwise — only the last user msg
            // was tokenized) so no real PII reaches the provider. Returns a new
            // array; the canonical `messages` (mutated across rounds) is unchanged.
            const outboundMessages = applyTokenMapToMessages({ conversationId: notebookId, messages });
            await adapter.stream(apiKey, apiUrl, modelId, outboundMessages, streamOptions, streamCallback);
        } catch (err) {
            log.error('[NotebookChat] Stream error:', err.message);
            send('error', { error: err.message });
            break;
        }

        if (roundToolCalls.length === 0) break; // model produced its final answer

        // Record the assistant turn (preamble + tool calls), run the tools
        // with tool_start/tool_end, feed results back, and loop.
        messages.push({ role: 'assistant', content: roundText || null, tool_calls: roundToolCalls });
        // Run the round's tools SEQUENTIALLY, not via Promise.all. The
        // notebook_doc_* tools mutate shared closure state (currentDocContent /
        // currentDocMd) and persist to the DB; running them concurrently lets a
        // notebook_doc_read batched alongside a notebook_doc_write observe the
        // document before the write commits, so the agent "can't read what it
        // just wrote" (BFSF-234). Sequential execution makes each tool see the
        // committed result of the previous one. Order is preserved, so the
        // tool_call_id ↔ result mapping the model expects is unchanged.
        const toolResults = [];
        for (const toolCall of roundToolCalls) {
            const toolName = toolCall.function?.name || toolCall.name;
            let toolArgs = {};
            try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (_) { fallback('routes/ai/notebookChat/toolLoop:runToolLoop', _); /* tool arguments are not valid JSON, call the tool with none */ }
            // The model passes tokens in tool args (e.g. find_text). Restore for
            // the CLIENT-facing tool_start/tool_end previews only — the model-facing
            // result fed back below stays tokenized (token-space consistency).
            // _restoreView reads the LIVE map so tokens minted by this turn's
            // tool-result scan (below) are restored in the client preview too.
            const { restoreTokens: _rt } = require('../../../core/privacy/piiDetection');
            /** @param {string} s */
            const _restoreView = (s) => {
                const m = dlpRunner.getConversationTokenMap(notebookId) || {};
                return (Object.keys(m).length && typeof s === 'string') ? _rt(s, m) : s;
            };
            send('tool_start', { name: toolName, args: untokeniseToolArgs(toolArgs, dlpRunner.getConversationTokenMap(notebookId) || {}) });
            // Privacy Shield tool block lists (BFSF-354), on the values the
            // call carries: real ones for every tool the notebook restores
            // (document writes, new sources), the tokens a web search keeps.
            // The same split direct chat makes.
            const refusal = await shieldGate.refuse(toolName, isWebTool(toolName)
                ? toolArgs : untokeniseToolArgs(toolArgs, dlpRunner.getConversationTokenMap(notebookId) || {}));
            if (refusal) {
                send('tool_end', { name: toolName, result: refusal.uiResult });
                toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: refusal.modelError }) });
                continue;
            }
            let toolResult;
            let skipScan = false;
            if (repeatGuard.isRepeat(toolName, toolArgs)) {
                // Same read, same arguments, earlier in this answer: not run again.
                toolResult = { message: 'Already retrieved earlier in this answer — use that result instead of calling again.' };
                skipScan = true;
            } else {
                try { toolResult = await executeNotebookTool(toolName, toolArgs); }
                catch (err) { toolResult = { error: err.message }; }
                if (toolName === 'notebook_doc_write' || toolName === 'notebook_doc_replace') repeatGuard.forget('notebook_doc_read');
                if (toolName === 'notebook_kb_search' && Array.isArray(toolResult?.results)) {
                    const fresh = repeatGuard.filterNewChunks(toolResult.results);
                    if (toolResult.results.length > 0 && fresh.length === 0) {
                        toolResult = { message: 'No new passages beyond those already retrieved.' };
                        skipScan = true;
                    } else {
                        toolResult = { ...toolResult, results: fresh, resultCount: fresh.length };
                    }
                }
            }
            let resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            // Tokenize source/web content returned by RETRIEVAL tools before the
            // model sees it — Legal/Notebook SOURCES (notebook_kb_search) and web
            // results would otherwise reach the LLM raw. Exclude notebook_doc_*
            // (already token-space, B3) and the Dutch legal tools (public court
            // data whose exact ECLI/CELEX identifiers citation-matching needs).
            // A KB result is left alone when the org switched off knowledge-base
            // scanning; web results are always scanned.
            const _scanKbResult = toolName === 'notebook_kb_search' && docShield?.privacy_scan_knowledge_bases !== false;
            if (!skipScan && docShield?.enabled && resultStr && (_scanKbResult || isWebTool(toolName))) {
                try {
                    const { scanAttachmentText } = require('../../../core/dlp/attachmentScanner');
                    const r = await scanAttachmentText({ text: resultStr, filename: `${toolName}-result`, orgShield: docShield, conversationId: notebookId });
                    if (r && typeof r.text === 'string') resultStr = r.text;
                } catch (e) { log.warn('[NotebookChat] tool-result PII scan failed:', e.message); }
            }
            send('tool_end', { name: toolName, result: _restoreView(resultStr).slice(0, 800) });
            // What the model reads, with the categories this tool's class
            // forbids stripped out (BFSF-354).
            toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: await shieldGate.forModel(resultStr, toolName) });
        }
        messages.push(...toolResults);
    }
    return { fullContent, _untok };
}

module.exports = {
    VIEWER_WRITE_REFUSAL, CONFLICT_REFUSAL,
    buildToolList, buildChatOptions, makeNotebookToolExecutor, runToolLoop,
};
