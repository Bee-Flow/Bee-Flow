// @typecheck
/**
 * DLP preflight — the interactive outbound scanner shared by the agent
 * (chatStream) and direct-chat paths.
 *
 * Both paths ran a near-identical ~185-line block: scan the last user message
 * via `dlpRunner.scan`, then proceed / redact / block / pause-to-ask based on
 * the org's `dlpMode`, emitting the same SSE events and writing the same audit
 * rows. A guard fix used to require editing two copies. This module is that one
 * copy.
 *
 * Contract (deliberate, so both callers keep their divergent behavior inline):
 *   - The caller resolves the shield (`resolveOrgShield`) and only calls this
 *     when `dlpEnabled` — this function assumes it should run.
 *   - This function NEVER throws for a policy block and NEVER ends the response.
 *     It emits `dlp_blocked` + audits, then returns `{ blocked: true, reason }`.
 *     The caller decides termination: chatStream throws `DLP_*`; the route does
 *     `send('done'); res.end()`.
 *   - The token-preservation addendum stays at the caller (chatStream appends it
 *     per-iteration; directChat appends it inline once) — this function does not
 *     touch the system prompt.
 *   - On redact it mutates `messages` in place (last user message) and returns
 *     `redactedText` (for chatStream's `processedUserMessage`) and `tokenMap`
 *     (for directChat's `piiTokenMap`).
 *
 * @param {Object}   p
 * @param {Array}    p.messages         Chat messages; last user message redacted in place on 'redact'.
 * @param {Object}   p.resolvedShield   Already-resolved org shield (resolveOrgShield result). Required.
 * @param {string}   [p.orgId]
 * @param {string}   [p.conversationId]
 * @param {string}   [p.userId]
 * @param {*}        [p.model]          Model id used for the `privacy_payload` provider field.
 * @param {Object}   p.providerConfig   { providerType, url, displayName }
 * @param {Function} p.emit             (type, data) => void — onEvent (agent) / send (route).
 * @param {Object}   p.audit            Base fields for logDlpDecision (org/user/agent/model/source).
 * @param {Function} [p.registerDecision] decisionQueue.register (injected for tests).
 * @param {boolean}  [p.hasAttachments]  the turn carries attachments (scanned separately).
 * @returns {Promise<{outcome:'allow'|'redacted'|'blocked'|'scan_failed', blocked:boolean,
 *   reason?:string, tokenMap?:Object, redactedText?:(string|null),
 *   userPrivacyMeta?:Object, assistantTokenisationInfo?:Object}>}
 */
async function runDlpPreflight({
    messages,
    resolvedShield,
    orgId = null,
    conversationId = null,
    userId = null,
    model = null,
    providerConfig,
    emit,
    audit = {},
    registerDecision,
    hasAttachments = false,
}) {
    const dlpRunner = require('./dlpRunner');
    const guardrailEventStore = require('../../stores/guardrailEventStore');
    const register = registerDecision || require('./decisionQueue').register;

    const scanStart = Date.now();
    // Same "Protecting your data… part 3/6" status the PII gate shows. A big
    // paste is minutes of windowed scanning; without a phase the DLP gate is
    // dead air on the stream and indistinguishable from a stall.
    const { startPrivacyScanPhase, messageText } = require('../agentRuntime/phaseEvents');
    const phase = startPrivacyScanPhase(emit, messageText(messages[messages.length - 1]));
    let dlpResult;
    try {
        dlpResult = await dlpRunner.scan({
            messages,
            orgShieldConfig: resolvedShield,
            orgId,
            conversationId,
            providerConfig,
            hasAttachments,
            onProgress: phase.onProgress,
        });
    } finally {
        phase.end();
    }
    const scanMs = Date.now() - scanStart;

    // Both callers' auditBase carried conversation_id; inject it here so the
    // caller-supplied `audit` stays the small org/user/agent/model/source base.
    const auditBase = { conversation_id: conversationId || null, ...audit };
    const categoryList = Object.keys(dlpResult.summary || {}).join(', ') || null;

    // Mutate the last user message with the tokenised text. Returns the applied
    // text (so chatStream can update `processedUserMessage`) or null if nothing
    // was applied — matching the original inline `applyRedactionToMessages`.
    const applyRedactionToMessages = (tokenizedText) => {
        const lastMsg = messages[messages.length - 1];
        if (!lastMsg || lastMsg.role !== 'user') return null;
        if (typeof lastMsg.content === 'string') { lastMsg.content = tokenizedText; return tokenizedText; }
        if (Array.isArray(lastMsg.content)) {
            const textPart = lastMsg.content.find(p => p.type === 'text');
            if (textPart) { textPart.text = tokenizedText; return tokenizedText; }
        }
        return null;
    };

    // Shared redact finalisation (auto + ask-redact differ only in the token
    // source, the `automatic` flag, and `decisionMs`).
    const finalizeRedaction = ({ tokenizedText, tokenMap, automatic, decisionMs, manualCount = 0 }) => {
        const appliedText = applyRedactionToMessages(tokenizedText);
        const dlpCount = Object.keys(tokenMap || {}).length;
        const dlpCats = Object.keys(dlpResult.summary || {});
        // No schema migration for "how many were user-added" (yet) — a
        // suffix on the existing free-text audit column is enough to see it
        // happened without a new column.
        const auditCategoryList = manualCount > 0
            ? `${categoryList || ''}${categoryList ? ', ' : ''}user_added(${manualCount})`
            : categoryList;
        emit?.('dlp_resolved', {
            appliedChoice: 'redact',
            redactedCount: dlpCount,
            provider: dlpResult.provider,
            categories: dlpCats,
            automatic,
            decisionMs,
        });
        const userPrivacyMeta = { dlpRedactedCount: dlpCount, dlpCategories: dlpCats };
        const assistantTokenisationInfo = {
            source: 'dlp',
            action: 'redact',
            count: dlpCount,
            categories: dlpCats,
            provider: dlpResult.provider?.displayName || null,
            automatic,
        };
        if (resolvedShield?.showRawPayload && tokenizedText) {
            emit?.('privacy_payload', {
                tokenizedPrompt: tokenizedText,
                provider: model,
                source: 'dlp',
                timestamp: Date.now(),
            });
            assistantTokenisationInfo.tokenizedPrompt = tokenizedText;
            if (tokenMap && Object.keys(tokenMap).length > 0) {
                emit?.('privacy_token_map', { tokenMap, source: 'dlp' });
                assistantTokenisationInfo.tokenMap = tokenMap;
            }
        }
        guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: auditCategoryList, action_taken: 'redacted' }).catch(() => {});
        return {
            outcome: /** @type {'redacted'} */ ('redacted'),
            blocked: false,
            tokenMap,
            redactedText: appliedText,
            userPrivacyMeta,
            assistantTokenisationInfo,
        };
    };

    if (dlpResult.action === 'block') {
        emit?.('dlp_blocked', {
            findings: dlpResult.findings.map(f => ({ label: f.label, category: f.category, source: f.source })),
            provider: dlpResult.provider,
            reason: dlpResult.reason || 'policy_block',
        });
        guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
        return { outcome: 'blocked', blocked: true, reason: 'policy_block' };
    }

    if (dlpResult.action === 'redact') {
        return finalizeRedaction({
            tokenizedText: dlpResult.redactedText,
            tokenMap: dlpResult.tokenMap,
            automatic: true,
            decisionMs: scanMs,
        });
    }

    if (dlpResult.action === 'ask') {
        const { decisionId, promise } = register({ conversationId, userId });
        const { bandForConfidence } = require('./confidenceBand');
        // The exact text findings' offsets are relative to. Redisplaying it in
        // full to the SAME authenticated SSE connection that just sent it is
        // not a new exposure — it's the user's own data, about to make the
        // next network hop to the LLM provider if they pick "send anyway".
        // Full match text below (was a 3-char preview) for the same reason:
        // without it the user can't judge whether detection did its job,
        // which is the whole point of this pause.
        const reviewText = messageText(messages[messages.length - 1]);
        emit?.('dlp_preview', {
            decisionId,
            provider: dlpResult.provider,
            reviewText,
            findings: dlpResult.findings.map((f, i) => ({
                id: `${f.source}_${i}`,
                label: f.label,
                category: f.category,
                source: f.source,
                confidence: typeof f.confidence === 'number' ? f.confidence : null,
                confidenceBand: bandForConfidence(f.confidence, resolvedShield),
                offset: f.offset,
                length: f.length,
                text: f.text,
                // Kept one release for older clients that still read `.preview`.
                preview: (f.text || '').slice(0, 3) + '…',
            })),
            summary: dlpResult.summary,
            defaultChoice: resolvedShield.dlpMode === 'block' ? 'block' : 'redact',
        });

        let decision;
        try {
            decision = await promise;
        } catch (err) {
            // Timeout or abort → treat as block under fail-closed semantics.
            emit?.('dlp_blocked', { reason: err.code === 'DLP_TIMEOUT' ? 'timeout' : 'rejected', findings: [], provider: dlpResult.provider });
            guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
            return { outcome: 'blocked', blocked: true, reason: 'ask_timeout' };
        }

        if (decision.rememberForConversation && decision.choice !== 'block') {
            dlpRunner.setConversationPref(conversationId, decision.choice);
        }

        if (decision.choice === 'block') {
            emit?.('dlp_blocked', { reason: 'user_blocked', findings: [], provider: dlpResult.provider });
            guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
            return { outcome: 'blocked', blocked: true, reason: 'user_blocked' };
        }

        if (decision.choice === 'redact') {
            // Same string the preview's offsets were relative to (messageText
            // is pure/side-effect-free — the message hasn't been mutated yet).
            const rawText = messageText(messages[messages.length - 1]);
            // Spans the user marked themselves in the review UI ("the detector
            // missed this"). Never trust client-sent text — re-slice from the
            // server's own copy and bounds-check, so a manual addition can't
            // reference content outside what was actually scanned.
            const manualFindings = (Array.isArray(decision.manualAdditions) ? decision.manualAdditions : [])
                .filter(m => Number.isInteger(m?.offset) && Number.isInteger(m?.length) && m.length > 0
                    && m.offset >= 0 && m.offset + m.length <= rawText.length)
                .map(m => ({
                    category: 'UserMarked',
                    label: 'UserMarked',
                    offset: m.offset,
                    length: m.length,
                    text: rawText.slice(m.offset, m.offset + m.length),
                    source: 'manual',
                    severity: 'high',
                }));
            const { tokenizedText, tokenMap } = await dlpRunner.applyRedactionChoice({
                conversationId,
                text: rawText,
                findings: [...dlpResult.findings, ...manualFindings],
            });
            return finalizeRedaction({
                tokenizedText,
                tokenMap,
                automatic: false,
                decisionMs: Date.now() - scanStart,
                manualCount: manualFindings.length,
            });
        }

        // 'allow' — user chose to send raw. Still log (compliance audit).
        emit?.('dlp_resolved', {
            appliedChoice: 'allow',
            redactedCount: 0,
            provider: dlpResult.provider,
            categories: Object.keys(dlpResult.summary || {}),
            automatic: false,
            decisionMs: Date.now() - scanStart,
        });
        guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'allowed' }).catch(() => {});
        return { outcome: 'allow', blocked: false };
    }

    if (dlpResult.scanStatus === 'failed') {
        // fail-open took this path — still record for audit.
        guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: 'scan_failed', action_taken: 'scan_failed' }).catch(() => {});
        return { outcome: 'scan_failed', blocked: false };
    }

    return { outcome: 'allow', blocked: false };
}

module.exports = { runDlpPreflight };
