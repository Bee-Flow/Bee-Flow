// @typecheck
/**
 * Notebook chat: the Privacy Shield scan helpers one turn shares between the
 * knowledge-base, document and attachment scans (routes/ai/notebookChat.js).
 *
 * Built once per turn over the RESOLVED shield. An abort helper answers the
 * client and ends the response; the caller then returns without sending
 * anything else.
 */

'use strict';

const log = require('../../../telemetry/log');

/**
 * @param {{ docShield: any, notebookId: string, send: Function, res: any }} turn
 */
function makeTurnScans({ docShield, notebookId, send, res }) {
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
        const { composeScan } = require('../../../core/dlp/composeScan');
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
            const { scanAttachmentText } = require('../../../core/dlp/attachmentScanner');
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

    return { _failClosed, _abortFailClosed, _scanViaLedger, _abortBlocked, _scanAttBody };
}

/** What a step returns when it aborted the turn (the response is ended). */
const STOP = Object.freeze({ stop: true });

module.exports = { makeTurnScans, STOP };
