// @typecheck
/**
 * The Privacy Shield gate over extracted attachment text, for
 * ./attachmentProcessor: scan, ask the person when the policy says so, block,
 * and collect a per-file summary row for every outcome that must not be
 * silent.
 *
 * The scanner and the ask flow come in as `dlp` ({ attachmentScanner(),
 * attachmentAskFlow() }, lazy, handed in by ./attachmentProcessor): they sit
 * in the server's large import cycle, which this module stays out of.
 */

/** The summary row fields every outcome shares. */
function summaryTail(summary, reason) {
    return {
        overflow: !!summary.overflow,
        timeout: !!summary.timeout,
        reason,
        scannedPages: summary.scannedPages,
        totalPages: summary.totalPages,
        truncated: !!summary.truncated,
        sentChars: summary.sentChars,
        totalChars: summary.totalChars,
    };
}

/**
 * The per-file summary row for a scan result, or null when the outcome needs
 * none (a clean, complete pass).
 */
function scanSummaryRow(filename, r) {
    if (r.action === 'tokenize') {
        return {
            filename,
            action: 'tokenize',
            // DISTINCT values (= token-mapping rows), not occurrences —
            // kept in the same unit as every text path so the client can
            // sum them into one badge without mixing units.
            count: r.summary.count,
            mentions: r.summary.mentions,
            byCategory: r.summary.byCategory,
            pages: r.summary.pages,
            ...summaryTail(r.summary, r.summary.reason || null),
        };
    }
    if (r.action === 'pass' && r.findings?.length > 0) {
        // Found something but sent it unredacted anyway — either the ask
        // flow's "send anyway" or a remembered "allow" (dlpRunner's
        // pass_through). Never silent: surfaced the same way an
        // incomplete-scan pass-through already is, so the badge and the
        // audit trail both show it.
        return {
            filename,
            action: 'allowed',
            count: r.summary.count || 0,
            mentions: r.summary.mentions || 0,
            byCategory: r.summary.byCategory || {},
            pages: r.summary.pages || {},
            ...summaryTail(r.summary, r.summary.reason || null),
        };
    }
    if (r.summary && r.summary.reason) {
        // Incomplete scan (overflow / timeout / degraded), nothing found in
        // the scanned prefix: the checked part travels, the unchecked tail
        // was cut. SURFACE it (amber warning + audit), never silently.
        return {
            filename,
            action: 'pass',
            count: 0,
            mentions: 0,
            byCategory: {},
            pages: {},
            ...summaryTail(r.summary, r.summary.reason),
        };
    }
    return null;
}

/**
 * A scanner bound to this turn. `maybeScan({ text, pages, filename })`
 * resolves to the scan result (`{ action: 'pass', text }` when there is no
 * shield) and pushes a row onto `summaries` when the outcome needs one; a
 * block throws AttachmentPrivacyBlock.
 */
function createAttachmentScanGate({ orgShield, conversationId, provider, userId, emit, registerDecision }, dlp) {
    // Per-file scan summaries (one row per attachment that produced findings).
    // Returned to the caller so the chat UI badge can show per-file detail
    // and the audit logger can emit per-page rows.
    const summaries = [];
    const { scanAttachmentText, AttachmentPrivacyBlock } = dlp.attachmentScanner();
    const { resolveAttachmentAsk } = dlp.attachmentAskFlow();

    async function maybeScan({ text, pages, filename }) {
        if (!orgShield) return { action: 'pass', text };
        let r = await scanAttachmentText({ text, pages, filename, orgShield, conversationId, allowAsk: true });
        if (r.action === 'ask') {
            // Pauses the turn until the person answers — see attachmentAskFlow.js
            // for why this is one pause per attachment rather than a combined
            // batch. `r.text` here may already be a truncated review text (an
            // incomplete scan under fail_open), which is exactly what gets shown.
            r = await resolveAttachmentAsk({
                text: r.text, findings: r.findings, summary: r.summary, filename, provider, orgShield, conversationId, userId, emit, registerDecision,
            });
        }
        if (r.action === 'block') {
            // reason ∈ {pii, overflow, timeout, degraded, user_blocked, ask_timeout}
            // → chatStream/attachmentIntake picks the right dlp_blocked copy.
            throw new AttachmentPrivacyBlock({ filename, summary: r.summary, findings: r.findings, reason: r.reason });
        }
        const row = scanSummaryRow(filename, r);
        if (row) summaries.push(row);
        return r;
    }

    return { maybeScan, summaries };
}

/**
 * The text that may actually leave the platform for a scanned attachment.
 *
 * Call sites used to write `scanned.action === 'tokenize' ? scanned.text :
 * <original>`, which quietly restored the full document on every non-tokenise
 * outcome. That is now wrong in a way that leaks: on an incomplete scan the
 * scanner returns a TRUNCATED `text` under `action: 'pass'`, and falling back
 * to the original put the unchecked pages straight back into the prompt.
 * Prefer whatever the scanner handed back; only fall back when it produced
 * nothing at all (shield disabled, empty input).
 */
function safeTextOf(scanned, original) {
    return typeof scanned?.text === 'string' ? scanned.text : original;
}

module.exports = { createAttachmentScanGate, safeTextOf };
