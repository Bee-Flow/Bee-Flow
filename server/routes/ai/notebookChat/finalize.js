// @typecheck strict
/**
 * Notebook chat: the end of one turn (routes/ai/notebookChat.js), in the
 * order the route runs it: the answer restored for display, the "Privacy
 * protection" panel, the AI-written document re-restored and recorded as a
 * version, the output regex guardrails, the empty-answer fallback and the
 * persisted conversation. `done` is sent by the route.
 */

'use strict';

const log = require('../../../telemetry/log');
const notebookStore = require('../../../stores/notebookStore');
const notebookConversationStore = require('../../../stores/notebookConversationStore');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { checkRegexPatterns } = require('../../../core/privacy/guardrails');
const dlpRunner = require('../../../core/dlp/dlpRunner');
const { canonicalHtml } = require('../../../agents/notebooks/aiDocWriter');
const { fallback, bestEffort } = require('../../../utils/bestEffort');

/**
 * @typedef {(event: string, data: unknown) => void} Send
 * @typedef {ReturnType<typeof import('../../../core/dlp/untokeniseStream').createUntokeniser>} Untokeniser
 * @typedef {import('./inputGates').TokenisationInfo} TokenisationInfo
 * @typedef {{ html: string, markdown: string | null }} DocSnapshot
 * @typedef {ReturnType<typeof import('../../../agents/notebooks/aiDocWriter').makeAiDocWriter>} AiDocWriter
 * @typedef {{ currentDocContent: string, currentDocMd: string | null, written: boolean,
 *   persistAiDocWrite: AiDocWriter['write'], aiContributors: AiDocWriter['contributors'],
 *   aiLastWrite: DocSnapshot | null, aiVersionDoc: DocSnapshot | null }} TurnDoc
 * @typedef {import('../notebookChat').RouterExports['seams']} Seams
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../../../stores/notebookStore').getNotebook>>>} Notebook
 */

/**
 * Un-tokenise the final answer for display.
 * Flush any trailing partial token, then run a full-text restore as a
 * safety net (covers tokens minted very late in the turn / any chunk the
 * streaming un-tokeniser missed). `fullContent` stays TOKENIZED for storage
 * (restored on reload via the persisted map); `displayContent` is what the
 * user sees. Mirrors directChat's end-of-stream content_replace.
 * @param {{ _untok: Untokeniser, fullContent: string, notebookId: string, docPiiTokenMap: Record<string, string> | null,
 *   piiTokenMap: Record<string, string> | null, send: Send }} turn
 * @returns {string} displayContent
 */
function restoreForDisplay({ _untok, fullContent, notebookId, docPiiTokenMap, piiTokenMap, send }) {
    { const _tail = _untok.flush(); if (_tail) send('content', { text: _tail }); }
    let displayContent = fullContent;
    {
        const { restoreTokens } = require('../../../core/privacy/piiDetection');
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
    return displayContent;
}

/**
 * Assistant "Privacy protection" panel (parity with directChat).
 * For Legal/Notebook the PII almost always comes from the SOURCES (doc/KB/
 * tool scans), not the user's chat line — so input PII rarely fires. The
 * tokens the model echoed from those sources are restored for display by
 * `_untok`; surface exactly those (token → real) so the user can SEE what
 * was tokenised. Falls back to the notebook vault's protected-state badge.
 * Skipped when input PII already populated the panel above.
 * @param {{ _assistantTokenisationInfo: TokenisationInfo | null, _untok: Untokeniser, notebookId: string, modelId: string, send: Send }} turn
 * @returns {TokenisationInfo | null} the panel info, as given or newly built
 */
function buildPrivacyPanel({ _assistantTokenisationInfo, _untok, notebookId, modelId, send }) {
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
    } catch (err) { fallback('routes/ai/notebookChat/finalize:buildPrivacyPanel', err); /* the panel is best-effort — never break the turn */ }
    return _assistantTokenisationInfo;
}

/**
 * Re-restore the AI-written document against the COMPLETE map.
 * The mid-turn notebook_doc_* write restored tokens using whatever map
 * existed at that instant. Source/KB/tool tokens minted later this turn
 * would leave the saved document with raw `[person_5]`/`[email]1` even
 * though they are now mapped (the chat reply, restored at end of turn,
 * already shows them real — this brings the document to parity). Re-run
 * the drift-tolerant restore on the TOKEN-space mirror with the final
 * (hydrated) map and re-persist + re-emit only when it actually changed.
 * @param {{ doc: TurnDoc, notebook: Notebook, notebookId: string, userId: string, send: Send, seams: Seams }} turn
 */
async function finishAiDocument({ doc, notebook, notebookId, userId, send, seams }) {
    if (!doc.written) return;
    try {
        const { restoreTokensInRichText } = require('../../../core/privacy/piiDetection');
        const _finalMap = (await dlpRunner.getConversationTokenMapAsync(notebookId).catch((e) => fallback('routes/ai/notebookChat/finalize:finishAiDocument', e, null)))
            || dlpRunner.getConversationTokenMap(notebookId) || {};
        if (Object.keys(_finalMap).length) {
            const realHtml = restoreTokensInRichText(doc.currentDocContent, _finalMap);
            const realMd = doc.currentDocMd != null ? restoreTokensInRichText(doc.currentDocMd, _finalMap) : null;
            if (typeof realHtml === 'string' && doc.aiLastWrite && canonicalHtml(doc.aiLastWrite.html) !== canonicalHtml(realHtml)) {
                // Same rule as the mid-turn write: over the version this
                // turn wrote, never over someone's newer save.
                const saved = await doc.persistAiDocWrite(realHtml, realMd, { snapshot: false })
                    .catch(/** @param {Error} e @returns {Awaited<ReturnType<AiDocWriter['write']>>} */ e => { log.error('[NotebookChat] end-of-turn doc re-restore persist failed:', e.message); return { ok: false }; });
                if (saved.ok) {
                    doc.aiLastWrite = { html: realHtml, markdown: realMd };
                    doc.aiVersionDoc = saved.html ? { html: saved.html, markdown: null } : doc.aiLastWrite;
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
    if (doc.aiVersionDoc) {
        try {
            const v = await notebookStore.recordVersion(notebookId, {
                html: doc.aiVersionDoc.html, markdown: doc.aiVersionDoc.markdown, source: 'ai',
                createdBy: userId, contributors: doc.aiContributors,
            });
            if (!v.deduped) {
                void seams.feed().contentChanged({ projectId: notebook.projectId, notebookId, contributors: doc.aiContributors, versionId: v.id, source: 'ai' });
            }
        } catch (e) {
            log.warn('[NotebookChat] could not record the AI version', { notebookId, error: e.message });
        }
    }
}

/**
 * Output Regex Guardrails (agentOutput scope).
 * Check the model's response for guardrail violations; apply redaction
 * or warning. Mirrors directChat.js:3753. Runs against the RESTORED text
 * (displayContent) — regex rules match real values, not `[person_1]`.
 * @param {{ regexConfig: ReturnType<typeof import('../../../core/privacy/orgShield').mergeWithOrgShield>, displayContent: string,
 *   send: Send, userOrgForTiers: string | null, userId: string, notebookId: string }} turn
 */
function checkOutputRegex({ regexConfig, displayContent, send, userOrgForTiers, userId, notebookId }) {
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
                    } catch (e) { fallback('routes/ai/notebookChat/finalize:checkOutputRegex', e); /* skip invalid patterns */ }
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
                }).catch((e) => bestEffort('routes/ai/notebookChat/finalize:checkOutputRegex#2', e));
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
                }).catch((e) => bestEffort('routes/ai/notebookChat/finalize:checkOutputRegex#3', e));
            }
        }
    }
}

/**
 * Persist the turn (audit-grade, encrypted).
 * In-notebook chat —
 * is now durable: the user message + final assistant answer are appended
 * to the encrypted notebook_conversations blob so the conversation
 * survives a refresh / notebook switch / restart. This is the Dutch-law
 * drafting record for legal matters. Best-effort: a persist failure must
 * never break the response the user just received.
 * @param {{ req: import('express').Request, message: string, attachments: Array<{ name?: string, filename?: string }>,
 *   notebookId: string, userId: string, piiTokenMap: Record<string, string> | null, _userPiiCategories: string[],
 *   fullContent: string, modelId: string, modelTier: string, _assistantTokenisationInfo: TokenisationInfo | null, send: Send }} turn
 */
async function persistTurn({ req, message, attachments, notebookId, userId, piiTokenMap, _userPiiCategories, fullContent, modelId, modelTier, _assistantTokenisationInfo, send }) {
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
        /** @type {{ role: string, content: string, createdAt: string, attachments?: unknown[], piiTokenizedCount?: number, piiCategories?: string[] }} */
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
        /** @type {{ role: string, content: string, createdAt: string, modelId: string, modelTier: string, tokenisationInfo?: TokenisationInfo }} */
        const assistantMsg = { role: 'assistant', content: fullContent || '', createdAt: nowIso, modelId, modelTier };
        if (_assistantTokenisationInfo) assistantMsg.tokenisationInfo = _assistantTokenisationInfo;
        const turn = [userMsg, assistantMsg];
        await notebookConversationStore.appendMessages(notebookId, userId, encryptionKey, turn);
        // Chat is activity: bump the card's recency so the overview reorders.
        notebookStore.touchActivity(notebookId, 'chat').catch((e) => bestEffort('routes/ai/notebookChat/finalize:persistTurn', e));
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
}

module.exports = { restoreForDisplay, buildPrivacyPanel, finishAiDocument, checkOutputRegex, persistTurn };
