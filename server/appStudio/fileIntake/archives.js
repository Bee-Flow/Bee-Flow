/**
 * file_intake phase 2b — expand archive packages into attachment rows of the
 * same conversation. Mutates the shared phase state: appends to `files`,
 * sets `quotaHit`, and returns the per-archive reports and empty folders.
 */

'use strict';
const { baseNameOf, classify, zipEntryPath, folderOf } = require('./naming');
const { hasField, fileEntryAsAttachment } = require('./attachmentRows');
const { MAX_ZIP_ENTRIES, MAX_ARCHIVE_DEPTH, MAX_ZIP_TOTAL_BYTES, MAX_TOTAL_FILES } = require('./limits');

async function expandArchives(app, model, state, { attTable, fileField, poRe, writeRecord, writeViewer, ctx, mailbox }) {
    const { files } = state;
    // ── 2b. Expand zip packages ─────────────────────────────────────────
    // A customer's order can arrive as ONE archive. Each entry goes through
    // the SAME acceptance ladder as a mailed file (storeDerivedFile: name
    // proposes, bytes confirm, scan before ledger) and hangs off the zip's
    // own attachment row, so it is readable by exactly whoever may read the
    // zip. Nested zips are refused, never recursed into.
    const zipReports = [];
    // Folders the archive DECLARES and then leaves empty. In a real order one
    // article folder arrived with nothing in it: the part is on the order and
    // on the customer's own line list, and every file for it was forgotten.
    // It produces no project line (files decide which lines exist), so the
    // only thing standing between that plate and silence is saying its name.
    const emptyFolders = [];
    // A QUEUE, not a list: an archive may hold an archive, and the entries of
    // the inner one are files of this same conversation. `prefix` keeps their
    // paths distinct — two nested packages may each carry a "parts/" folder, and
    // without it those two folders would read as one part.
    const queue = files.filter((f) => f.kind === 'zip' && f.descriptor)
        .map((f) => ({ file: f, depth: 1, prefix: '' }));
    if (queue.length && !state.quotaHit) {
        const archive = require('../archive');
        const canExpand = typeof mailbox.getStoredAttachmentBuffer === 'function'
            && typeof mailbox.storeDerivedFile === 'function';
        while (queue.length) {
            const { file: zipFile, depth, prefix } = queue.shift();
            const report = { name: zipFile.name, extracted: 0, refusedEntries: [] };
            zipReports.push(report);
            if (state.quotaHit) break;
            if (!canExpand) {
                report.refusedEntries.push({ name: zipFile.name, reason: 'zip expansion is not available' });
                continue;
            }
            let opened;
            try {
                const bytes = await mailbox.getStoredAttachmentBuffer(app, zipFile.descriptor.fileId);
                if (!bytes || !bytes.length) throw new Error('empty');
                opened = await archive.openArchive(bytes, { name: zipFile.name });
            } catch (e) {
                // The REASON, not a shrug. "Could not open the zip" about a
                // password-protected archive or a .7z sends somebody hunting a
                // corrupt file; naming the format or the password is a sentence
                // they can forward to the customer instead.
                report.refusedEntries.push({
                    name: zipFile.name,
                    reason: (e && e.reason) || 'could not open the archive',
                });
                if (e && e.format) report.format = e.format;
                continue;
            }
            report.format = opened.format;
            const allEntries = opened.entries;
            // Against the FULL list, never the truncated one: a folder we simply
            // did not read is not a folder the customer left empty.
            const entryPaths = allEntries.map((e) => zipEntryPath(e.path));
            for (const d of opened.dirs || []) {
                const dir = zipEntryPath(d).replace(/\/+$/, '');
                if (!dir) continue;
                if (entryPaths.some((f) => f.startsWith(`${dir}/`))) continue;
                emptyFolders.push(prefix ? `${prefix}/${dir}` : dir);
            }
            let entries = allEntries;
            if (entries.length > MAX_ZIP_ENTRIES) {
                report.refusedEntries.push({ name: zipFile.name, reason: `only the first ${MAX_ZIP_ENTRIES} of ${entries.length} entries were read` });
                entries = entries.slice(0, MAX_ZIP_ENTRIES);
            }
            report.entries = entries.length;
            // How many files are coming, written on the archive's own row BEFORE
            // the work starts. Unpacking 243 files takes minutes inside this one
            // step, and a count of what is done means nothing without the count
            // of what there is — this is the denominator, published early
            // precisely so something can watch the numerator climb.
            if (hasField(attTable, 'entries') && zipFile.rowId) {
                try {
                    await writeRecord(app, model, attTable, { entries: entries.length }, {
                        viewer: writeViewer(ctx), recordId: zipFile.rowId,
                    });
                } catch { /* a progress denominator is never worth failing an intake for */ }
            }
            let totalBytes = 0;
            for (const entry of entries) {
                if (state.quotaHit) break;
                // The path identifies the entry; the last segment names it. An
                // order that arrives as one folder per article ("RFQ-1/3010-
                // 005424-01/3010-005424-01.dxf") flattens to the filename the
                // pairing already understands, and keeps the path for identity.
                const innerPath = zipEntryPath(entry.path);
                const entryPath = prefix ? `${prefix}/${innerPath}` : innerPath;
                const entryName = entryPath.split('/').pop().trim();
                if (!entryName || entryName.startsWith('.')) continue; // junk/hidden
                const nested = archive.looksLikeArchiveName(entryName);
                if (nested && depth >= MAX_ARCHIVE_DEPTH) {
                    report.refusedEntries.push({
                        name: entryPath,
                        reason: `archives nested more than ${MAX_ARCHIVE_DEPTH} deep are not opened`,
                    });
                    continue;
                }
                // A file mailed loose AND inside the zip is one file, not two.
                // Only against LOOSE files: two entries in different folders
                // legitimately share a name, and comparing against what this
                // expansion already produced would drop the second one without
                // a word — the archive has folders precisely so that it can
                // hold "deel-a/tekening.pdf" beside "deel-b/tekening.pdf".
                if (files.some((f) => f.kind !== 'zip' && !f.fromZip
                    && f.name.toLowerCase() === entryName.toLowerCase())) continue;
                if (files.filter((f) => f.kind !== 'zip').length >= MAX_TOTAL_FILES) {
                    report.refusedEntries.push({ name: entryPath, reason: 'file limit for one intake reached' });
                    continue;
                }
                let bytes;
                try { bytes = await entry.read(); } catch {
                    report.refusedEntries.push({ name: entryPath, reason: 'could not read the entry' });
                    continue;
                }
                totalBytes += bytes.length;
                if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
                    report.refusedEntries.push({ name: entryPath, reason: 'the zip is too large in total' });
                    break;
                }
                try {
                    const descriptor = await mailbox.storeDerivedFile(app, {
                        buffer: bytes, name: entryName,
                        recordId: zipFile.rowId, fieldKey: fileField.key,
                        // Said out loud, and only inside the depth budget — the
                        // store refuses an archive entry unless a caller takes
                        // responsibility for what happens to it next.
                        allowArchive: nested,
                    });
                    // The entry becomes a REAL attachment row of the same
                    // conversation, not just a member of this run's pairing
                    // list. Without it "unpacked" was only true inside the
                    // step: the project lines got their CAD file, while every
                    // files view stayed bound to the attachments table and
                    // went on showing one .zip nobody could open — which is
                    // not what anyone means by unpacking an archive.
                    const filedRow = await fileEntryAsAttachment(app, model, attTable, {
                        entryName, entryPath, descriptor, bytes: bytes.length,
                        sourceRow: zipFile.row, fileField, writeRecord, writeViewer, ctx,
                    });
                    files.push({
                        name: entryName,
                        baseName: baseNameOf(entryName),
                        kind: classify(entryName, poRe),
                        descriptor,
                        // The folder decides whether these files describe PARTS
                        // at all — see the CAD-less-folder rule in the pairing.
                        folder: folderOf(entryPath),
                        // Its OWN row when it got one, so anything hanging off
                        // the file addresses the file and not the archive.
                        rowId: (filedRow && filedRow.id) || zipFile.rowId,
                        fromZip: zipFile.name,
                    });
                    report.extracted += 1;
                    if (filedRow && filedRow.id) report.filed = (report.filed || 0) + 1;
                    if (nested) {
                        // Its entries belong to this conversation too. They hang
                        // off the INNER archive's own row, so access follows the
                        // file rather than the mail it was forwarded in.
                        queue.push({
                            file: files[files.length - 1],
                            depth: depth + 1,
                            prefix: entryPath,
                        });
                    }
                } catch (e) {
                    if (e && e.status === 409 && e.code === 'quota_exceeded') { state.quotaHit = e; break; }
                    report.refusedEntries.push({ name: entryPath, reason: e && e.message ? String(e.message).slice(0, 200) : 'refused' });
                }
            }
        }
    }
    return { zipReports, emptyFolders };
}

module.exports = { expandArchives };
