// @typecheck noImplicitAny
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

/**
 * @typedef {{ overflow?: boolean, timeout?: boolean, scannedPages?: number, totalPages?: number, truncated?: boolean, sentChars?: number, totalChars?: number, count?: number, mentions?: number, byCategory?: Record<string, number>, pages?: Record<string, Record<string, unknown>>, reason?: string | null }} ScanSummary
 * @typedef {{ action: string, text?: string | null, findings?: import('../dlp/attachmentScanner').AttachmentFinding[], summary?: import('../dlp/attachmentScanner').AttachmentScanSummary, tokenMap?: unknown, reason?: string }} ScanResult
 * @typedef {NonNullable<ReturnType<typeof scanSummaryRow>>} ScanSummaryRow
 * @typedef {Parameters<typeof import('../dlp/attachmentAskFlow').resolveAttachmentAsk>[0]} AskFlowParams
 * @typedef {(args: { text: string, pages?: { pageNumber: number, text: string }[], filename: string }) => Promise<ScanResult>} MaybeScan
 * @typedef {{ attachmentScanner: () => typeof import('../dlp/attachmentScanner'), attachmentAskFlow: () => typeof import('../dlp/attachmentAskFlow') }} ScanGateDlp
 */

/**
 * The summary row fields every outcome shares.
 * @param {ScanSummary} summary
 * @param {string | null} reason
 */
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
 * @param {string} filename
 * @param {ScanResult} r
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
 * @param {{ orgShield: unknown, conversationId: string | null, provider: AskFlowParams['provider'] | null, userId: string | null, emit: AskFlowParams['emit'] | null, registerDecision: AskFlowParams['registerDecision'] | null }} ctx
 * @param {ScanGateDlp} dlp
 */
function createAttachmentScanGate({ orgShield, conversationId, provider, userId, emit, registerDecision }, dlp) {
    // Per-file scan summaries (one row per attachment that produced findings).
    // Returned to the caller so the chat UI badge can show per-file detail
    // and the audit logger can emit per-page rows.
    /** @type {ScanSummaryRow[]} */
    const summaries = [];
    const { scanAttachmentText, AttachmentPrivacyBlock } = dlp.attachmentScanner();
    const { resolveAttachmentAsk } = dlp.attachmentAskFlow();

    /** @type {MaybeScan} */
    async function maybeScan({ text, pages, filename }) {
        if (!orgShield) return { action: 'pass', text };
        /** @type {ScanResult} */
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
 * Call sites must not write `scanned.action === 'tokenize' ? scanned.text :
 * <original>`, which quietly restores the full document on every non-tokenise
 * outcome. That is wrong in a way that leaks: on an incomplete scan the
 * scanner returns a TRUNCATED `text` under `action: 'pass'`, and falling back
 * to the original puts the unchecked pages straight back into the prompt.
 * Prefer whatever the scanner handed back; only fall back when it produced
 * nothing at all (shield disabled, empty input).
 * @param {{ text?: string | null } | null | undefined} scanned
 * @param {string} original
 */
function safeTextOf(scanned, original) {
    return typeof scanned?.text === 'string' ? scanned.text : original;
}

module.exports = { createAttachmentScanGate, safeTextOf };
