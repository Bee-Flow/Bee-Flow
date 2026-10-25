/**
 * file_intake — the mailbox's attachments table: finding it, reading a row's
 * descriptor id, and filing an archive entry as a row of its own.
 */

'use strict';
const { folderOf } = require('./naming');

/** The attachments-grain child of a mailbox connector's sync tree. */
function attachmentsTableFor(model, connector) {
    const children = Array.isArray(connector?.sync?.children) ? connector.sync.children : [];
    const child = children.find((c) => c && c.level === 2) || children[1] || null;
    if (!child || typeof child.tableId !== 'string') return null;
    const tables = Array.isArray(model?.tables) ? model.tables : [];
    return tables.find((t) => t && (t.id === child.tableId || t.key === child.tableId)) || null;
}

/** First `file`-typed column on a table — where the descriptor lives. */
function fileFieldOf(table) {
    return (table.fields || []).find((f) => f && f.type === 'file') || null;
}

/**
 * The id materializeAttachment can actually find a row by: the one INSIDE the
 * stored file descriptor.
 *
 * This is subtle enough to have broken every intake on a mailbox whose
 * attachments table keeps a separate provider key. `locateDescriptor` matches
 * `descriptor.attachmentId === attachmentId` (or `.fileId`), i.e. the provider's
 * own opaque handle — for Gmail an `ANGjdJ…` blob. A mailbox row ALSO carries
 * `provider_attachment_id`, which is a composite key of its own shape
 * (`<messageId>:<filename>:<size>`) built for uniqueness, not for lookup.
 * Passing that one matched nothing and surfaced as a flat 404 "Not found" per
 * file — indistinguishable from an expired provider handle, which is exactly
 * the wrong diagnosis to hand an operator.
 *
 * Returns null when the column is absent or unparseable; callers keep their
 * existing fallbacks.
 */
function descriptorIdOf(row, fileField) {
    if (!row || !fileField || !fileField.key) return null;
    const raw = row[fileField.key];
    if (!raw) return null;
    let d = raw;
    if (typeof raw === 'string') {
        try { d = JSON.parse(raw); } catch { return null; }
    }
    if (!d || typeof d !== 'object') return null;
    return d.attachmentId || d.fileId || null;
}

function hasField(table, key) {
    return (table.fields || []).some((f) => f && f.key === key);
}

/** Bytes a redeemed file reports, or 0 — only ever used to rank candidates. */
function sizeOfDescriptor(file) {
    const size = file && file.descriptor && file.descriptor.size;
    return Number.isFinite(size) ? size : 0;
}

/**
 * File one zip entry as an attachment ROW of the same conversation.
 *
 * Written defensively — this step runs against whatever attachments table the
 * app's mailbox connector generated, so every column is written only if the
 * model actually has it, and the conversation keys and message relation are
 * INHERITED from the archive's own row rather than guessed.
 *
 * The synthetic `provider_attachment_id` is what keeps a second press honest:
 * the column is unique, and `<the archive's id>#<entry PATH>` is stable, so a
 * re-run collides instead of duplicating. (It normally never gets that far —
 * the caller skips an entry whose name is already among the filed files — so a
 * failure here is reported per entry and the batch carries on.)
 *
 * The PATH, not the bare name. An archive with folders is an archive whose
 * names repeat — that is what the folders are FOR — so "map-a/tekening.pdf" and
 * "map-b/tekening.pdf" would otherwise both claim `<zip>#tekening.pdf`, and the
 * unique constraint would turn the second one into a per-entry refusal. The
 * displayed filename stays the bare name; only the identity carries the path.
 *
 * Returns the saved row, or null when the table cannot describe a file at all.
 */
async function fileEntryAsAttachment(app, model, attTable, {
    entryName, entryPath, descriptor, bytes, sourceRow, fileField, writeRecord, writeViewer, ctx,
} = {}) {
    if (!attTable || !fileField || !fileField.key) return null;
    const src = sourceRow || {};
    const values = { [fileField.key]: descriptor };

    if (hasField(attTable, 'filename')) values.filename = entryName;
    if (hasField(attTable, 'mime_type')) values.mime_type = (descriptor && descriptor.mime) || null;
    if (hasField(attTable, 'size')) values.size = bytes;
    if (hasField(attTable, 'is_inline')) values.is_inline = false;
    // WHERE it came from, when the table can hold it. An archive of 243 files
    // is one flat pile without this, and the folder is not decoration: it is
    // the only thing that says a "Labels" folder holds labels rather than 77
    // more parts. A loose mailed file has no folder and gets null.
    if (hasField(attTable, 'map')) values.map = folderOf(entryPath) || null;
    if (hasField(attTable, 'provider_attachment_id')) {
        const parent = src.provider_attachment_id || src.id || 'zip';
        values.provider_attachment_id = `${parent}#${entryPath || entryName}`;
    }
    // Conversation keys + the message relation come from the archive's row:
    // the entry belongs to exactly the mail the zip was attached to.
    for (const key of ['thread_key', 'provider_message_id']) {
        if (hasField(attTable, key) && src[key] !== undefined) values[key] = src[key];
    }
    for (const f of attTable.fields || []) {
        if (f && f.type === 'relation' && src[f.key] !== undefined) values[f.key] = src[f.key];
    }

    return writeRecord(app, model, attTable, values, { viewer: writeViewer(ctx) });
}

module.exports = {
    attachmentsTableFor,
    fileFieldOf,
    descriptorIdOf,
    hasField,
    sizeOfDescriptor,
    fileEntryAsAttachment,
};

/**
 * Shared shapes of the file_intake phases (each phase module imports these).
 * @typedef {import('../actionExecutor/shared').DataModel} DataModel
 * @typedef {import('../actionExecutor/shared').DataTable} DataTable
 * @typedef {import('../actionExecutor/shared').ExecCtx} ExecCtx
 * @typedef {import('../actionExecutor/shared').Viewer} WriteViewer
 * @typedef {import('../actionExecutor/shared').Binding} Binding
 * @typedef {{ id: string, userId: string, organizationId?: string | null }} IntakeApp
 * @typedef {{ id?: string | null, role?: string | null, organizationId?: string | null }} IntakeViewer
 * @typedef {{ id?: string, filename?: string, map?: string, provider_attachment_id?: string, [k: string]: unknown }} AttachmentRow  a record of the attachments table
 * @typedef {{ fileId?: string, attachmentId?: string, name?: string, mime?: string, size?: number, [k: string]: unknown }} FileDescriptor
 * @typedef {{ rows: number, columns: number, hits: number, lineList: boolean, unmatched: string[], unmatchedCount: number }} SheetScan
 * @typedef {{ name: string, baseName: string, kind: string, descriptor: FileDescriptor | null, folder: string, rowId?: string, row?: AttachmentRow, fromZip?: string, scan?: SheetScan | null }} IntakeFile  one redeemed attachment
 * @typedef {{ name: string, reason: string }} Refusal
 * @typedef {Error & { status?: number, code?: string }} QuotaError
 * @typedef {{ field: string, op: string, value: unknown, required?: boolean }} RowFilter
 * @typedef {(binding: unknown, ctx: ExecCtx, scope: import('../actionExecutor/shared').ServerScope) => unknown} ResolveBinding
 * @typedef {(app: IntakeApp, model: DataModel, table: DataTable, values: Record<string, unknown>, opts: { viewer?: WriteViewer, recordId?: string }) => Promise<{ id?: string, recordId?: string } | null>} WriteRecord
 * @typedef {(ctx: ExecCtx) => WriteViewer} WriteViewerOf
 * @typedef {{ baseName: string, partKey: string, folder: string, operation: string, cadName: string | null, cadFile: FileDescriptor | null, drawingName: string | null, drawingFile: FileDescriptor | null, role: string, matchStatus: string, extraCad: string[], recordId?: string | null }} IntakePair
 * @typedef {{ kind?: string, threadKey?: Binding, connectorId?: string, poPattern?: string, allowEmpty?: boolean, cadPreferred?: string, resultDetail?: string, writeTo?: { tableId?: string, mapping?: Record<string, string>, constants?: Record<string, Binding> } }} IntakeStep  the authored file_intake step
 * @typedef {{ files: IntakeFile[], refused: Refusal[], quotaHit: QuotaError | null }} IntakeState  the phase state the phases share
 * @typedef {{ name: string, extracted: number, refusedEntries: Refusal[], format?: string, entries?: number, filed?: number }} ZipReport
 * @typedef {{ name: string, rows: number | null, columns: number | null, hits: number | null, missing: number | null, lineList: boolean }} SheetReport
 * @typedef {{ name: string | null, descriptor: FileDescriptor | null }} DocumentEntry  a document the report points at
 * @typedef {typeof import('../stepDataSource')} StepDataSourceModule
 * @typedef {typeof import('../mailboxAttachments')} MailboxModule
 */
