/**
 * Direct Chat: the Privacy Shield side of attachment intake. Resolves the
 * shield for the turn, scans each extracted document (tokenise / ask / block /
 * pass), and after the loop audits and surfaces what the scan did. Split out
 * of attachmentIntake.js; behaviour unchanged.
 */

const configStore = require('../../../stores/configStore');
const log = require('../../../telemetry/log');

/**
 * Resolve Privacy Shield once for the whole attachment loop so each extracted
 * document is scanned for PII before it enters the model prompt. Mirrors the
 * agent-chat path (attachmentProcessor.js). Returns the user's org id (for the
 * audit rows) and the shield config.
 */
async function resolveAttachmentShield(req) {
    const { resolveUserOrgIds } = require('../../../auth');
    const userOrgIds = await resolveUserOrgIds(req).catch(() => null);
    const userOrgId = (userOrgIds && userOrgIds.size > 0) ? Array.from(userOrgIds)[0] : null;
    const { resolveShieldFor } = require('../../../core/privacy/orgShield');
    let shield = await resolveShieldFor({ orgId: userOrgId, userId: req.session?.user?.id });
    // Super-admin edge case (mirrors the input-gate fallback): the seed admin
    // account has no organizationId binding and the attachment scanner would
    // otherwise silently no-op for them, so PDF/DOCX uploads leak unredacted
    // to the model. Fall back to the sole org shield when exactly one exists.
    if (!shield?.enabled && req.session?.isAdmin) {
        try {
            const allCfg = await configStore.getAllConfig() || {};
            const shieldKeys = Object.keys(allCfg).filter(k => k.startsWith('org_privacy_shield_'));
            if (shieldKeys.length === 1 && allCfg[shieldKeys[0]]?.enabled) {
                shield = allCfg[shieldKeys[0]];
                log.info(`[DirectChat] Attachment scanner: super-admin fallback → sole org shield ${shieldKeys[0]}`);
            }
        } catch (err) { log.debug('non-fatal', err); }
    }
    return { userOrgId, shield };
}

/** The per-file summary row the UI and the audit read, for one scan outcome. */
function scanSummaryRow(filename, action, summary) {
    const base = action === 'pass'
        ? { count: 0, mentions: 0, byCategory: {}, pages: {}, reason: summary.reason }
        : action === 'allowed'
            ? { count: summary.count || 0, mentions: summary.mentions || 0, byCategory: summary.byCategory || {}, pages: summary.pages || {}, reason: summary.reason || null }
            // DISTINCT values, matching the token-mapping rows, not
            // r.findings.length (occurrences). Every text path already reports
            // Object.keys(tokenMap).length, and the client sums the two into
            // one badge, so mixing units produced `spans + unique_values`.
            : { count: summary.count, mentions: summary.mentions, byCategory: summary.byCategory, pages: summary.pages, reason: summary.reason || null };
    return {
        filename,
        action,
        count: base.count,
        mentions: base.mentions,
        byCategory: base.byCategory,
        pages: base.pages,
        overflow: !!summary.overflow,
        timeout: !!summary.timeout,
        reason: base.reason,
        scannedPages: summary.scannedPages,
        totalPages: summary.totalPages,
        truncated: !!summary.truncated,
        sentChars: summary.sentChars,
        totalChars: summary.totalChars,
    };
}

/**
 * Build the scan function the per-format branches call, so they don't repeat
 * the tokenise/block/pass switch. It returns the text to inline (possibly
 * tokenised) or throws AttachmentPrivacyBlock for the intake to catch. The
 * conversation was created eagerly, so `convId` is non-null and the scanner's
 * internal `dlpRunner.mergeTokenMap(convId, tokenMap)` lands in the right map.
 */
function makeAttachmentScanner({ shield, config, convId, userId, send, summaries }) {
    const { scanAttachmentText, AttachmentPrivacyBlock } = require('../../../core/dlp/attachmentScanner');
    const { resolveAttachmentAsk } = require('../../../core/dlp/attachmentAskFlow');
    const { classifyProvider } = require('../../../core/providers/classification');
    const provider = classifyProvider(config || {}, shield?.dlpAllowlistedHosts || []);
    return async (text, pages, filename) => {
        if (!shield || !text) return text;
        let r = await scanAttachmentText({ text, pages, filename, orgShield: shield, conversationId: convId, allowAsk: true });
        if (r.action === 'ask') {
            // Pauses the turn until the person answers (one pause per
            // attachment needing one, see attachmentAskFlow.js).
            r = await resolveAttachmentAsk({
                text: r.text, findings: r.findings, summary: r.summary, filename, provider,
                orgShield: shield, conversationId: convId, userId, emit: send,
            });
        }
        if (r.action === 'block') throw new AttachmentPrivacyBlock({ filename, summary: r.summary, findings: r.findings, reason: r.reason });
        if (r.action === 'tokenize') {
            summaries.push(scanSummaryRow(filename, 'tokenize', r.summary));
            return r.text;
        }
        if (r.action === 'pass' && r.findings?.length > 0) {
            // Found something but sent it unredacted anyway (ask flow "send
            // anyway", or a remembered "allow"). Never silent.
            summaries.push(scanSummaryRow(filename, 'allowed', r.summary));
            return r.text;
        }
        if (r.summary && r.summary.reason) {
            // Incomplete scan, nothing found in the scanned prefix: the checked
            // part travels, the rest was cut. Surface it (amber warning +
            // audit), never silently. r.text is the truncated document on this
            // path; returning the original would put the unchecked tail back in.
            summaries.push(scanSummaryRow(filename, 'pass', r.summary));
            return r.text;
        }
        return text;
    };
}

function auditBaseFor({ userOrgId, userId, conversationId, config, modelId }) {
    return {
        organization_id: userOrgId || null,
        user_id: userId || null,
        conversation_id: conversationId || null,
        source: config?.providerName || config?.providerType || 'LLM',
        model: modelId || null,
    };
}

/** A blocked attachment: tell the client, write the audit row (best-effort). */
async function reportAttachmentBlock(attErr, { send, userOrgId, userId, conversationId, config, modelId }) {
    const cats = Object.keys(attErr.summary?.byCategory || {});
    const { attachmentBlockAudit } = require('../../../core/dlp/attachmentBlockAudit');
    const audit = attachmentBlockAudit(attErr.reason, cats);
    const cause = audit.cause;
    const sseReason = cause === 'pii' ? 'attachment_pii' : `attachment_${cause}`;
    send('dlp_blocked', {
        reason: sseReason,
        filename: attErr.filename,
        categories: cats,
        findings: [],
        provider: { isExternal: false, reason: sseReason },
    });
    try {
        const guardrailEventStore = require('../../../stores/guardrailEventStore');
        const base = auditBaseFor({ userOrgId, userId, conversationId, config, modelId });
        await guardrailEventStore.logGuardrailEvent({
            organization_id: base.organization_id,
            user_id: base.user_id,
            conversation_id: base.conversation_id,
            violation_type: 'pii',
            violation_categories: audit.violation_categories,
            direction: 'input',
            action_taken: audit.action_taken,
            source: base.source,
            model: base.model,
            attachment_filename: attErr.filename,
            attachment_page: null,
        });
    } catch (err) { log.debug('audit best-effort', err); }
}

/** Audit rows for tokenised, allowed and incompletely scanned attachments. */
async function auditScanSummaries(summaries, auditCtx) {
    if (summaries.length === 0) return;
    try {
        const guardrailEventStore = require('../../../stores/guardrailEventStore');
        const auditBase = auditBaseFor(auditCtx);
        for (const s of summaries) {
            if (s.action === 'tokenize') {
                await guardrailEventStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'redacted' });
            }
            if (s.action === 'allowed') {
                await guardrailEventStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'allowed' });
            }
            if (s.reason) {
                await guardrailEventStore.logAttachmentScanIncomplete({
                    auditBase, filename: s.filename, reason: s.reason,
                    scannedPages: s.scannedPages, totalPages: s.totalPages,
                    action_taken: s.action === 'tokenize' ? 'partial_redacted' : 'passed_unredacted',
                });
            }
        }
    } catch (err) { log.debug('audit best-effort', err); }
}

/**
 * Live SSE notification so the UI shows the privacy badge immediately, not
 * just after a page reload. Re-uses the `pii_tokenized` event shape so the
 * client handler (useChatEngine.js: case 'pii_tokenized') ingests message-
 * level and attachment-level findings the same way. When the org enabled
 * "Show raw payload & token mapping", also push the exact tokenised text the
 * model receives and the merged token map (the "Sent to AI" pane).
 */
function surfaceScanSummaries(summaries, { send, shield, contentParts, modelId, convId }) {
    const aggCount = summaries.reduce((a, s) => a + (s.count || 0), 0);
    const aggCats = new Set();
    for (const s of summaries) {
        for (const c of Object.keys(s.byCategory || {})) aggCats.add(c);
    }
    if (aggCount > 0 || summaries.some(s => s.timeout || s.reason)) {
        send('pii_tokenized', {
            // Synthesise an entities-shaped list so the existing
            // pii_tokenized handler picks the categories up.
            entities: [...aggCats].map(label => ({ label, category: label })),
            tokenCount: aggCount,
            attachments: summaries,
            source: 'privacy_shield',
        });
    }
    if (!(aggCount > 0 && shield?.showRawPayload)) return;
    try {
        const flat = contentParts
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
        if (flat) {
            send('privacy_payload', {
                tokenizedPrompt: flat,
                provider: modelId,
                source: 'privacy_shield',
                timestamp: Date.now(),
            });
        }
        const dlpRunner = require('../../../core/dlp/dlpRunner');
        // `convId`, NOT `conversationId`. On the first message of a new chat
        // `conversationId` is still null: the id only exists because the
        // eager-create block minted it into `convId`, which is also what the
        // scanner merged the attachment tokens under. Reading the request-
        // scoped variable returned an empty map, so a PDF uploaded into a
        // fresh conversation showed no TOKEN MAPPING at all.
        const convMap = dlpRunner.getConversationTokenMap(convId);
        if (convMap && Object.keys(convMap).length > 0) {
            send('privacy_token_map', { tokenMap: convMap, source: 'privacy_shield' });
        }
    } catch (err) { log.debug('transparency is best-effort', err); }
}

module.exports = {
    resolveAttachmentShield,
    makeAttachmentScanner,
    reportAttachmentBlock,
    auditScanSummaries,
    surfaceScanSummaries,
};
