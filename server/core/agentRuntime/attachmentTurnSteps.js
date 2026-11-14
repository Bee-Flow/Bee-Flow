// @typecheck strict
/**
 * Streaming agent chat — the steps of processTurnAttachments
 * (attachmentIntake.js) around the attachment processor: what a blocked
 * attachment reports, the Privacy-Shield audits of the scan summaries, the
 * tokenisation record the chat UI reads, and the raw-payload transparency.
 */

'use strict';

const { bestEffort, fallback } = require('../../utils/bestEffort');

/** @typedef {import('./attachmentIntake').AttachmentTokenisationInfo} AttachmentTokenisationInfo */
/** @typedef {import('./attachmentScanGate').ScanSummaryRow} ScanSummaryRow */
/** @typedef {import('../providers/base').OnEvent} OnEvent */
/**
 * @typedef {{ agent: { organization_id?: string | null, name?: string | null }, userId?: string | null, agentId?: string | null,
 *   conversation?: { id?: string } | null, modelToUse: string, config?: { providerName?: string, providerType?: string } | null,
 *   onEvent?: OnEvent }} TurnContext  what the audits and events of a turn need
 */
/** @typedef {{ organization_id: string | null, user_id: string | null, agent_id: string | null, agent_name: string | null, conversation_id: string | null, model: string, source: string }} AuditBase */
/** @typedef {Pick<typeof import('../../stores/guardrailEventStore'), 'logGuardrailEvent' | 'logAttachmentPiiFindings' | 'logAttachmentScanIncomplete'>} GuardrailLedger  what a turn writes to the ledger */
/**
 * @typedef {{
 *   blockAudit(): { attachmentBlockAudit(reason: string | undefined, categories: string[]): { cause: string, violation_categories: string, action_taken: string } },
 *   guardrailEvents(): GuardrailLedger,
 * }} BlockDeps
 */
/** @typedef {Error & { code?: string, filename?: string, reason?: string, summary?: { byCategory?: Record<string, unknown> } }} AttachmentBlock */

/**
 * The line the "processing attachments" phase shows: the file's name, or how many files.
 * @param {Array<{ name?: string } | null | undefined>} attachments
 */
function phaseDetail(attachments) {
    const firstAtt = attachments[0];
    return attachments.length === 1 && firstAtt?.name
        ? firstAtt.name
        : `${attachments.length} files`;
}

/**
 * Who and what a ledger row of this turn is about.
 * @param {TurnContext} turn
 * @returns {AuditBase}
 */
function auditContext({ agent, userId, agentId, conversation, modelToUse, config }) {
    return {
        organization_id: agent.organization_id || null,
        user_id: userId || null,
        agent_id: agentId || null,
        agent_name: agent.name || null,
        conversation_id: conversation?.id || null,
        model: modelToUse,
        source: config?.providerName || config?.providerType || 'LLM',
    };
}

/**
 * A blocked attachment: tell the chat, write the ledger row, and answer the
 * error the turn ends with. Held (scan couldn't cover the input) vs blocked
 * (policy or the person decided) — see attachmentBlockAudit.
 * @param {AttachmentBlock} attErr
 * @param {TurnContext} turn
 * @param {BlockDeps} deps
 */
function reportBlockedAttachment(attErr, turn, deps) {
    const cats = Object.keys(attErr.summary?.byCategory || {});
    const { attachmentBlockAudit } = deps.blockAudit();
    const audit = attachmentBlockAudit(attErr.reason, cats);
    const cause = audit.cause;
    const sseReason = cause === 'pii' ? 'attachment_pii' : `attachment_${cause}`;
    turn.onEvent?.('dlp_blocked', {
        reason: sseReason,
        filename: attErr.filename,
        categories: cats,
        findings: [],
        provider: { isExternal: false, reason: sseReason },
    });
    const guardEvents = deps.guardrailEvents();
    guardEvents.logGuardrailEvent({
        ...auditContext(turn),
        violation_type: 'pii',
        violation_categories: audit.violation_categories,
        direction: 'input',
        action_taken: audit.action_taken,
        attachment_filename: attErr.filename,
        attachment_page: null,
    }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments', e));
    /** @type {Error & { code?: string }} */
    const e = new Error(attErr.message);
    e.code = 'ATTACHMENT_PII_BLOCKED';
    return e;
}

/**
 * Audit for the scanned attachments. A redaction is audited; so is a finding
 * sent unredacted anyway (ask flow "send anyway", or a remembered "allow"),
 * never silent just because nothing was masked; and an incomplete scan that
 * passed through (fail_open), so large-input pass-throughs are measurable.
 * @param {ScanSummaryRow[]} summaries
 * @param {AuditBase} auditBase
 * @param {GuardrailLedger} dlpStore
 */
function auditScanSummaries(summaries, auditBase, dlpStore) {
    for (const s of summaries) {
        if (s.action === 'tokenize') {
            dlpStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'redacted' }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments#2', e));
        }
        if (s.action === 'allowed') {
            dlpStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'allowed' }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments#3', e));
        }
        if (s.reason) {
            dlpStore.logAttachmentScanIncomplete({
                auditBase, filename: s.filename, reason: s.reason,
                scannedPages: s.scannedPages, totalPages: s.totalPages,
                action_taken: s.action === 'tokenize' ? 'partial_redacted' : 'passed_unredacted',
            }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments#4', e));
        }
    }
}

/**
 * Merge per-file detail into the assistant tokenisation info so the chat UI
 * can render the per-attachment badge. A turn that has a record already keeps
 * that object.
 * @param {AttachmentTokenisationInfo | null | undefined} existing
 * @param {ScanSummaryRow[]} summaries
 * @returns {{ info: AttachmentTokenisationInfo, aggCount: number, aggCats: Set<string> }}
 */
function mergeScanSummaries(existing, summaries) {
    const aggCount = summaries.reduce((a, s) => a + (s.count || 0), 0);
    /** @type {Set<string>} */
    const aggCats = new Set();
    for (const s of summaries) {
        for (const c of Object.keys(s.byCategory || {})) aggCats.add(c);
    }
    const info = existing || {
        source: 'privacy_shield',
        action: 'redact',
        count: 0,
        categories: [],
        automatic: true,
    };
    info.attachments = summaries;
    info.count = (info.count || 0) + aggCount;
    const catSet = new Set([...(info.categories || []), ...aggCats]);
    info.categories = [...catSet];
    return { info, aggCount, aggCats };
}

/**
 * The text of the turn's last message as the model received it.
 * @param {{ content?: unknown } | null | undefined} lastMsg
 */
function flatPromptText(lastMsg) {
    if (Array.isArray(lastMsg?.content)) {
        return lastMsg.content
            .filter((/** @type {{ type?: string, text?: unknown } | null} */ p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((/** @type {{ text: string }} */ p) => p.text)
            .join('\n');
    }
    return typeof lastMsg?.content === 'string' ? lastMsg.content : '';
}

/**
 * Raw-payload transparency for attachments (only when the org opted in).
 * Lets the user verify the exact tokenised text the model received: the
 * "Sent to AI" pane of the privacy panel. Best-effort.
 * @param {{ lastMsg: { content?: unknown } | null | undefined, modelToUse: string, conversation?: { id?: string } | null, onEvent?: OnEvent }} turn
 * @param {AttachmentTokenisationInfo} info
 * @param {{ dlpRunner(): { getConversationTokenMap(conversationId: string | undefined): Record<string, string> | null | undefined } }} deps
 */
function showRawPayload({ lastMsg, modelToUse, conversation, onEvent }, info, deps) {
    try {
        const flat = flatPromptText(lastMsg);
        if (flat) {
            onEvent?.('privacy_payload', {
                tokenizedPrompt: flat,
                provider: modelToUse,
                source: 'privacy_shield',
                timestamp: Date.now(),
            });
            info.tokenizedPrompt = flat;
        }
        const _convMap = deps.dlpRunner().getConversationTokenMap(conversation?.id);
        if (_convMap && Object.keys(_convMap).length > 0) {
            onEvent?.('privacy_token_map', { tokenMap: _convMap, source: 'privacy_shield' });
            info.tokenMap = _convMap;
        }
    } catch (err) { fallback('core/agentRuntime/attachmentIntake:processTurnAttachments#5', err); /* transparency is best-effort */ }
}

module.exports = { phaseDetail, auditContext, reportBlockedAttachment, auditScanSummaries, mergeScanSummaries, showRawPayload };
