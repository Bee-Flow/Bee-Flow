// @typecheck
/**
 * Resolves a single attachment's `action:'ask'` outcome from
 * scanAttachmentText — pauses the turn (one `dlp_attachment_preview` SSE
 * event + one decisionId, mirroring the text path's `dlp_preview`), awaits
 * the user's choice, and returns a result shaped exactly like every other
 * scanAttachmentText outcome so the caller's existing block/tokenize/pass
 * handling needs no special case for "came from an ask".
 *
 * Scope: one pause per attachment that needs one, resolved sequentially as
 * processAttachments reaches it — NOT batched into one combined review
 * across every attachment in the turn. A turn with several PDFs needing
 * review shows several short pauses in a row rather than one combined
 * screen; simpler and safer than deferring/replaying writes across
 * processAttachments' four different content-append branches, and multi-
 * attachment-with-findings turns are the uncommon case. Shared by both chat
 * surfaces (agent chat via attachmentProcessor.js, direct chat via
 * routes/ai/directChat/attachmentIntake.js) so the pause contract can't drift
 * between them.
 */
const { register } = require('./decisionQueue');
const { applyAttachmentRedactionChoice } = require('./attachmentScanner');
const { bandForConfidence } = require('./confidenceBand');
const dlpRunner = require('./dlpRunner');

/**
 * @param {object} p
 * @param {string} p.text            The (possibly truncated, on an incomplete
 *                                   scan) text scanAttachmentText returned
 *                                   for review — findings' offsets are
 *                                   relative to exactly this string.
 * @param {Array}  p.findings
 * @param {string} p.filename
 * @param {object} [p.provider]      Provider classification, for the modal's "sent to X" line.
 * @param {object} p.orgShield
 * @param {string} [p.conversationId]
 * @param {string} [p.userId]
 * @param {Function} [p.emit]        (type, data) => void — the chat stream's onEvent/send.
 * @param {Function} [p.registerDecision]  decisionQueue.register (injected for tests).
 * @returns {Promise<{action:'block'|'pass'|'tokenize', text:(string|null), findings:Array, summary:object, tokenMap:(object|null), reason?:string}>}
 */
async function resolveAttachmentAsk({ text, findings, filename, provider, orgShield, conversationId, userId, emit, registerDecision }) {
    const reg = registerDecision || register;
    const { decisionId, promise } = reg({ conversationId, userId });

    emit?.('dlp_attachment_preview', {
        decisionId,
        filename,
        provider,
        reviewText: text,
        findings: findings.map((f, i) => ({
            id: `${f.source || 'pii'}_${i}`,
            label: f.label,
            category: f.category,
            source: f.source || 'pii',
            confidence: typeof f.confidence === 'number' ? f.confidence : null,
            confidenceBand: bandForConfidence(f.confidence, orgShield),
            offset: f.offset,
            length: f.length,
            text: f.text,
            page: (typeof f.page === 'number') ? f.page : null,
        })),
        defaultChoice: orgShield?.dlpMode === 'block' ? 'block' : 'redact',
    });

    let decision;
    try {
        decision = await promise;
    } catch (err) {
        // Timeout or abort → fail-closed, same as the text path. A distinct
        // reason from the scanner's own 'timeout' (which means the SCAN
        // couldn't finish) — this means the PERSON didn't answer in time.
        return { action: 'block', reason: err.code === 'DLP_TIMEOUT' ? 'ask_timeout' : 'user_blocked', text: null, findings, summary: { filename }, tokenMap: null };
    }

    if (decision.rememberForConversation && decision.choice !== 'block') {
        dlpRunner.setConversationPref(conversationId, decision.choice);
    }

    if (decision.choice === 'block') {
        return { action: 'block', reason: 'user_blocked', text: null, findings, summary: { filename }, tokenMap: null };
    }
    if (decision.choice === 'allow') {
        return { action: 'pass', text, findings, summary: { filename }, tokenMap: null };
    }

    // 'redact' — merge manual additions, re-sliced from THIS attachment's own
    // review text (never trust client-sent text), before the same
    // splice-and-token-mint path every other attachment redaction uses.
    const manualFindings = (Array.isArray(decision.manualAdditions) ? decision.manualAdditions : [])
        .filter(m => Number.isInteger(m?.offset) && Number.isInteger(m?.length) && m.length > 0
            && m.offset >= 0 && m.offset + m.length <= text.length)
        .map(m => ({
            category: 'UserMarked',
            label: 'UserMarked',
            offset: m.offset,
            length: m.length,
            text: text.slice(m.offset, m.offset + m.length),
            source: 'manual',
            severity: 'high',
        }));
    return applyAttachmentRedactionChoice({
        text, findings: [...findings, ...manualFindings], conversationId, filename,
    });
}

module.exports = { resolveAttachmentAsk };
