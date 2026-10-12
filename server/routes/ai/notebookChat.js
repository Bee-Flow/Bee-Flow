/**
 * Notebook Chat — AI chat with full tool support
 * 
 * Tools available:
 * - notebook_doc_read/write/replace: Read and modify the TipTap document editor
 * - agent_search: Web research
 * - notebook_add_source: Add web search results directly as notebook sources
 */

const express = require('express');
const { formatLocalNow } = require('../../core/llm/clock');
const log = require('../../telemetry/log');
const router = express.Router();
router.use(require('../../stores/lib/documentCrypto').withDocumentEncryptionSession);
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const notebookStore = require('../../stores/notebookStore');
const notebookConversationStore = require('../../stores/notebookConversationStore');
const { countWords } = require('../../utils/text');
const { startSseHeartbeat } = require('../../core/http/sseHelpers');

const { NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL, executeNotebookDocTool } = require('../../integrations/notebookDocTools');
const { htmlToMarkdown } = require('../../core/markdown');
const { AGENT_SEARCH_TOOLS, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const { isReadUrlTool } = require('../../integrations/readUrlTools');
// read_url ships with AGENT_SEARCH_TOOLS and is handled as a web tool here.
const isWebTool = (name) => isAgentSearchTool(name) || isReadUrlTool(name);
const { runAgentSearchWithEgress } = require('../../integrations/agentSearchEgress');
const { searchNotebookKB, findSourceForChunk, executeNotebookKBSearchTool, NOTEBOOK_KB_SEARCH_TOOL } = require('../../core/kb/notebookKnowledgeSearch');
const { emitPhase, emitPhaseEnd, startPrivacyScanPhase, messageText } = require('../../core/agentRuntime/phaseEvents');
const { checkSubscriptionLimits } = require('../../core/entitlements/limits');

require('../../core/entitlements/betaFeatures');

// ── Guardrails (parity with direct chat) ─────────────────────────────
const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
const { resolveShieldFor, mergeWithOrgShield } = require('../../core/privacy/orgShield');
const { checkRegexPatterns } = require('../../core/privacy/guardrails');
const { applyRegexGuardrails } = require('../../core/agentRuntime/guardrailsRunner');
const guardrailEventStore = require('../../stores/guardrailEventStore');

// ── PII tokenization round-trip (parity with direct chat) ────────────
// The notebook path tokenizes inbound (doc body + user message) but historically
// never restored outbound, so `[person_1]` leaked into the chat + the editor and
// the token map was never persisted. These finish the round-trip: un-tokenise the
// stream for display, teach the model to preserve tokens, and re-tokenise history.
const dlpRunner = require('../../core/dlp/dlpRunner');
const { createUntokeniser } = require('../../core/dlp/untokeniseStream');
const { buildTokenPreservationAddendum } = require('../../core/dlp/tokenPreservationPrompt');
const { applyTokenMapToMessages, untokeniseToolArgs } = require('../../core/dlp/applyTokenMapToOutbound');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
// The chat engine's bag: typed, not closed (see routes/ai/directChat/turnSchema.js).
const { NotebookTurnBody } = require('./directChat/turnSchema');
// The KB search path below applies no tenant filtering — the kb id list is the
// access boundary — so ids read off the notebook row are re-authorized here:
// the notebook's own base by notebook role, any other by the caller's own access.
const { partitionNotebookKbIds } = require('../../agents/notebooks/notebookKbAccess');
const notebookCollab = require('../../agents/notebooks/notebookCollab');
const { makeAiDocWriter, canonicalHtml } = require('../../agents/notebooks/aiDocWriter');
const { makeNotebookFeed } = require('../../agents/notebooks/notebookFeed');
const { hasNotebookRole } = require('../notebooksAccess');
const { createToolRepeatGuard } = require('../../core/agentRuntime/toolRepeatGuard');

/**
 * Collaborators a test swaps on this object (testUtils/swaps.js). The
 * co-editing facade is resolved at call time.
 */
const seams = {
    collab: () => notebookCollab.defaultFacade(),
    feed: () => makeNotebookFeed(),
};

// What the model is told when a write is refused, in words it can pass on.
const VIEWER_WRITE_REFUSAL = 'This user can view this notebook but not change it, so the document and its sources were left as they are. Answer in the chat instead.';
const CONFLICT_REFUSAL = 'The document was changed by someone else while you were working, so your edit was NOT applied. It was kept in the version history as a proposal the user can compare and restore. Tell the user, and offer to redo the edit on the current text.';

// ─── Streaming Notebook Chat ─────────────────────────────────────

router.post('/chat/notebook/stream', requireAuth, validate({ body: NotebookTurnBody }), async (req, res) => {
    const { message, notebookId, history, modelTier, timezone, attachments, notebookSelection, docVersion } = req.body;
    const userId = req.session.user.id;

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!notebookId) return res.status(400).json({ error: 'Notebook ID required' });

    // Load notebook
    const notebook = await notebookStore.getNotebook(notebookId, userId);
    if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
    // A viewer may chat (privately, like everyone) but the AI may not change
    // the notebook on their behalf: no document write, no new source.
    const canWrite = hasNotebookRole(notebook.role || null, 'editor');
    // The document this turn reads and edits. While the notebook is co-edited
    // that is the LIVE document: the page's copy can be a fork (a failed join)
    // and the row is a mirror that lags by minutes (mobile sends the mirror).
    let documentContent = req.body.documentContent;
    const turnStart = await notebookCollab.readCurrentContent(notebook, seams.collab())
        .catch((e) => { log.warn('[NotebookChat] live read at turn start failed', { notebookId, error: e.message }); return null; });
    if (turnStart?.live) documentContent = turnStart.html;

    // ── Subscription limit enforcement ──
    // Same pattern as /api/agents/:id/chat/stream — block AI calls past the
    // org's monthly message/token/cost cap before any model runtime is invoked.
    {
        const { resolveUserOrgIds: _resolveOrgs } = require('../../auth');
        const orgIds = await _resolveOrgs(req);
        const limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
        if (limitError) return res.status(402).json({ error: limitError });
    }

    // Get sources for context
    const sources = await notebookStore.getSources(notebookId);
    const readySources = sources.filter(s => s.status === 'ready');

    // EU mode + org privacy shield: resolve user's org — cached tier-org (M2),
    // collapses the per-message getAllGroups scan to one lookup per user/~45s.
    const { getEUAwareTiers, resolveEffectiveOrgId } = require('../../core/llm/modelResolver');
    const userOrgForTiers = await resolveEffectiveOrgId(req, { userId });

    // Resolve model from tier config (EU-aware via centralized modelResolver)
    let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled && shield.euModeEnabled) {
            log.info(`[NotebookChat] EU mode active for org ${userOrgForTiers}`);
        }
    }

    let resolvedTier = modelTier || 'fast';
    if (resolvedTier === 'standard') {
        resolvedTier = 'fast';
    }

    // Auto mode: classify which tier to use (matches direct chat)
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/llm/promptClassifier');
            const result = await classifyWithLLM(message, tiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            log.info(`[NotebookChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            log.info(`[NotebookChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }
    if (resolvedTier === 'standard') {
        resolvedTier = 'fast';
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
    }

    // Resolve provider
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        log.error(`[NotebookChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    log.info(`[NotebookChat] Model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''}) for notebook ${notebook.id} (${readySources.length} sources)`);

    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Keep the stream warm through the NC AppAPI proxy during long reasoning /
    // doc-edit turns so it isn't idle-timed-out into a 504 (BFSF-221/177).
    startSseHeartbeat(res);

    // One abort signal per turn, tripped when the client disconnects (the Stop
    // button closes the EventSource). Without this the tool loop kept running
    // after Stop and a notebook_doc_write still landed in the database — the
    // user cancelled and the document changed anyway, with no undo in the UI.
    const turnAbort = new AbortController();
    let clientGone = false;
    res.on('close', () => {
        if (res.writableEnded) return;   // normal completion, not a cancel
        clientGone = true;
        turnAbort.abort();
        log.info('[NotebookChat] client disconnected — aborting turn');
    });
    const aborted = () => clientGone || turnAbort.signal.aborted;

    // Persist a verified authority into the matter's bronnenlijst when a
    // retrieval tool returns a real record (a successful _get IS verification).

    // Notify frontend of auto-selected model
    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    try {
        // ── PII round-trip setup (shared by KB / document / message scans) ──
        // Hydrate the notebook's persisted PII token map (keyed by notebookId)
        // BEFORE any tokenization this turn, so doc/KB/message tokens reuse tokens
        // minted on earlier turns and survive a server restart. Idempotent.
        try { await dlpRunner.getConversationTokenMapAsync(notebookId); } catch (_) { /* best-effort */ }
        // Resolve the Privacy Shield ONCE — respect-the-shield: tokenization
        // only runs when it is enabled. The RESOLVED shape, never the stored
        // org document: a personal account (no org) has only a user-level
        // shield, which the stored-document read never saw, so its document,
        // KB passages, attachments and typed message reached the model
        // unscanned (the direct-chat equivalent was BFSF-290/291). The resolved
        // shape also carries the tier clamps and the documented fail_closed
        // default. Used by the KB, document, attachment and message scans, the
        // regex rules below, and the tool block lists (BFSF-354).
        const orgShieldConfig = await resolveShieldFor({ orgId: userOrgForTiers, userId });
        const docShield = orgShieldConfig;
        const toolPiiGate = require('../../core/privacy/toolPiiGate');
        // When the shield is on AND set to fail closed, a scan that throws must
        // abort the turn rather than silently sending raw PII to the model.
        const _failClosed = !!docShield?.enabled && (docShield?.dlpFailureMode === 'fail_closed');
        const _abortFailClosed = (where) => {
            log.warn(`[NotebookChat] 🚫 Privacy Shield scan failed (${where}); fail_closed → aborting turn`);
            send('error', { error: 'Privacy Shield could not verify this content for personal data, so the request was blocked. Please try again shortly.' });
            res.end();
        };
        // A `block` verdict is the shield saying "this content must not leave
        // the tenant". It was never handled here: the scan result was only
        // inspected for `action === 'tokenize'`, so a block fell through and the
        // content went to the provider anyway — the strictest setting was the
        // one that silently did nothing.
        /**
         * Scan a body of notebook text through the durable scan ledger.
         *
         * Replaces two `scanAttachmentText` calls that re-scanned the same
         * content on every single turn. Both were handed a string that is
         * re-assembled per turn (a query-dependent KB blob, the live editor
         * HTML), so neither existing cache could ever hit; the ledger keys on
         * content-defined SEGMENTS instead, which are stable across
         * re-assembly and across edits elsewhere in the document.
         *
         * `text: null` means "nothing to substitute" — the caller keeps what it
         * had, exactly as it did when the old scanner returned `pass`.
         */
        const _scanViaLedger = async (text, label) => {
            const { composeScan } = require('../../core/dlp/composeScan');
            const r = await composeScan({
                units: [text],
                orgShield: docShield,
                conversationId: notebookId,
                scope: 'g',
            });
            if (r.stats.segments > 0) {
                log.info(`[NotebookChat] scan ${label}: segments=${r.stats.segments} hits=${r.stats.hits} fresh=${r.stats.fresh}`);
            }
            if (r.blocked) return { blocked: true, text: null, tokenMap: null };
            if (r.tokenMap && r.units[0] !== text) {
                log.warn(`[NotebookChat] 🔒 ${label} tokenised (${r.count} value(s), ${r.mentions} mention(s))`);
                return { blocked: false, text: r.units[0], tokenMap: r.tokenMap };
            }
            return { blocked: false, text: null, tokenMap: null };
        };

        const _abortBlocked = (where) => {
            log.warn(`[NotebookChat] 🚫 Privacy Shield BLOCKED content (${where}) — aborting turn`);
            send('error', { error: 'Privacy Shield blocked this request because the content contains personal data that may not be sent to the AI model.' });
            res.end();
        };

        // Per-turn guard: the same read-only call twice, or a passage already in
        // the prompt, is not served again (see core/agentRuntime/toolRepeatGuard).
        const repeatGuard = createToolRepeatGuard({ readOnlyTools: ['notebook_kb_search', 'notebook_doc_read'] });
        // Search notebook knowledge base for relevant context
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
                            if (kbScan.blocked) return _abortBlocked('kb-context');
                            if (kbScan.text !== null) kbContext = kbScan.text;
                            // Coverage guarantee: per-chunk detection can miss a span
                            // the ingest-time scan already mapped. Apply the notebook's
                            // accumulated map (real→token) so EVERY known entity in the
                            // retrieved context is tokenised before the model sees it —
                            // the model must never read a raw name that's already mapped.
                            const { buildReverseReplacer } = require('../../core/dlp/applyTokenMapToOutbound');
                            const _rev = buildReverseReplacer(dlpRunner.getConversationTokenMap(notebookId));
                            if (_rev) kbContext = _rev(kbContext);
                        } catch (kbScanErr) {
                            log.warn('[NotebookChat] KB context PII scan failed:', kbScanErr.message);
                            if (_failClosed) return _abortFailClosed('kb-context');
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
            const { toCitations } = require('../../core/kb/citation');
            send('kb_sources', { sources: toCitations(citationSources, { kind: 'notebook' }) });
        }

        // If the document was too large to inline in the prompt, tell the UI so
        // it can show a one-shot banner. The client-side handler decides whether
        // to suppress repeat banners for the same conversation turn.
        // Emitted AFTER the systemPrompt build below uses `documentTruncation` —
        // so the announcement is deferred until we've actually committed to it.

        // Build source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // Build document context. We used to hard-truncate at 8000 chars, which
        // silently dropped content for anything longer than ~4 pages. Now we fit
        // the document into a token budget (~20k tokens ≈ 80k chars) and tell
        // BOTH the AI and the user when truncation happened so neither thinks
        // they've seen the whole thing.
        const { fitIntoTokenBudget } = require('../../core/llm/tokenBudget');
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
                    if (scanRes.blocked) return _abortBlocked('document');
                    if (scanRes.text !== null) {
                        scannedDocumentContent = scanRes.text;
                        docPiiTokenMap = scanRes.tokenMap || docPiiTokenMap;
                    }
                    // Coverage guarantee (mirrors the KB-context path): apply the
                    // notebook's accumulated map (real→token) so any mapped entity the
                    // per-document detection missed is still tokenised before the body
                    // enters the prompt — the model reads `[email_1]`, never the real
                    // value, when it re-reads its own stored-real document.
                    const { buildReverseReplacer } = require('../../core/dlp/applyTokenMapToOutbound');
                    const _revDoc = buildReverseReplacer(dlpRunner.getConversationTokenMap(notebookId));
                    if (_revDoc) scannedDocumentContent = _revDoc(scannedDocumentContent);
                }
            } catch (docScanErr) {
                log.warn('[NotebookChat] Document PII scan failed, falling back to raw content:', docScanErr.message);
                if (_failClosed) return _abortFailClosed('document');
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

        // Append the user's editor selection (set by the Ask AI / rewrite /
        // shorten / expand bubble menu actions on the frontend). When present,
        // the AI should treat "this", "the text", "the selection", etc. as
        // referring to the exact string below, and — for rewrite-style actions
        // — pass that same string verbatim as `find_text` to notebook_doc_replace.
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

        // Build system prompt
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Compute search availability before the system prompt uses it
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        // ── Build system prompt ──────────────────────────────────────
        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        let systemPrompt;
        {
            systemPrompt = `You are an intelligent notebook assistant. Today is ${today}.

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
        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);

        // Announce document truncation to the client now that we've finalised
        // the system prompt. One event per turn — the UI debounces banners.
        if (documentTruncation) {
            send('document_truncated', documentTruncation);
        }

        let messages = [{ role: 'system', content: systemPrompt }];

        // Add conversation history, newest-first within a token budget.
        //
        // This used to push EVERY prior turn unconditionally, on top of a
        // ≤20k-token document and the KB context. Past a certain thread length
        // the request exceeded the model's context window and the turn failed —
        // and because the history only ever grew, it then failed forever: the
        // conversation was permanently unusable with no recovery but deleting
        // it. Dropping the oldest turns keeps a long thread working; the model
        // is told the transcript was trimmed so it doesn't claim to recall
        // something it can no longer see.
        if (history && Array.isArray(history)) {
            const HISTORY_TOKEN_BUDGET = 12000;         // ≈48k chars
            const approxTokens = (s) => Math.ceil(String(s || '').length / 4);
            const usable = history.filter(
                (m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim()
            );
            const kept = [];
            let spent = 0;
            for (let i = usable.length - 1; i >= 0; i--) {
                const cost = approxTokens(usable[i].content);
                if (spent + cost > HISTORY_TOKEN_BUDGET && kept.length > 0) break;
                kept.unshift(usable[i]);
                spent += cost;
            }
            const dropped = usable.length - kept.length;
            if (dropped > 0) {
                log.info(`[NotebookChat] history trimmed: dropped ${dropped} of ${usable.length} messages (~${spent} tok kept)`);
                messages.push({
                    role: 'user',
                    content: `[Earlier in this conversation, ${dropped} message(s) were omitted to stay within the context limit. If the user refers to something not shown below, say you no longer have it in view and ask them to restate it, or search the notebook's sources.]`,
                });
            }
            for (const msg of kept) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }

        // Add current message with attachments
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });

            // Use the same server-side extraction pipeline as direct chat so
            // PDFs/DOCX/spreadsheets are turned into real text (pdfjs → Azure →
            // Mistral OCR → vision) instead of being UTF-8-decoded into garbage.
            const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote, isPdf, isDocx, isSpreadsheet } = require('../../core/documents/attachmentExtractor');
            // Tokenize PII in extracted attachment text BEFORE it enters the prompt
            // — a file attached in Legal/Notebook chat must not send names/BSN/email
            // to the model raw (notebook chat used to inline attachment text raw).
            // Honors the org's chosen action and merges into the same notebook token
            // map so the streamed reply un-tokenises consistently. Reuses the same
            // scanner as direct chat + the KB/doc scans.
            // Returns the verdict, not just text: `{ blocked }` when the shield
            // blocks the attachment (or a fail-closed scan could not finish),
            // `{ scanFailed }` when the scan threw under fail_closed, else
            // `{ text }`. A block used to fall through to the ORIGINAL text, so
            // the strictest setting sent the attachment to the provider; with
            // an image in the turn the message gate below scans only the typed
            // question, so nothing caught it afterwards. The caller aborts the
            // turn (it cannot be thrown from here: the per-attachment
            // try/catch would turn it into a "could not be read" note).
            const _scanAttBody = async (text, filename) => {
                if (!text || !docShield?.enabled) return { text };
                try {
                    const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                    const r = await scanAttachmentText({ text, filename: filename || 'attachment', orgShield: docShield, conversationId: notebookId });
                    if (r?.action === 'block') return { blocked: true };
                    // Any scanner-produced text wins — on an incomplete scan it is
                    // the truncated document; keeping the original would re-add the
                    // pages nobody checked.
                    if (r && typeof r.text === 'string') return { text: r.text };
                } catch (e) {
                    log.warn('[NotebookChat] attachment PII scan failed:', e.message);
                    if (_failClosed) return { scanFailed: true };
                }
                return { text };
            };
            for (const att of attachments) {
                try {
                    if (att.type && att.type.startsWith('image/') && att.content) {
                        contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                    } else if (att.content && (isPdf(att) || isDocx(att) || isSpreadsheet(att))) {
                        const result = await extractAttachment(att, { modelSupportsVision: adapter.supportsVision?.(modelId) });
                        if (result.kind === 'text') {
                            const _scan = await _scanAttBody((result.text || '').slice(0, 20000), att.name);
                            if (_scan.blocked) return _abortBlocked('attachment');
                            if (_scan.scanFailed) return _abortFailClosed('attachment');
                            const _body = _scan.text;
                            contentParts.push({ type: 'text', text: `${formatTextHeader(att, result)}\n---\n${_body}\n---` });
                        } else if (result.kind === 'images' && Array.isArray(result.images)) {
                            contentParts.push({ type: 'text', text: formatImagesHeader(att, result) });
                            for (const img of result.images) {
                                contentParts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
                            }
                        } else {
                            contentParts.push({ type: 'text', text: formatFailureNote(att, result) });
                        }
                    } else if (att.content && typeof att.content === 'string') {
                        // Plain-text / csv / code files — a UTF-8 decode is correct.
                        const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                        if (textContent) {
                            const _scan = await _scanAttBody(textContent.slice(0, 8000), att.name);
                            if (_scan.blocked) return _abortBlocked('attachment');
                            if (_scan.scanFailed) return _abortFailClosed('attachment');
                            const _body = _scan.text;
                            contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${_body}\n---` });
                        }
                    }
                } catch (attErr) {
                    contentParts.push({ type: 'text', text: `[Bestand: ${att.name} — kon niet worden gelezen: ${attErr.message}]` });
                }
            }

            const hasImages = contentParts.some(p => p.type === 'image_url');
            if (hasImages) {
                messages.push({ role: 'user', content: contentParts });
            } else {
                const combined = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
                if (combined.trim()) messages.push({ role: 'user', content: combined });
            }
        } else {
            messages.push({ role: 'user', content: message });
        }

        // ── Unicode Smuggling Defense (must run FIRST) ──────────────────
        const unicodeResult = sanitizeMessagesUnicode(messages);
        if (unicodeResult.smugglingDetected) {
            log.warn(`[NotebookChat] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
            send('unicode_smuggling_detected', {
                strippedCount: unicodeResult.totalStripped,
                messageIndices: unicodeResult.detectedIn,
            });
            guardrailEventStore.logGuardrailEvent({
                organization_id: userOrgForTiers || null,
                user_id: userId || null,
                conversation_id: notebookId || null,
                violation_type: 'unicode_smuggling',
                violation_categories: `${unicodeResult.totalStripped} hidden chars`,
                direction: 'input',
                action_taken: 'stripped',
                source: 'notebook',
            }).catch(() => {});
        }

        // ── PII detection / tokenization (Privacy Shield) ──────────────
        // Mirrors directChat: if the org's Privacy Shield is enabled,
        // run validateInputForPii on the last user message and apply
        // tokenize/block actions. detectPii() calls the PII Guard service.
        let piiTokenMap = null;
        // Privacy-panel parity with directChat: assembled once per turn, emitted
        // to the client (live) AND persisted on the assistant message (so the
        // "Privacy protection" panel survives a refresh). `_userPiiCategories`
        // backs the redacted badge on the user bubble; `_showRawPayload` gates
        // surfacing the exact tokenised prompt / token map (org opt-in).
        let _assistantTokenisationInfo = null;
        let _userPiiCategories = [];
        let _showRawPayload = false;
        try {
            const orgShield = docShield;
            const orgPiiEnabled = !!orgShield?.enabled;
            _showRawPayload = !!orgShield?.showRawPayload;
            // Hydrate the conversation-scoped token map (keyed on notebookId
            // here, matching the mergeTokenMap key below) before tokenisation
            // runs so turn 2+ reuses tokens minted on turn 1 instead of
            // leaking them to the LLM as literal text. Idempotent.
            if (notebookId) {
                try { await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(notebookId); }
                catch (_) { /* hydration is best-effort */ }
            }
            if (orgPiiEnabled) {
                const { validateInputForPii } = require('../../core/privacy/piiDetection');
                const _np = startPrivacyScanPhase(send, messageText(messages[messages.length - 1]));
                let piiResult;
                try {
                    piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield, null, null, { onProgress: _np.onProgress });
                } finally {
                    _np.end();
                }
                if (piiResult && piiResult.tokenizedText) {
                    const lastMsg = messages[messages.length - 1];
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = piiResult.tokenizedText;
                    } else if (Array.isArray(lastMsg.content)) {
                        const textPart = lastMsg.content.find(p => p.type === 'text');
                        if (textPart) textPart.text = piiResult.tokenizedText;
                    }
                    piiTokenMap = piiResult.tokenMap;
                    try { require('../../core/dlp/dlpRunner').mergeTokenMap(notebookId, piiResult.tokenMap); } catch (_) { /* non-fatal */ }
                    log.warn(`[NotebookChat] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);

                    // ── Surface the tokenisation to the client (parity w/ directChat) ──
                    // Drives the user-bubble "redacted" badge + the assistant-side
                    // "Privacy protection" panel. The exact tokenised prompt + the
                    // real-value token map are only emitted when the org opted into
                    // showRawPayload; the count/categories badge always shows.
                    _userPiiCategories = [...new Set((piiResult.entities || []).map(e => e.label || e.category).filter(Boolean))];
                    const _piiCount = Object.keys(piiTokenMap).length;
                    send('pii_tokenized', {
                        entities: (piiResult.entities || []).map(e => ({ label: e.label, category: e.category })),
                        tokenCount: _piiCount,
                    });
                    _assistantTokenisationInfo = {
                        source: 'pii', action: 'redact', count: _piiCount,
                        categories: _userPiiCategories, provider: modelId || null, automatic: true,
                    };
                    if (_showRawPayload) {
                        send('privacy_payload', { tokenizedPrompt: piiResult.tokenizedText, provider: modelId || null, source: 'pii', timestamp: Date.now() });
                        _assistantTokenisationInfo.tokenizedPrompt = piiResult.tokenizedText;
                        if (_piiCount > 0) {
                            send('privacy_token_map', { tokenMap: piiTokenMap, source: 'pii' });
                            _assistantTokenisationInfo.tokenMap = piiTokenMap;
                        }
                    }
                }
            }
        } catch (piiError) {
            if (piiError?.message?.includes('PII Detected')) {
                send('error', { error: piiError.message, violationCodes: piiError.violationCodes });
                return res.end();
            }
            if (piiError?.privacyUnavailable) {
                // Fail_closed: detection degraded (guard down / model not ready) —
                // block instead of sending unmasked legal text to the LLM (BFSF-269).
                log.warn(`[NotebookChat] 🛑 Privacy protection unavailable (${piiError.degradedReason || 'degraded'}) — blocking (fail_closed)`);
                send('dlp_blocked', {
                    reason: 'pii_unavailable',
                    kind: piiError.privacyUnavailableKind || 'unavailable',
                    message: piiError.message,
                });
                return res.end();
            }
            // Service unavailable → fail-open
        }

        // ── Token-preservation prompt addendum ───────────────────────────
        // Teach the model to treat tokens as opaque and reuse them verbatim so it
        // doesn't invent new placeholders or mangle `[person_1]`. Must run AFTER
        // the doc/KB/message tokenization above so the map already holds this
        // turn's tokens. Mirrors directChat.
        try {
            if (messages[0]?.role === 'system' && typeof messages[0].content === 'string'
                && !messages[0].content.includes('[PII TOKEN PRESERVATION')) {
                const _add = buildTokenPreservationAddendum(dlpRunner.getConversationTokenMap(notebookId));
                if (_add) messages[0].content += _add;
            }
        } catch (_) { /* addendum is best-effort */ }

        // ── Regex Guardrails (org Privacy Shield + input check) ──────────
        // Resolve org-wide regex rules; mirrors directChat.js:2348-2393
        let regexConfig = mergeWithOrgShield(orgShieldConfig, null); // no notebook-local overrides

        // Input regex check: block/redact before the model sees the message.
        // Match on the typed message, but redact the content the model will
        // receive: the PII gate above may have tokenised it, and without an
        // attachment image it also carries the attachment text. Redacting the
        // raw `message` put the real values back and dropped the attachments.
        const _rxLast = messages[messages.length - 1];
        const _rxTextPart = Array.isArray(_rxLast?.content) ? _rxLast.content.find(p => p.type === 'text') : null;
        const inputRx = applyRegexGuardrails({
            text: message,
            redactBase: typeof _rxLast?.content === 'string' ? _rxLast.content : (_rxTextPart ? _rxTextPart.text : message),
            regexConfig, scope: 'userInput', emit: send, direction: 'input',
            audit: { organization_id: userOrgForTiers || null, user_id: userId || null, conversation_id: notebookId || null, source: 'notebook' },
        });
        if (inputRx.action !== 'pass') {
            log.info(`[NotebookChat RegexGuard] User input violated rules: ${inputRx.ruleNames}, action: ${regexConfig.action}`);
        }
        if (inputRx.action === 'redact') {
            if (typeof _rxLast.content === 'string') {
                _rxLast.content = inputRx.processedText;
            } else if (_rxTextPart) {
                _rxTextPart.text = inputRx.processedText;
            }
        } else if (inputRx.action === 'block') {
            return res.end();
        }

        // ── Build tool list ──────────────────────────────────────────
        // A viewer's turn gets the read tool only: offering a write the server
        // would refuse just teaches the model to promise changes it cannot make.
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



        // ── Tool calling loop ────────────────────────────────────────
        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/llm/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
            // Pass an explicit reasoning effort. Without it, Claude 4.x adaptive
            // thinking defaults to 'medium' and can burn the entire (fast-tier,
            // 4096-token) budget on thinking, ending the stream with EMPTY content
            // and no document edit — the "stuck in reasoning" symptom (BFSF-177).
            reasoningEffort: req.body.reasoningEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || 'low',
        };
        // Give thinking + answer headroom so a low tier doesn't share a tiny pot.
        if (chatOptions.reasoningEffort && chatOptions.reasoningEffort !== 'none') {
            chatOptions.maxTokens = Math.max(chatOptions.maxTokens || 0, 8192);
        }

        // Track mutable document content (HTML for the client) + its Markdown
        // mirror (token-efficient source the doc tools read/edit) across rounds.
        // CRITICAL: seed the mirror in TOKEN-space when the doc was tokenized, so
        // it matches what the model sees in the system prompt (scannedDocumentContent).
        // Otherwise notebook_doc_read returns RAW text while the model's find_text
        // was written against the tokenized text it saw → notebook_doc_replace misses.
        let currentDocContent = scannedDocumentContent || documentContent || '';
        // Seed from the CLIENT's live document whenever it sent one. The stored
        // `notebook.documentMd` lags the editor by up to the autosave debounce,
        // so preferring it meant notebook_doc_read handed the model a stale
        // document — and the write that followed replaced the user's newer text
        // with an edit computed against the old version.
        let currentDocMd = docPiiTokenMap
            ? htmlToMarkdown(scannedDocumentContent)
            : (documentContent ? htmlToMarkdown(documentContent) : (notebook.documentMd || ''));
        // Set when any notebook_doc_* tool wrote this turn. The mid-turn write
        // restores tokens against whatever map existed at that instant; tokens
        // minted LATER in the same turn (source/KB/tool-result scans) would
        // otherwise leave the saved document with raw `[person_5]`/`[email]1`.
        // We re-restore the document once at end of turn against the COMPLETE map.
        let _docWritten = false;

        // ── Persisting an AI edit without overwriting anyone ────────────
        // Over the version the page had loaded (docVersion), else what the
        // server held when the turn began; while co-editing, only the model's
        // own change goes onto the live document (agents/notebooks/aiDocWriter.js).
        const aiWriter = makeAiDocWriter({
            notebookId, userId,
            baseHtml: documentContent || notebook.documentContent || '',
            expectedVersion: Number.isFinite(docVersion) ? docVersion : notebook.version,
            collab: seams.collab,
        });
        const persistAiDocWrite = aiWriter.write;
        const aiContributors = aiWriter.contributors;
        let aiLastWrite = null;   // { html, markdown } of the last applied AI edit (the model's view, real values)
        let aiVersionDoc = null;  // the document the AI left: aiLastWrite, or the live merge of it

        // Single tool executor — used for every tool the model calls, in every
        // round. Performs side-effects (doc update, source added, legal citation
        // feed-through) and returns the result object handed back to the model.
        const executeNotebookTool = async (toolName, toolArgs) => {
            if (toolName.startsWith('notebook_doc_')) {
                const r = executeNotebookDocTool(toolName, toolArgs, currentDocContent, currentDocMd);
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
                    const { restoreTokensInRichText } = require('../../core/privacy/piiDetection');
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
                        saved = await persistAiDocWrite(realHtml, realMd);
                    } catch (e) {
                        log.error('[NotebookChat] AI doc persist failed:', e.message);
                        saved = { ok: false };
                    }
                    if (saved.conflict) return { error: CONFLICT_REFUSAL };
                    if (!saved.ok) {
                        log.warn(`[NotebookChat] AI doc write not persisted for notebook ${notebookId}`);
                        return { error: 'The edit could not be saved, so the document was left as it was. Tell the user and suggest trying again.' };
                    }
                    _docWritten = true;
                    // Keep the in-memory mirror in TOKEN-space so a chained
                    // notebook_doc_read/replace later in the same turn keeps matching
                    // the tokenized text the model saw.
                    currentDocContent = r.content;
                    if (r.contentMd != null) currentDocMd = r.contentMd;
                    aiLastWrite = { html: realHtml, markdown: realMd };
                    aiVersionDoc = saved.html ? { html: saved.html, markdown: null } : aiLastWrite;
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
                const { ingestTextSource, MAX_SOURCE_TEXT_CHARS, MAX_SOURCES_PER_NOTEBOOK } = require('../../agents/notebooks/sourceIngestion');
                const sourceName = toolArgs.name || 'AI Research';
                // The model may echo tokens (`[person_1]`) in the content it asks us
                // to save as a new source. Restore to real values before ingest so the
                // stored source + its embeddings hold real text (sources are stored
                // raw/real; tokenization happens at query-time in step B4).
                const { restoreTokens } = require('../../core/privacy/piiDetection');
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

        // ── Multi-round streaming agentic loop (mirrors direct chat) ──
        // Every round streams content + reasoning + tool calls; tools stay
        // enabled across rounds so the model can chain (search → get → verify →
        // draft), all streamed, with tool_start/tool_end events the shared chat
        // renderer already understands. Fixes the previous one-shot truncation.
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 15;
        // The tool block lists, with this turn's attribution on their audit rows.
        const shieldGate = toolPiiGate.toolLoopGate({
            shield: orgShieldConfig, tag: 'NotebookChat',
            audit: (fields) => guardrailEventStore.logGuardrailEvent({
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
            const roundToolCalls = [];
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
                signal: turnAbort.signal,
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
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (_) {}
                // The model passes tokens in tool args (e.g. find_text). Restore for
                // the CLIENT-facing tool_start/tool_end previews only — the model-facing
                // result fed back below stays tokenized (token-space consistency).
                // _restoreView reads the LIVE map so tokens minted by this turn's
                // tool-result scan (below) are restored in the client preview too.
                const { restoreTokens: _rt } = require('../../core/privacy/piiDetection');
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
                        const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
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

        // ── Un-tokenise the final answer for display ─────────────────────
        // Flush any trailing partial token, then run a full-text restore as a
        // safety net (covers tokens minted very late in the turn / any chunk the
        // streaming un-tokeniser missed). `fullContent` stays TOKENIZED for storage
        // (restored on reload via the persisted map); `displayContent` is what the
        // user sees. Mirrors directChat's end-of-stream content_replace.
        { const _tail = _untok.flush(); if (_tail) send('content', { text: _tail }); }
        let displayContent = fullContent;
        {
            const { restoreTokens } = require('../../core/privacy/piiDetection');
            const _mergedMap = {
                ...(dlpRunner.getConversationTokenMap(notebookId) || {}),
                ...(docPiiTokenMap || {}),
                ...(piiTokenMap || {}),
            };
            if (Object.keys(_mergedMap).length) {
                const restored = restoreTokens(fullContent, _mergedMap);
                if (restored !== fullContent) { displayContent = restored; send('content_replace', { text: restored }); }
            }
        }

        // ── Assistant "Privacy protection" panel (parity with directChat) ──
        // For Legal/Notebook the PII almost always comes from the SOURCES (doc/KB/
        // tool scans), not the user's chat line — so input PII rarely fires. The
        // tokens the model echoed from those sources are restored for display by
        // `_untok`; surface exactly those (token → real) so the user can SEE what
        // was tokenised. Falls back to the notebook vault's protected-state badge.
        // Skipped when input PII already populated the panel above.
        try {
            if (!_assistantTokenisationInfo) {
                const replaced = (_untok && typeof _untok.getReplacedTokens === 'function') ? _untok.getReplacedTokens() : null;
                if (replaced && replaced.size > 0) {
                    let restoredCount = 0;
                    for (const [, info] of replaced) restoredCount += info.count || 0;
                    // Show the FULL notebook map so the panel's TOKEN MAPPING lists
                    // EVERY value tokenised in this dossier (sources + document +
                    // chat), not just the few echoed in this reply — the user asked
                    // to see all converted values, not only the chat ones.
                    const convMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                    const tokenMap = Object.keys(convMap).length
                        ? { ...convMap }
                        : Object.fromEntries([...replaced].map(([t, i]) => [t, i.value]));
                    const catSet = new Set();
                    for (const tok of Object.keys(tokenMap)) { const mm = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok); if (mm) catSet.add(mm[1]); }
                    _assistantTokenisationInfo = {
                        source: 'restored', action: 'restore', count: Object.keys(tokenMap).length,
                        restoredCount, categories: [...catSet], provider: modelId || null, automatic: true, tokenMap,
                    };
                    send('tokenisation_info', _assistantTokenisationInfo);
                } else {
                    const convMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                    const convEntries = Object.entries(convMap);
                    if (convEntries.length > 0) {
                        const catSet = new Set();
                        for (const [tok] of convEntries) { const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok); if (m) catSet.add(m[1]); }
                        _assistantTokenisationInfo = {
                            source: 'conversation_vault', action: 'protected', count: convEntries.length,
                            categories: [...catSet], provider: modelId || null, automatic: true,
                            tokenMap: Object.fromEntries(convEntries),
                        };
                        send('tokenisation_info', _assistantTokenisationInfo);
                    }
                }
            }
        } catch (_) { /* the panel is best-effort — never break the turn */ }

        // ── Re-restore the AI-written document against the COMPLETE map ──────
        // The mid-turn notebook_doc_* write restored tokens using whatever map
        // existed at that instant. Source/KB/tool tokens minted later this turn
        // would leave the saved document with raw `[person_5]`/`[email]1` even
        // though they are now mapped (the chat reply, restored at end of turn,
        // already shows them real — this brings the document to parity). Re-run
        // the drift-tolerant restore on the TOKEN-space mirror with the final
        // (hydrated) map and re-persist + re-emit only when it actually changed.
        if (_docWritten) {
            try {
                const { restoreTokensInRichText } = require('../../core/privacy/piiDetection');
                const _finalMap = (await dlpRunner.getConversationTokenMapAsync(notebookId).catch(() => null))
                    || dlpRunner.getConversationTokenMap(notebookId) || {};
                if (Object.keys(_finalMap).length) {
                    const realHtml = restoreTokensInRichText(currentDocContent, _finalMap);
                    const realMd = currentDocMd != null ? restoreTokensInRichText(currentDocMd, _finalMap) : null;
                    if (typeof realHtml === 'string' && aiLastWrite && canonicalHtml(aiLastWrite.html) !== canonicalHtml(realHtml)) {
                        // Same rule as the mid-turn write: over the version this
                        // turn wrote, never over someone's newer save.
                        const saved = await persistAiDocWrite(realHtml, realMd, { snapshot: false })
                            .catch(e => { log.error('[NotebookChat] end-of-turn doc re-restore persist failed:', e.message); return { ok: false }; });
                        if (saved.ok) {
                            aiLastWrite = { html: realHtml, markdown: realMd };
                            aiVersionDoc = saved.html ? { html: saved.html, markdown: null } : aiLastWrite;
                            send('notebook_doc_update', { content: realHtml, ...(saved.version != null ? { version: saved.version } : {}) });
                            log.warn('[NotebookChat] 🔓 Document re-restored against final token map');
                        }
                    }
                }
            } catch (e) {
                log.warn('[NotebookChat] end-of-turn doc re-restore failed:', e.message);
            }
            // The state the AI left, as one version attributed to the AI on
            // behalf of this user, and one entry in the project's change feed.
            if (aiVersionDoc) {
                try {
                    const v = await notebookStore.recordVersion(notebookId, {
                        html: aiVersionDoc.html, markdown: aiVersionDoc.markdown, source: 'ai',
                        createdBy: userId, contributors: aiContributors,
                    });
                    if (!v.deduped) {
                        void seams.feed().contentChanged({ projectId: notebook.projectId, notebookId, contributors: aiContributors, versionId: v.id, source: 'ai' });
                    }
                } catch (e) {
                    log.warn('[NotebookChat] could not record the AI version', { notebookId, error: e.message });
                }
            }
        }

        // ── Output Regex Guardrails (agentOutput scope) ──────────────────
        // Check the model's response for guardrail violations; apply redaction
        // or warning. Mirrors directChat.js:3753. Runs against the RESTORED text
        // (displayContent) — regex rules match real values, not `[person_1]`.
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput && displayContent) {
            const outputMatches = checkRegexPatterns(displayContent, regexConfig.rulesWithNames);
            if (outputMatches.length > 0) {
                const ruleNames = outputMatches.map(m => m.ruleName).join(', ');
                log.info(`[NotebookChat RegexGuard] Output violated rules: ${ruleNames}, action: ${regexConfig.action}`);

                if (regexConfig.action === 'redact') {
                    // Redact the output
                    let redactedOutput = displayContent;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redactedOutput = redactedOutput.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip invalid patterns */ }
                    }
                    send('content_redact', {
                        originalMessage: displayContent.slice(0, 500),
                        redactedMessage: redactedOutput.slice(0, 500),
                        rules: ruleNames,
                        autoRedactSeconds: 5
                    });
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgForTiers || null,
                        user_id: userId || null,
                        conversation_id: notebookId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'output',
                        action_taken: 'redacted',
                        source: 'notebook',
                    }).catch(() => {});
                } else {
                    // Block: emit violation warning
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgForTiers || null,
                        user_id: userId || null,
                        conversation_id: notebookId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'output',
                        action_taken: 'blocked',
                        source: 'notebook',
                    }).catch(() => {});
                }
            }
        }

        // Never end a notebook turn with a silent empty bubble. The reasoningEffort
        // fix above prevents the common "thinking consumed the whole budget" case;
        // if content is still empty (and no doc edit was made), emit a clear
        // fallback so the message finalizes instead of hanging on "Thinking…"
        // (BFSF-177).
        if (!fullContent || !fullContent.trim()) {
            const _fallback = "I couldn't produce a response for that. Please try rephrasing your request.";
            send('content', { text: _fallback });
            fullContent = _fallback;
        }

        // ── Persist the turn (audit-grade, encrypted) ──────────────────────
        // In-notebook chat —
        // is now durable: the user message + final assistant answer are appended
        // to the encrypted notebook_conversations blob so the conversation
        // survives a refresh / notebook switch / restart. This is the Dutch-law
        // drafting record for legal matters. Best-effort: a persist failure must
        // never break the response the user just received.
        try {
            const encryptionKey = req.session?.encryptionKey || null;
            const nowIso = new Date().toISOString();
            const userContent = typeof message === 'string' ? message : String(message ?? '');
            const attachmentNames = Array.isArray(attachments)
                ? attachments.map(a => a?.name || a?.filename).filter(Boolean)
                : [];
            // Persist the privacy metadata alongside the turn so the redacted
            // badge + "Privacy protection" panel render identically after a
            // refresh (the blob is JSON, so these extra fields round-trip; GET
            // /conversation returns them and the client reads them). Assistant
            // `content` stays TOKENISED here and is restored on load via the
            // persisted notebook token map (mirrors directChat).
            const userMsg = {
                role: 'user',
                content: userContent,
                createdAt: nowIso,
                ...(attachmentNames.length ? { attachments: attachmentNames } : {}),
            };
            if (piiTokenMap && Object.keys(piiTokenMap).length) {
                userMsg.piiTokenizedCount = Object.keys(piiTokenMap).length;
                userMsg.piiCategories = _userPiiCategories;
            }
            const assistantMsg = { role: 'assistant', content: fullContent || '', createdAt: nowIso, modelId, modelTier };
            if (_assistantTokenisationInfo) assistantMsg.tokenisationInfo = _assistantTokenisationInfo;
            const turn = [userMsg, assistantMsg];
            await notebookConversationStore.appendMessages(notebookId, userId, encryptionKey, turn);
            // Chat is activity: bump the card's recency so the overview reorders.
            notebookStore.touchActivity(notebookId, 'chat').catch(() => {});
        } catch (persistErr) {
            if (persistErr.code === 'HISTORY_LOCKED') {
                // Backstop for a stale client that sends despite the locked
                // banner: the store refused to overwrite the undecryptable
                // envelope. Tell the UI so it can lock the composer.
                log.warn('[NotebookChat] conversation persist refused: history locked (no/wrong session DEK)');
                send('history_locked', { notebookId });
            } else {
                log.error('[NotebookChat] conversation persist failed:', persistErr.message);
            }
        }

        send('done', {});
        res.end();

    } catch (err) {
        log.error('[NotebookChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
module.exports.seams = seams;
