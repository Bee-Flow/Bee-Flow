// @typecheck
/**
 * file_intake — one button-press files a whole mailed order.
 *
 * Redeems a conversation's attachments in bulk (the existing per-file
 * materialize route shares the upload limiter at 20/min, so a 20-attachment
 * order 429s on its own last file), classifies each one by DETERMINISTIC rules
 * — no model call: an LLM classifying twenty filenames is twenty times slower,
 * costs money, and is wrong in a way a regex is not — pairs drawings with
 * their CAD files by base name (MW2604-01-3021-001.pdf ↔ .step), and
 * optionally upserts one row per pair so re-pressing the button updates the
 * layout instead of duplicating it.
 *
 * AUTHORITY, in order, none of it widened here:
 *   • Locate under the VIEWER's read filter (a records binding through
 *     stepDataSource) — someone who may not see the conversation redeems
 *     nothing. Never client-supplied fileIds; never owner scope.
 *   • Redeem through materializeAttachment, which re-checks access, quota and
 *     the malware scan per file, and resolves mailbox credentials by the
 *     connector's own runAs ladder — never a fallback to owner credentials.
 *   • Write rows as the VIEWER under RLS (writeRecord) — the same
 *     create-permission story ai_extract depends on.
 *
 * FAILURE SEMANTICS: per-file, named. File 14 failing its scan is recorded in
 * `refused` while 15–20 continue — a folder with a named hole, not nineteen
 * silent files. The one abort is quota: it is app-wide, so once a 409 lands
 * every remaining file would 409 too, and carrying on would just burn
 * provider calls.
 */

'use strict';
const log = require('../telemetry/log');
const naming = require('./fileIntake/naming');
const { attachmentsTableFor, descriptorIdOf } = require('./fileIntake/attachmentRows');
const {
    MAX_FILES_PER_INTAKE, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES, MAX_TOTAL_FILES,
} = require('./fileIntake/limits');
const { resolveIntakeSource, compilePoPattern, locateAttachments } = require('./fileIntake/locate');
const { redeemAttachments, backfillFolders } = require('./fileIntake/redeem');
const { expandArchives } = require('./fileIntake/archives');
const { pairFiles } = require('./fileIntake/pairing');
const { findOrderDocument, scanSheets } = require('./fileIntake/orderDocuments');
const { writePairs } = require('./fileIntake/writePairs');
const { emptyIntakeResult, buildResult, trimForDetail } = require('./fileIntake/result');

// The phases live in ./fileIntake/: naming (what a filename says), locate (1),
// redeem (2), archives (2b), pairing (3), orderDocuments (3b/3c), writePairs
// (4) and result (5). This file only runs them in order and holds the phase
// state they share.

/**
 * Execute the step. `helpers` carries actionExecutor's own primitives
 * (resolveBinding / buildServerScope / writeViewer / findTable / writeRecord)
 * so the two modules never require each other at load time.
 */
async function fileIntakeStep(app, model, step, ctx, helpers) {
    const { resolveBinding, buildServerScope, writeViewer, findTable, writeRecord } = helpers;
    // Lazy, and lent to the phase modules: these three sit in the app-studio
    // import cycle, and requiring them from ./fileIntake/* would pull every
    // phase module into it.
    const stepDataSource = require('./stepDataSource');
    const connectors = require('./connectors');
    const mailbox = require('./mailboxAttachments');
    const { materializeAttachment } = mailbox;

    const scope = buildServerScope(ctx);
    const viewer = {
        id: ctx.viewerId ?? null,
        role: ctx.role ?? null,
        organizationId: app.organizationId || null,
    };

    const source = resolveIntakeSource(model, step, ctx, { resolveBinding, scope, connectors });
    if (source.ok === false) return source;
    const { threadKey, attTable, fileField } = source;

    const poRe = compilePoPattern(step);

    // ── 1. Locate, as the viewer ────────────────────────────────────────
    const located = await locateAttachments(app, model, {
        attTable, threadKey, viewer, ctx, scope, resolveBinding, stepDataSource,
    });
    if (located === null) return { ok: false, error: 'The attachments for this conversation could not be read' };

    const truncated = located.length > MAX_FILES_PER_INTAKE;
    const rows = truncated ? located.slice(0, MAX_FILES_PER_INTAKE) : located;
    if (!rows.length) {
        if (!step.allowEmpty) return { ok: false, error: 'This conversation has no attachments to file' };
        // Asked to run unattended (opening a conversation, say): nothing to
        // file is an outcome, not a failure. The report keeps its full shape
        // so a formula reading .pairs or .filed sees zeroes, never undefined.
        return { ok: true, result: emptyIntakeResult() };
    }

    // Storage checked ONCE before the batch — twenty provider fetches followed
    // by twenty failed puts is a bad way to learn the store is down.
    const storageStore = require('../stores/storageStore');
    if (!storageStore.isAvailable()) return { ok: false, error: 'File storage is not available' };

    // ── 2. Redeem each, per-file failure isolation ──────────────────────
    // The phase state: `files` grows as archives expand, `quotaHit` ends both.
    const state = await redeemAttachments(app, model, {
        rows, attTable, fileField, viewer, poRe, materializeAttachment,
    });
    const { files, refused } = state;
    await backfillFolders(app, model, attTable, files, { writeRecord, writeViewer, ctx });

    if (state.quotaHit && files.length === 0) {
        return { ok: false, error: state.quotaHit.message || 'App storage is full', code: 'quota_exceeded' };
    }

    // ── 2b. Expand zip packages ─────────────────────────────────────────
    const { zipReports, emptyFolders } = await expandArchives(app, model, state, {
        attTable, fileField, poRe, writeRecord, writeViewer, ctx, mailbox,
    });
    const { quotaHit } = state;

    // ── 3. Pair ─────────────────────────────────────────────────────────
    const { po, pairs, skipped } = pairFiles(files, step);
    // ── 3b / 3c. The order document and the bill of materials ───────────
    const { poEntry, poSource } = findOrderDocument(po, pairs);
    const { sheetReports, sheetOnly, sheetEntry, lineListEntry } = await scanSheets(app, files, pairs, { mailbox });

    // ── 4. Upsert one row per pair, as the viewer ───────────────────────
    const wrote = await writePairs(app, model, step, pairs, {
        ctx, scope, viewer, resolveBinding, findTable, writeRecord, writeViewer, stepDataSource,
    });
    if (wrote.ok === false) return wrote;
    const { written } = wrote;

    const result = buildResult({
        files, rows, pairs, refused, poEntry, poSource, sheetEntry, sheetOnly, lineListEntry, sheetReports,
        skipped, emptyFolders, zipReports, written, truncated, quotaHit,
    });

    // ── 5. Trim, when the caller says it does not need the detail ───────
    trimForDetail(result, step, { refused, emptyFolders, sheetOnly });

    // One line per intake, because "it did nothing" is otherwise invisible:
    // the step used to report ok:true whether it wrote twenty rows or none, and
    // an action reading vars.intake.pairs simply looped zero times and carried
    // on to a cheerful "Klaar".
    const counts = `files=${rows.length} filed=${result.filed} refused=${refused.length} pairs=${pairs.length}`
        + ` written=${written} po=${poEntry ? poSource : 'NO'} sheet=${sheetEntry ? sheetEntry.name : 'NO'}`
        + ` empty=${emptyFolders.length} skipped=${skipped.size} sheetOnly=${sheetOnly.length}`;
    // "Wrote nothing" is only suspicious when it was ASKED to write; a step
    // with no writeTo is a pure pairing read and zero writes is its contract.
    const wroteNothingButShould = Boolean(step.writeTo && step.writeTo.tableId) && pairs.length > 0 && written === 0;
    if (!pairs.length || wroteNothingButShould) {
        log.warn(`[fileIntake] app=${app.id} thread=${threadKey} produced NOTHING to work with — ${counts}`
            + (refused.length ? ` | refused: ${refused.slice(0, 5).map((r) => `${r.name}: ${r.reason}`).join('; ')}` : '')
            + (step.writeTo?.tableId ? '' : ' | no writeTo configured'));
    } else {
        log.info(`[fileIntake] app=${app.id} thread=${threadKey} ${counts}`);
    }

    // EVERY file refused is a failure, not an empty result. Returning ok here
    // is what let a whole run look successful while doing nothing: the caller
    // reads `pairs`, finds none, loops zero times and reports "done". The most
    // common cause is stale provider descriptors — the mailbox was re-synced,
    // so the stored attachment ids 404 — and the operator can only act on that
    // if someone says it out loud.
    if (rows.length && !files.length) {
        const why = refused.length
            ? [...new Set(refused.map((r) => r.reason))].slice(0, 3).join('; ')
            : 'unknown';
        return {
            ok: false,
            error: `None of the ${rows.length} attachments on this conversation could be read (${why}). `
                + 'If this says "Not found", the stored attachment references are stale — re-sync the mailbox and try again.',
            result,
        };
    }

    return { ok: true, result };
}

module.exports = {
    fileIntakeStep,
    // exported for tests
    MAX_FILES_PER_INTAKE,
    MAX_ZIP_ENTRIES,
    MAX_ZIP_TOTAL_BYTES,
    MAX_TOTAL_FILES,
    DEFAULT_PO_PATTERN: naming.DEFAULT_PO_PATTERN,
    _internal: {
        baseNameOf: naming.baseNameOf,
        canonicalBaseOf: naming.canonicalBaseOf,
        normalizeBase: naming.normalizeBase,
        operationOf: naming.operationOf,
        withoutOperation: naming.withoutOperation,
        partKeyOf: naming.partKeyOf,
        partKeyOfFolder: naming.partKeyOfFolder,
        partNameForFolder: naming.partNameForFolder,
        looksLikePartNumber: naming.looksLikePartNumber,
        containsPrefix: naming.containsPrefix,
        cadPreference: naming.cadPreference,
        cadPreferenceWith: naming.cadPreferenceWith,
        extensionOf: naming.extensionOf,
        zipEntryPath: naming.zipEntryPath,
        classify: naming.classify,
        attachmentsTableFor,
        descriptorIdOf,
    },
};
