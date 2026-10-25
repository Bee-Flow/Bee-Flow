/**
 * Notebook Chat — AI chat with full tool support
 *
 * Tools available:
 * - notebook_doc_read/write/replace: Read and modify the TipTap document editor
 * - agent_search: Web research
 * - notebook_add_source: Add web search results directly as notebook sources
 *
 * This file is the route and the order of one turn. The steps live in
 * ./notebookChat/: privacyScans (the shield scan helpers), context (KB
 * passages, document, selection, system prompt), inputGates (history, user
 * message, Unicode / PII / regex gates), toolLoop (tool rounds and the tool
 * executor) and finalize (display restore, privacy panel, document version,
 * output guardrails, persistence).
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
router.use(require('../../stores/lib/documentCrypto').withDocumentEncryptionSession);
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const notebookStore = require('../../stores/notebookStore');
const { openSse } = require('../../core/http/sseHelpers');

const { htmlToMarkdown } = require('../../core/markdown');
const { emitPhase, emitPhaseEnd } = require('../../core/agentRuntime/phaseEvents');
const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
const { resolveTurnTier } = require('../../core/llm/resolveTurnModel');

require('../../core/entitlements/betaFeatures');

// ── Guardrails (parity with direct chat) ─────────────────────────────
const { resolveShieldFor } = require('../../core/privacy/orgShield');

// ── PII tokenization round-trip (parity with direct chat) ────────────
// The notebook path tokenizes inbound (doc body + user message) but historically
// never restored outbound, so `[person_1]` leaked into the chat + the editor and
// the token map was never persisted. These finish the round-trip: un-tokenise the
// stream for display, teach the model to preserve tokens, and re-tokenise history.
const dlpRunner = require('../../core/dlp/dlpRunner');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
// The chat engine's bag: typed, not closed (see routes/ai/directChat/turnSchema.js).
const { NotebookTurnBody } = require('./directChat/turnSchema');
const notebookCollab = require('../../agents/notebooks/notebookCollab');
const { makeAiDocWriter } = require('../../agents/notebooks/aiDocWriter');
const { makeNotebookFeed } = require('../../agents/notebooks/notebookFeed');
const { hasNotebookRole } = require('../notebooksAccess');
const { createToolRepeatGuard } = require('../../core/agentRuntime/toolRepeatGuard');

const { makeTurnScans } = require('./notebookChat/privacyScans');
const {
    retrieveKbContext, buildDocumentContext, buildSelectionContext, isSearchAvailable, buildSourceSummary, buildSystemPrompt,
} = require('./notebookChat/context');
const {
    appendHistory, appendUserMessage, stripUnicodeSmuggling, runInputPiiGate, addTokenPreservation, runInputRegex,
} = require('./notebookChat/inputGates');
const { buildToolList, buildChatOptions, makeNotebookToolExecutor, runToolLoop } = require('./notebookChat/toolLoop');
const { restoreForDisplay, buildPrivacyPanel, finishAiDocument, checkOutputRegex, persistTurn } = require('./notebookChat/finalize');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Collaborators a test swaps on this object (testUtils/swaps.js). The
 * co-editing facade is resolved at call time.
 */
const seams = {
    collab: () => notebookCollab.defaultFacade(),
    feed: () => makeNotebookFeed(),
};

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

    // Which tier: core/llm/resolveTurnModel — `standard` is read as `fast`,
    // `auto` is classified, a tier the person's groups do not allow is refused.
    const turnTier = await resolveTurnTier({
        modelTier, message, tiers, userId, userOrgId: userOrgForTiers,
        surface: 'NotebookChat', standardIsFast: true,
    });
    if (turnTier.refusal) return res.status(turnTier.refusal.status).json({ error: turnTier.refusal.error, code: turnTier.refusal.code });
    const resolvedTier = turnTier.tier;

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
        throw new HttpError(400, 'bad_request', providerErr.message);
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    log.info(`[NotebookChat] Model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''}) for notebook ${notebook.id} (${readySources.length} sources)`);

    // Keep the stream warm through the NC AppAPI proxy during long reasoning /
    // doc-edit turns so it isn't idle-timed-out into a 504 (BFSF-221/177).
    // One abort signal per turn, tripped when the client disconnects (the Stop
    // button closes the EventSource). Without this the tool loop kept running
    // after Stop and a notebook_doc_write still landed in the database — the
    // user cancelled and the document changed anyway, with no undo in the UI.
    const { send, signal: turnSignal, isGone } = openSse(res, { heartbeat: true, tag: 'NotebookChat' });
    const aborted = () => isGone() || turnSignal.aborted;

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
        try { await dlpRunner.getConversationTokenMapAsync(notebookId); } catch (err) { bestEffort('routes/ai/notebookChat:anon', err); /* best-effort */ }
        // Resolve the Privacy Shield ONCE — respect-the-shield: tokenization
        // only runs when it is enabled. The RESOLVED shape, never the stored
        // org document: a personal account (no org) has only a user-level
        // shield, which the stored-document read never saw, so its document,
        // KB passages, attachments and typed message reached the model
        // unscanned (the direct-chat equivalent was BFSF-290/291). The
        // resolved shape also carries the tier clamps and the documented
        // fail_closed default. Used by the KB, document, attachment and
        // message scans, the regex rules below, and the tool block lists
        // (BFSF-354).
        const orgShieldConfig = await resolveShieldFor({ orgId: userOrgForTiers, userId });
        const docShield = orgShieldConfig;
        const toolPiiGate = require('../../core/privacy/toolPiiGate');
        const scans = makeTurnScans({ docShield, notebookId, send, res });

        // Per-turn guard: the same read-only call twice, or a passage already in
        // the prompt, is not served again (see core/agentRuntime/toolRepeatGuard).
        const repeatGuard = createToolRepeatGuard({ readOnlyTools: ['notebook_kb_search', 'notebook_doc_read'] });
        // Search notebook knowledge base for relevant context
        const kb = await retrieveKbContext({
            req, notebook, userId, message, readySources, send, notebookId,
            docShield, orgShieldConfig, toolPiiGate, repeatGuard, scans,
        });
        if (kb.stop) return;
        const { kbIds, kbContext } = kb;

        // If the document was too large to inline in the prompt, tell the UI so
        // it can show a one-shot banner. The client-side handler decides whether
        // to suppress repeat banners for the same conversation turn.
        // Emitted AFTER the systemPrompt build below uses `documentTruncation` —
        // so the announcement is deferred until we've actually committed to it.

        // Build source summary
        const sourceSummary = buildSourceSummary(readySources);

        const docCtx = await buildDocumentContext({ documentContent, notebook, notebookId, docShield, scans });
        if (docCtx.stop) return;
        const { documentContext, documentTruncation, docPiiTokenMap, scannedDocumentContent } = docCtx;

        const selectionContext = buildSelectionContext(notebookSelection);

        // Build system prompt
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Compute search availability before the system prompt uses it
        const searchAvailable = await isSearchAvailable();

        // ── Build system prompt ──────────────────────────────────────
        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        const systemPrompt = buildSystemPrompt({
            today, notebook, sourceSummary, searchAvailable, kbContext, documentContext, selectionContext, timezone,
        });
        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);

        // Announce document truncation to the client now that we've finalised
        // the system prompt. One event per turn — the UI debounces banners.
        if (documentTruncation) {
            send('document_truncated', documentTruncation);
        }

        let messages = [{ role: 'system', content: systemPrompt }];
        appendHistory(messages, history);
        const userTurn = await appendUserMessage({ messages, message, attachments, adapter, modelId, scans });
        if (userTurn?.stop) return;

        // ── Input gates: Unicode smuggling (FIRST), PII, token addendum, regex ──
        stripUnicodeSmuggling({ messages, send, userOrgForTiers, userId, notebookId });
        const pii = await runInputPiiGate({ messages, docShield, notebookId, modelId, send, res });
        if (pii.stop) return;
        const { piiTokenMap, _userPiiCategories } = pii;
        let { _assistantTokenisationInfo } = pii;
        addTokenPreservation(messages, notebookId);
        const inputRegex = runInputRegex({ orgShieldConfig, messages, message, send, res, userOrgForTiers, userId, notebookId });
        if (inputRegex.stop) return;
        const { regexConfig } = inputRegex;

        // ── Build tool list ──────────────────────────────────────────
        const notebookTools = buildToolList({ canWrite, kbIds, searchAvailable });

        // ── Tool calling loop ────────────────────────────────────────
        const chatOptions = buildChatOptions({ tiers, resolvedTier, requestedEffort: req.body.reasoningEffort });

        // Track mutable document content (HTML for the client) + its Markdown
        // mirror (token-efficient source the doc tools read/edit) across rounds.
        // CRITICAL: seed the mirror in TOKEN-space when the doc was tokenized, so
        // it matches what the model sees in the system prompt (scannedDocumentContent).
        // Otherwise notebook_doc_read returns RAW text while the model's find_text
        // was written against the tokenized text it saw → notebook_doc_replace misses.
        // Seed from the CLIENT's live document whenever it sent one. The stored
        // `notebook.documentMd` lags the editor by up to the autosave debounce,
        // so preferring it meant notebook_doc_read handed the model a stale
        // document — and the write that followed replaced the user's newer text
        // with an edit computed against the old version.
        // `written` is set when any notebook_doc_* tool wrote this turn. The
        // mid-turn write restores tokens against whatever map existed at that
        // instant; tokens minted LATER in the same turn (source/KB/tool-result
        // scans) would otherwise leave the saved document with raw
        // `[person_5]`/`[email]1`. We re-restore the document once at end of
        // turn against the COMPLETE map.
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
        const doc = {
            currentDocContent: scannedDocumentContent || documentContent || '',
            currentDocMd: docPiiTokenMap
                ? htmlToMarkdown(scannedDocumentContent)
                : (documentContent ? htmlToMarkdown(documentContent) : (notebook.documentMd || '')),
            written: false,
            persistAiDocWrite: aiWriter.write,
            aiContributors: aiWriter.contributors,
            aiLastWrite: null,   // { html, markdown } of the last applied AI edit (the model's view, real values)
            aiVersionDoc: null,  // the document the AI left: aiLastWrite, or the live merge of it
        };

        const executeNotebookTool = makeNotebookToolExecutor({
            doc, canWrite, aborted, notebook, notebookId, userId, userOrgForTiers, sources, kbIds, readySources, send, seams,
        });

        let { fullContent, _untok } = await runToolLoop({
            messages, notebookTools, chatOptions, executeNotebookTool, repeatGuard, toolPiiGate,
            adapter, apiKey, apiUrl, modelId, turnSignal, aborted, send,
            notebookId, userId, userOrgForTiers, docShield, orgShieldConfig,
        });

        const displayContent = restoreForDisplay({ _untok, fullContent, notebookId, docPiiTokenMap, piiTokenMap, send });
        _assistantTokenisationInfo = buildPrivacyPanel({ _assistantTokenisationInfo, _untok, notebookId, modelId, send });
        await finishAiDocument({ doc, notebook, notebookId, userId, send, seams });
        checkOutputRegex({ regexConfig, displayContent, send, userOrgForTiers, userId, notebookId });

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

        await persistTurn({
            req, message, attachments, notebookId, userId, piiTokenMap, _userPiiCategories,
            fullContent, modelId, modelTier, _assistantTokenisationInfo, send,
        });

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

/**
 * @typedef {import('express').Router & { seams: typeof seams }} RouterExports
 */
