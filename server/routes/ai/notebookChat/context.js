/**
 * Notebook chat: what one turn puts in front of the model besides the
 * conversation (routes/ai/notebookChat.js): the knowledge-base passages and
 * their citations, the document within its token budget, the editor
 * selection, the source summary and the system prompt around them.
 *
 * A step that returns STOP has answered the client and ended the response.
 */

'use strict';

const { formatLocalNow } = require('../../../core/llm/clock');
const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const dlpRunner = require('../../../core/dlp/dlpRunner');
const { htmlToMarkdown } = require('../../../core/markdown');
const { searchNotebookKB, findSourceForChunk } = require('../../../core/kb/notebookKnowledgeSearch');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
// The KB search path below applies no tenant filtering — the kb id list is the
// access boundary — so ids read off the notebook row are re-authorized here:
// the notebook's own base by notebook role, any other by the caller's own access.
const { partitionNotebookKbIds } = require('../../../agents/notebooks/notebookKbAccess');
const { STOP } = require('./privacyScans');

/**
 * Search the notebook knowledge base for relevant context, scan it, and send
 * the citation sources to the client.
 * @returns {Promise<typeof STOP | { kbIds: string[], kbContext: string }>}
 */
async function retrieveKbContext({ req, notebook, userId, message, readySources, send, notebookId, docShield, orgShieldConfig, toolPiiGate, repeatGuard, scans }) {
    const { _failClosed, _abortFailClosed, _scanViaLedger, _abortBlocked } = scans;
    let kbContext = '';
    let citationSources = [];
    // Re-authorize at read time: rows written before kb ids were validated
    // on update may still carry an id this user can't access, and the search
    // path below does no tenant filtering of its own. Silently drop rather
    // than fail the turn — the notebook still answers from what it may use.
    let kbIds = notebook.knowledgeBaseIds || [];
    if (kbIds.length > 0) {
        const { allowed, denied } = await partitionNotebookKbIds(req, notebook);
        if (denied.length > 0) {
            log.warn('[NotebookChat] dropped inaccessible kb ids:', { notebookId: notebook.id, userId, denied });
        }
        kbIds = allowed;
    }
    if (kbIds.length > 0) {
        emitPhase(send, 'kb_search');
        const _kbT = Date.now();
        try {
            const kbResult = await searchNotebookKB({
                // The tenant the notebook's chunks are stored under: its owner's.
                userId: notebook.userId, kbIds, query: message,
                options: { topK: 10, rerank: true, minScore: 0.2 },
                // Chunks carry the source id; the prompt and chips show its name.
                sources: readySources,
            });

            repeatGuard.seedChunks(kbResult.chunks);
            if (kbResult.chunks.length > 0) {
                // searchNotebookKB already mapped each chunk to its source by id
                // (exact). What is left is a title that matched no source id, e.g.
                // a hit from a base attached by hand: fuzzy-match those only.
                const resolveSourceName = (rawTitle) => {
                    if (!rawTitle) return 'Unknown Source';
                    return findSourceForChunk({ title: rawTitle }, readySources)?.name || rawTitle;
                };

                citationSources = kbResult.citations.map(c => ({
                    ...c,
                    title: resolveSourceName(c.title),
                }));
                // Injected without a tool call, so the "own server" block
                // list applies as it does to notebook_kb_search (BFSF-354),
                // before the tokenisation below. The citations stay real.
                kbContext = await toolPiiGate.stripInjectedText(kbResult.contextPrompt, { shield: orgShieldConfig, tag: 'NotebookChat' });
                log.info(`[NotebookChat] Injected ${kbResult.chunks.length} KB chunks for notebook ${notebook.id}`);

                // Tokenize the retrieved KB context BEFORE it enters the prompt.
                // Embeddings + stored source text stay REAL (ingest untouched) —
                // we only tokenize the small set of chunks actually injected,
                // seeded from + merged into the SAME notebook map so a name shared
                // by a source and the document maps to one [person_1]. The
                // citationSources previews (sent to the client below) stay REAL —
                // they are the user's own sources.
                // privacy_scan_knowledge_bases=false: the org does not want knowledge-base
                // content tokenised, at query time either (default: scan).
                if (kbContext && docShield?.enabled && docShield.privacy_scan_knowledge_bases !== false) {
                    try {
                        const kbScan = await _scanViaLedger(kbContext, 'kb-context');
                        if (kbScan.blocked) { _abortBlocked('kb-context'); return STOP; }
                        if (kbScan.text !== null) kbContext = kbScan.text;
                        // Coverage guarantee: per-chunk detection can miss a span
                        // the ingest-time scan already mapped. Apply the notebook's
                        // accumulated map (real→token) so EVERY known entity in the
                        // retrieved context is tokenised before the model sees it —
                        // the model must never read a raw name that's already mapped.
                        const { buildReverseReplacer } = require('../../../core/dlp/applyTokenMapToOutbound');
                        const _rev = buildReverseReplacer(dlpRunner.getConversationTokenMap(notebookId));
                        if (_rev) kbContext = _rev(kbContext);
                    } catch (kbScanErr) {
                        log.warn('[NotebookChat] KB context PII scan failed:', kbScanErr.message);
                        if (_failClosed) { _abortFailClosed('kb-context'); return STOP; }
                    }
                }
            }
        } catch (kbErr) {
            log.warn('[NotebookChat] KB search failed:', kbErr.message);
        }
        emitPhaseEnd(send, 'kb_search', Date.now() - _kbT);
    }

    // Send citation sources to frontend
    if (citationSources.length > 0) {
        // The shared citation shape (core/kb/citation.js), which keeps the
        // `preview` alias for one release. This used to send ONLY
        // `preview`, so every citation popup showed "No content preview
        // available." — the text was fetched, scored and sent under a key
        // nothing consumed.
        const { toCitations } = require('../../../core/kb/citation');
        send('kb_sources', { sources: toCitations(citationSources, { kind: 'notebook' }) });
    }
    return { kbIds, kbContext };
}

/**
 * Build document context. We used to hard-truncate at 8000 chars, which
 * silently dropped content for anything longer than ~4 pages. Now we fit
 * the document into a token budget (~20k tokens ≈ 80k chars) and tell
 * BOTH the AI and the user when truncation happened so neither thinks
 * they've seen the whole thing.
 * @returns {Promise<typeof STOP | { documentContext: string, documentTruncation: object|null, docPiiTokenMap: object|null, scannedDocumentContent: string }>}
 */
async function buildDocumentContext({ documentContent, notebook, notebookId, docShield, scans }) {
    const { _failClosed, _abortFailClosed, _scanViaLedger, _abortBlocked } = scans;
    const { fitIntoTokenBudget } = require('../../../core/llm/tokenBudget');
    const DOCUMENT_CONTEXT_TOKENS = 20000;
    let documentContext = '';
    let documentTruncation = null; // { originalTokens, keptTokens, approxPagesCut }
    // Privacy Shield — scan the notebook document body BEFORE it lands
    // in the system prompt. Without this, PII inside the TipTap editor
    // (names, BSNs, emails in a Wmo intake document) leaks directly to
    // the model because the regular validateInputForPii() only scans
    // the user/assistant message turns, not the system prompt.
    let docPiiTokenMap = null;
    let scannedDocumentContent = documentContent;
    if (documentContent && documentContent.trim() && documentContent !== '<p></p>') {
        try {
            if (docShield?.enabled) {
                const scanRes = await _scanViaLedger(documentContent, 'notebook-document');
                if (scanRes.blocked) { _abortBlocked('document'); return STOP; }
                if (scanRes.text !== null) {
                    scannedDocumentContent = scanRes.text;
                    docPiiTokenMap = scanRes.tokenMap || docPiiTokenMap;
                }
                // Coverage guarantee (mirrors the KB-context path): apply the
                // notebook's accumulated map (real→token) so any mapped entity the
                // per-document detection missed is still tokenised before the body
                // enters the prompt — the model reads `[email_1]`, never the real
                // value, when it re-reads its own stored-real document.
                const { buildReverseReplacer } = require('../../../core/dlp/applyTokenMapToOutbound');
                const _revDoc = buildReverseReplacer(dlpRunner.getConversationTokenMap(notebookId));
                if (_revDoc) scannedDocumentContent = _revDoc(scannedDocumentContent);
            }
        } catch (docScanErr) {
            log.warn('[NotebookChat] Document PII scan failed, falling back to raw content:', docScanErr.message);
            if (_failClosed) { _abortFailClosed('document'); return STOP; }
        }
    }
    if (scannedDocumentContent && scannedDocumentContent.trim() && scannedDocumentContent !== '<p></p>') {
        // Inline the document as Markdown (≈30–60% fewer tokens than the HTML
        // for the same content), so more of it fits in the context budget.
        //
        // The documentMd shortcut is only safe when the shield is OFF. It
        // used to be taken whenever no token map came back — but a map is
        // only produced for the `tokenize` verdict, so every other outcome
        // (`pass`, `block`, a shield that returned nothing) fell through to
        // the RAW, never-scanned mirror and shipped it to the provider,
        // defeating the scan entirely. With the shield on, always use the
        // scanned body.
        const scannedMarkdown = (!docShield?.enabled && notebook.documentMd)
            ? notebook.documentMd
            : htmlToMarkdown(scannedDocumentContent);
        const fit = fitIntoTokenBudget(scannedMarkdown, DOCUMENT_CONTEXT_TOKENS);
        if (fit.truncated) {
            documentTruncation = {
                originalTokens: fit.originalTokens,
                keptTokens: fit.keptTokens,
            };
            documentContext =
                `\n\n[DOCUMENT EDITOR — CURRENT CONTENT, TRUNCATED]\n` +
                `The user has a large rich-text document editor open in the center panel. ` +
                `Roughly ${fit.keptTokens.toLocaleString()} of ${fit.originalTokens.toLocaleString()} tokens shown below. ` +
                `If the user asks about something not visible here, use notebook_kb_search to retrieve from the indexed content, ` +
                `or ask them to quote / select the section they mean.\n` +
                `\`\`\`markdown\n${fit.text}\n\`\`\`\n` +
                `You can read, write, or edit this document using the notebook_doc_* tools.`;
        } else {
            documentContext =
                `\n\n[DOCUMENT EDITOR — CURRENT CONTENT]\n` +
                `The user has a rich-text document editor open in the center panel. Current content:\n` +
                `\`\`\`markdown\n${fit.text}\n\`\`\`\n` +
                `You can read, write, or edit this document using the notebook_doc_* tools.`;
        }
    } else {
        documentContext = '\n\n[DOCUMENT EDITOR — EMPTY]\nThe user has an empty rich-text document editor open. Use notebook_doc_write to create content.';
    }
    return { documentContext, documentTruncation, docPiiTokenMap, scannedDocumentContent };
}

/**
 * Append the user's editor selection (set by the Ask AI / rewrite /
 * shorten / expand bubble menu actions on the frontend). When present,
 * the AI should treat "this", "the text", "the selection", etc. as
 * referring to the exact string below, and — for rewrite-style actions
 * — pass that same string verbatim as `find_text` to notebook_doc_replace.
 */
function buildSelectionContext(notebookSelection) {
    let selectionContext = '';
    if (notebookSelection && typeof notebookSelection.text === 'string' && notebookSelection.text.trim()) {
        const MAX_SEL_CHARS = 8000;
        const selText = notebookSelection.text.length > MAX_SEL_CHARS
            ? notebookSelection.text.slice(0, MAX_SEL_CHARS) + '…[truncated]'
            : notebookSelection.text;
        const actionHint = notebookSelection.action && ['rewrite', 'shorten', 'expand'].includes(notebookSelection.action)
            ? `The user explicitly invoked "${notebookSelection.action}" on this selection, so you MUST call notebook_doc_replace with find_text set to the exact selection above and replace_text set to your revised version.`
            : `If the user asks you to edit, rewrite, or change "this" / "the text" / "the selection", use notebook_doc_replace with find_text set to the EXACT string above. If they ask a question, answer about this text specifically.`;
        selectionContext =
            `\n\n[SELECTED TEXT IN DOCUMENT]\n` +
            `The user has highlighted the following text in the editor:\n` +
            `<<<SELECTION_BEGIN>>>\n${selText}\n<<<SELECTION_END>>>\n` +
            actionHint;
    }
    return selectionContext;
}

/** Whether web search is configured, for the system prompt and the tool list. */
async function isSearchAvailable() {
    const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
    const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
    const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
    return searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);
}

/** One line per ready source, for the system prompt. */
function buildSourceSummary(readySources) {
    return readySources.length > 0
        ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
        : '(No sources added yet)';
}

/** The notebook system prompt around the context built above. */
function buildSystemPrompt({ today, notebook, sourceSummary, searchAvailable, kbContext, documentContext, selectionContext, timezone }) {
    return `You are an intelligent notebook assistant. Today is ${today}.

[NOTEBOOK: "${notebook.name}"]
${notebook.description ? `Description: ${notebook.description}` : ''}
${notebook.instructions ? `\nCustom Instructions: ${notebook.instructions}` : ''}

[AVAILABLE SOURCES]
${sourceSummary}

CRITICAL INSTRUCTIONS:
1. ALWAYS ground your responses in the notebook's sources when relevant context is available.
2. When you use specific information from the knowledge base, name the source it comes from (e.g. according to "Report.pdf"). The app shows the cited passages as source chips under your answer on its own. Never use numeric references such as [1] or [Source 1].
3. If the user asks about something not covered in the sources, clearly state that and provide general knowledge with a disclaimer.
4. Be comprehensive but concise. Synthesize information across multiple sources when applicable.
5. If asked to summarize, compare, or analyze — draw from ALL relevant sources.
6. Format responses with clear structure: headings, bullet points, and citations.

[DOCUMENT TOOLS]
You have tools to interact with the user's document editor:
- notebook_doc_read: Read the current document content (ALWAYS use before editing)
- notebook_doc_write: Replace ALL document content (for new documents or full rewrites)
- notebook_doc_replace: Replace a SPECIFIC portion (preferred for edits)

DOCUMENT FORMAT — write the document in Markdown (BFM):
- Headings: # H1, ## H2, ### H3
- Inline: **bold**, *italic*, ~~strike~~, inline code in single backticks, ==highlight==
- Lists: "- item", "1. item"; task lists "- [ ] todo" / "- [x] done"
- > blockquote, --- divider, [text](url) links
- Tables: a header row, then a |---|---| separator row, then data rows
- Fenced code blocks (triple-backtick + language); diagrams use triple-backtick mermaid fences
- Math (KaTeX): $inline$ and $$block$$
- Images: ![alt](url){w=400 align=center wrap} (attrs optional; user uploads go via the toolbar, not AI)
- Color/font are rare: [text]{color=#e74c3c} / [text]{font=Georgia}

DOCUMENT RULES — FOLLOW STRICTLY:
1. To rewrite, shorten, expand, fix, edit, or modify text from the document: ALWAYS use notebook_doc_replace to apply the change directly — do NOT just return the modified text in chat.
2. For partial edits, ALWAYS prefer notebook_doc_replace over notebook_doc_write.
3. Before notebook_doc_replace, call notebook_doc_read to see the EXACT current Markdown.
4. When asked to write, create, or draft something: write it via notebook_doc_write — don't just reply in chat.
5. The user's message may include selected document text — pass it verbatim as find_text.
6. After applying a change, briefly confirm what you did (e.g. "I've shortened that paragraph").
7. In the document, cite a source by its name in plain text (or as a [Source name](url) link only when you really know its URL) — never [1]-style refs.
8. STYLE CONSISTENCY: when replacing, match the original formatting — don't promote a paragraph to a heading unless asked.

${searchAvailable ? `[WEB SEARCH & SOURCES]
- You can search the web using agent_search for current information and research
- You can add search results or any text directly as a notebook source using notebook_add_source
- When adding web search results as a source, pass the complete results text directly — no need to re-fetch
` : ''}${kbContext ? `[KNOWLEDGE BASE]
The passages below are already retrieved for this question. Call notebook_kb_search only to look up something different from what is below, and never repeat a search you have already done.
` : ''}${kbContext}${documentContext}${selectionContext}
Now: ${formatLocalNow(timezone)}`;
}

module.exports = {
    retrieveKbContext, buildDocumentContext, buildSelectionContext, isSearchAvailable, buildSourceSummary,
    buildSystemPrompt,
};
