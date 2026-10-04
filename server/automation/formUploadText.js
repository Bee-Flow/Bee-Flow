/**
 * The TEXT of a file a visitor attached to an automation's form.
 *
 * A `file` field's submitted value is the descriptor
 * `{ kind:'form_upload', fileId, filename, mimeType, size, storageKey }`
 * (formTriggerContract). That descriptor is a RECEIPT: it says a file exists and
 * where its bytes live. For a long time it was all a run ever got — which made
 * the field close to useless. An automation could be told "the visitor attached
 * jaarrekening.xlsx" and had no step in the entire vocabulary that could open
 * it: no integration_action takes a form fileId, and an ai_step binding
 * `trigger.output.<field>` handed the model a JSON receipt to reason over
 * instead of a spreadsheet.
 *
 * Every OTHER surface that receives a document already reads it the same way —
 * a Gmail attachment (gmail_read_attachment), a Nextcloud file
 * (nextcloud_read_file), an App Studio upload (appStudio/aiRuntime), a document
 * an automation generated and sent to Notebooks — all of them go through
 * core/documents/documentParser. The form upload was the one that did not.
 *
 * So the descriptor now carries `text` too: the same extraction, run once, at
 * the moment a submission CLAIMS the upload. `trigger.output.<field>.text` is a
 * workbook as one markdown table per sheet, a PDF as its text layer, a Word
 * file as prose — the thing an ai_step can actually reason over.
 *
 * Three properties, each of which is why this is a module and not four lines
 * inlined at the two call sites:
 *
 *   • It NEVER fails the submission. Someone who attached a corrupt workbook
 *     still gets their run; the descriptor carries `textError` instead of
 *     `text`, and the automation can branch on it. Dropping a submission because a
 *     parser threw would be a far worse failure than an unreadable attachment,
 *     and the visitor — who is anonymous and gone — cannot be asked to retry.
 *   • It is BOUNDED TWICE, on different things. `MAX_PARSE_BYTES` is what we
 *     will pull into memory at all; `MAX_TEXT_CHARS` is what we will carry INTO
 *     the run. They are not the same cap: a 3 MB workbook is small enough to
 *     read and renders to megabytes of markdown, and that text would then ride
 *     in the trigger payload through every step for the rest of the run.
 *     Truncation is ANNOUNCED (`textTruncated`), because a model given the first
 *     60k characters of a ledger must not be told it saw the ledger.
 *   • It runs at exactly one place per claim site, through the same function.
 *     The trigger's own page and a later form_page build this descriptor in two
 *     different handlers, and a `text` that appeared on page one but not page
 *     two is precisely the kind of difference nobody finds until a demo.
 *
 * Deliberately NOT here: images. parseDocument's final branch is
 * `buffer.toString('utf-8')`, so an unrecognised type is returned as mojibake
 * rather than refused — which for a PNG means a megabyte of binary noise in the
 * trigger payload. `isSupportedDocument` is the gate, and anything it rejects
 * gets an honest `textError` saying so.
 */

'use strict';

const { isSupportedDocument } = require('../core/documents/documentParser');
const log = require('../telemetry/log');

/**
 * What we will read into memory to parse at all.
 *
 * Lower than the form's own per-field ceiling (formTriggerContract's
 * MAX_UPLOAD_MB, 25) on purpose: storing 25 MB is a streamed write, parsing it
 * is a buffered CPU burn, and it happens while the visitor's browser is holding
 * the submit request open. A file past this is still stored, still attached and
 * still downloadable — it just arrives without `text`.
 */
const MAX_PARSE_BYTES = 12 * 1024 * 1024;

/**
 * What we will carry INTO the run.
 *
 * Matches appStudio/aiRuntime's MAX_DOC_CHARS, so one document reads the same
 * whichever surface fed it to a model — a spreadsheet that fits in an App
 * Studio ai_extract must not silently mean something different in an automation.
 */
const MAX_TEXT_CHARS = 60_000;

/** Collect a stream into one Buffer, refusing to grow past `limit`. */
async function collect(stream, limit) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        // The ledger's `size` is what the upload route measured, but this is the
        // only number that has actually been counted here — trust it over the
        // row when deciding whether to keep going.
        if (total > limit) {
            const err = new Error('too large');
            err.code = 'FORM_UPLOAD_TOO_LARGE';
            throw err;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Extract one claimed upload's text.
 *
 * Returns the FIELDS TO MERGE onto the descriptor — `{}` when there is nothing
 * to say, `{ textError }` when there is a reason, `{ text, textChars }` (plus
 * `textTruncated`) when it worked. Never throws.
 *
 * @param {{filename?:string, mimeType?:string, size?:number, storageKey?:string}} claimed
 * @param {{storageStore?:object}} [deps] — injectable for tests.
 */
async function readUploadText(claimed, { storageStore = null } = {}) {
    const filename = claimed?.filename || 'file';
    const mimeType = claimed?.mimeType || '';
    if (!claimed?.storageKey) return { textError: 'This file has no stored content.' };

    if (!isSupportedDocument(mimeType, filename)) {
        // Named, not silent. An automation that branches on `textError` can tell the
        // visitor "send me the spreadsheet, not a photo of it".
        return { textError: `No text could be read from ${filename} — that file type is not a document (PDF, Word, Excel, CSV or text).` };
    }
    if (Number.isFinite(claimed.size) && claimed.size > MAX_PARSE_BYTES) {
        return { textError: `${filename} is too large to read into the run (over ${Math.floor(MAX_PARSE_BYTES / 1024 / 1024)} MB). The file is still attached.` };
    }

    const store = storageStore || require('../stores/storageStore');
    let buffer;
    try {
        const streamed = await store.streamFile(claimed.storageKey);
        buffer = await collect(streamed.stream, MAX_PARSE_BYTES);
    } catch (err) {
        if (err?.code === 'FORM_UPLOAD_TOO_LARGE') {
            return { textError: `${filename} is too large to read into the run. The file is still attached.` };
        }
        log.warn(`[formUploadText] could not read bytes for ${filename}: ${err.message}`);
        return { textError: `The content of ${filename} could not be read.` };
    }

    let parsed;
    try {
        // No `returnHtml`: a run wants the text a model reads, not markup. A
        // workbook comes back as one markdown table per sheet, which is exactly
        // the shape an ai_step can map columns out of.
        const { parseDocument } = require('../core/documents/documentParser');
        parsed = await parseDocument(buffer, mimeType, filename);
    } catch (err) {
        // parseDocument already swallows its own per-format failures and returns
        // a "[Document: … — failed to parse]" marker, so reaching here means
        // something upstream of the format branches broke. Still not fatal.
        log.warn(`[formUploadText] could not parse ${filename}: ${err.message}`);
        return { textError: `${filename} could not be read as a document.` };
    }

    const text = typeof parsed === 'string' ? parsed : String(parsed?.text || '');
    if (!text.trim()) return { textError: `No text could be read from ${filename}.` };

    if (text.length > MAX_TEXT_CHARS) {
        return {
            text: text.slice(0, MAX_TEXT_CHARS),
            textChars: MAX_TEXT_CHARS,
            // Announced, never silent: a model handed the first 60k characters
            // of a ledger must not believe it saw the ledger.
            textTruncated: true,
            textTotalChars: text.length,
        };
    }
    return { text, textChars: text.length, textTruncated: false };
}

/**
 * The complete value a `file` field contributes to a run: the receipt plus its
 * text. Both claim sites (the trigger's page and a later form_page) call THIS,
 * so the two can never drift.
 */
async function describeClaimedUpload(claimed, deps = {}) {
    const base = {
        kind: 'form_upload',
        fileId: claimed.id,
        filename: claimed.filename,
        mimeType: claimed.mimeType,
        size: claimed.size,
        storageKey: claimed.storageKey,
    };
    let extracted;
    try {
        extracted = await readUploadText(claimed, deps);
    } catch (err) {
        // readUploadText is written not to throw; this is the belt to its
        // braces, because the one thing that must not happen is losing a
        // submission over an attachment.
        log.warn(`[formUploadText] extraction failed for ${claimed?.filename}: ${err.message}`);
        extracted = { textError: 'The content of this file could not be read.' };
    }
    return { ...base, ...extracted };
}

module.exports = {
    MAX_PARSE_BYTES,
    MAX_TEXT_CHARS,
    readUploadText,
    describeClaimedUpload,
};
