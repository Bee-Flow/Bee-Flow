/**
 * Attachments for `nextcloud_mail_send`: files from the sender's Nextcloud
 * Files (`{ path }`, or `{ fileId }`: the numeric Files id a trigger or another
 * tool gives, looked up as the sender with nextcloud_file_info's helper,
 * nextcloudFiles/fileInfo.mts) and files a document step of the same
 * automation run kept (`{ sourceHandle: { kind: 'generated_file', fileId } }`).
 * The Files scope judges a path before the call; a file id cannot be placed
 * in a folder without the lookup, so under a narrowed Files scope it is
 * refused like nextcloud_file_info by id (core/integrations/ncScopeGuard.js).
 *
 * How the Mail app takes them (nextcloud/mail, stable4.0 to main):
 *   - the outbox draft (`POST /api/outbox`, OutboxController::create) carries
 *     `attachments: [...]`; AttachmentService::handleAttachments reuses an
 *     uploaded attachment for `{ type: 'local', id }` and copies a Files file
 *     for any other type through handleCloudAttachment, which reads
 *     `fileName` relative to the user's own Files folder;
 *   - bytes Nextcloud does not have are uploaded first with
 *     `POST /api/attachments` (LocalAttachmentsController::create, the
 *     multipart field `attachment`), whose answer is the attachment with its
 *     `id`.
 *
 * handleCloudAttachment SKIPS a path that does not exist, is a folder or may
 * not be downloaded, and the mail then goes out without it. So every path is
 * checked here first (PROPFIND as the sender), and sendMail compares the
 * attachments the draft came back with against what was asked.
 *
 * Caps (env, 0 = unlimited): NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT files and
 * NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB for all attachments of one message together.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { envInt } from '../utils/envNumber.mts';

const nodeRequire = createRequire(import.meta.url);

type NcResponse = { ok: boolean, status: number, text: () => Promise<string> };
type NcFetch = (url: string, options?: Record<string, unknown>) => Promise<NcResponse>;
type RunScope = { runId: string, rootRunId?: string } | null;
type StatEntry = { name: string, path: string, type: 'file' | 'folder', size?: number } | null;
type GeneratedFile = { buffer: Buffer, filename: string, mimeType: string, size: number } | null;
type FoundFile = { path: string, name: string, isFolder: boolean, size: number | null } | { error: string };

export interface MailAttachmentCtx {
    baseUrl: string;
    uid?: string;
    fetch: NcFetch;
    authError: string;
    runScope?: RunScope;
}

export interface MailAttachmentDeps {
    statFile: (path: string, ctx: MailAttachmentCtx) => Promise<StatEntry>;
    readGeneratedFile: (handle: { kind: 'generated_file', fileId: string }, runScope: RunScope) => Promise<GeneratedFile>;
    /** A Files file by its numeric id, as the sender sees it (nextcloudFiles/fileInfo.mts). */
    fileById: (fileId: number, ctx: MailAttachmentCtx) => Promise<FoundFile>;
}

/** One entry of the outbox draft's `attachments`. */
export type DraftAttachment = { type: 'cloud', fileName: string } | { type: 'local', id: number | string };

export type ResolvedAttachments = { attachments: DraftAttachment[], names: string[] };

const DEFAULT_MAX_MB = 25;
const DEFAULT_MAX_COUNT = 20;
const MAIL_API_BASE = '/index.php/apps/mail/api';

/** The `attachments` parameter of nextcloud_mail_send (nextcloudMailTools.js). */
export const ATTACHMENTS_PARAMETER = {
    type: 'array',
    description: 'Optional files to attach, each EITHER { path } — a file in the sender\'s Nextcloud Files, e.g. "/Documents/offer.pdf" — OR { fileId } — the numeric Nextcloud Files id of such a file (a trigger\'s fileId, nextcloud_file_info) — OR, inside an automation, { sourceHandle } — the { kind: "generated_file", fileId } a generate_document / fill_document / presentation step returns (bind it: sourceHandle:{kind:"ref",path:"steps.<id>.output.sourceHandle"}). A missing file or a folder stops the send; nothing is sent without all of them. The server caps the number and the total size (NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT, NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB).',
    items: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path of a file in Nextcloud Files.' },
            fileId: { type: 'integer', description: 'Numeric Nextcloud Files id of a file (instead of path).' },
            sourceHandle: {
                type: 'object',
                description: 'A generated file of this automation run: { kind: "generated_file", fileId }.',
                properties: {
                    kind: { type: 'string', description: 'Always "generated_file".' },
                    fileId: { type: 'string', description: 'The fileId a document or presentation step produced.' },
                },
            },
        },
    },
};

export function attachmentLimits(): { maxBytes: number, maxCount: number } {
    const mb = envInt('NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB', DEFAULT_MAX_MB, { min: 0 });
    const maxCount = envInt('NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT', DEFAULT_MAX_COUNT, { min: 0 });
    return { maxBytes: mb * 1024 * 1024, maxCount };
}

function defaultDeps(): MailAttachmentDeps {
    const webdav = nodeRequire('./nextcloudFiles/webdav.js') as {
        statFile: (f: NcFetch, root: string, path: string, baseUrl: string, uid: string) => Promise<StatEntry>,
    };
    const ncClient = nodeRequire('./nextcloudClient.js') as { webdavRoot: (baseUrl: string, uid: string) => string };
    const generated = nodeRequire('../core/automationRunner/generatedFileHandle.js') as {
        readGeneratedFile: MailAttachmentDeps['readGeneratedFile'],
    };
    return {
        statFile: (path, ctx) => webdav.statFile(ctx.fetch, ncClient.webdavRoot(ctx.baseUrl, ctx.uid || ''), path, ctx.baseUrl, ctx.uid || ''),
        readGeneratedFile: generated.readGeneratedFile,
        fileById: async (fileId, ctx) => {
            const { nextcloudFileInfo } = nodeRequire('./nextcloudFiles/fileInfo.mts') as typeof import('./nextcloudFiles/fileInfo.mts');
            const uid = ctx.uid || '';
            const info = await nextcloudFileInfo({ fileId }, { baseUrl: ctx.baseUrl, ncFetch: ctx.fetch, authError: ctx.authError, uid, root: ncClient.webdavRoot(ctx.baseUrl, uid) });
            return 'error' in info ? info : { path: info.path, name: info.name, isFolder: info.isFolder, size: info.size };
        },
    };
}

type Wanted =
    | { kind: 'path', path: string, name: string, size: number }
    | { kind: 'generated', file: NonNullable<GeneratedFile> };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

type AttachmentItem = { path: string } | { fileId: number } | { sourceHandle: { kind: 'generated_file', fileId: string } };

/** A positive whole-number Files id, or null. */
function filesId(v: unknown): number | null {
    const text = typeof v === 'number' ? String(v) : (typeof v === 'string' ? v.trim() : '');
    if (!text || text.length > 15 || ![...text].every((c) => c >= '0' && c <= '9')) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A `{ fileId }` entry as an item, or the reason it is not one. */
function fileIdEntry(raw: unknown, i: number): AttachmentItem | { error: string } {
    const fileId = filesId(raw);
    return fileId ? { fileId } : { error: `attachments[${i}]: fileId must be a positive whole number (a Nextcloud Files id).` };
}

/** A `{ sourceHandle }` entry as an item, or the reason it is not one. */
function handleEntry(handle: Record<string, unknown>, i: number): AttachmentItem | { error: string } {
    if (handle.kind !== 'generated_file' || typeof handle.fileId !== 'string' || !handle.fileId) {
        return { error: `attachments[${i}]: sourceHandle must be { kind: "generated_file", fileId } from a document step of this automation.` };
    }
    return { sourceHandle: { kind: 'generated_file', fileId: handle.fileId } };
}

/** One entry of the argument as an item, or the reason it is not one. */
function parseEntry(entry: unknown, i: number): AttachmentItem | { error: string } {
    const e = isObject(entry) ? entry : {};
    const path = typeof e.path === 'string' ? e.path.trim() : '';
    const hasId = e.fileId !== undefined && e.fileId !== null && e.fileId !== '';
    const handle = isObject(e.sourceHandle) ? e.sourceHandle : null;
    if ([!!path, hasId, !!handle].filter(Boolean).length > 1) return { error: `attachments[${i}]: give one of path, fileId or sourceHandle.` };
    if (path) return { path };
    if (hasId) return fileIdEntry(e.fileId, i);
    if (handle) return handleEntry(handle, i);
    return { error: `attachments[${i}]: needs a path in Nextcloud Files (e.g. "/Documents/offer.pdf"), a fileId or a sourceHandle.` };
}

/** The `{ path }` and `{ sourceHandle }` entries as given, or the reason the list is malformed. */
export function parseAttachmentArgs(raw: unknown): { items: AttachmentItem[] } | { error: string } {
    if (raw === undefined || raw === null) return { items: [] };
    if (!Array.isArray(raw)) return { error: 'attachments must be a list of { path }, { fileId } or { sourceHandle } entries.' };
    const items: AttachmentItem[] = [];
    for (const [i, entry] of raw.entries()) {
        const item = parseEntry(entry, i);
        if ('error' in item) return item;
        items.push(item);
    }
    return { items };
}

function tooLarge(totalBytes: number, maxBytes: number): string {
    const mb = (n: number) => `${Math.ceil(n / 104857.6) / 10} MB`;
    return `The attachments come to ${mb(totalBytes)}, more than the ${mb(maxBytes)} one message may carry on this server (NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB). Send fewer or smaller files, or share a link instead.`;
}

/** A Files file by its id, found as the sender, as a path to attach; or the reason it cannot be. */
async function byFileId(fileId: number, ctx: MailAttachmentCtx, deps: MailAttachmentDeps): Promise<Wanted | { error: string }> {
    let found: FoundFile;
    try {
        found = await deps.fileById(fileId, ctx);
    } catch (e) {
        return { error: (e as Error).message };
    }
    if ('error' in found) return { error: `Attachment file id ${fileId}: ${found.error}` };
    if (found.isFolder) return { error: `File id ${fileId} is a folder (${found.path}); attach the files in it one by one.` };
    return { kind: 'path', path: found.path, name: found.name, size: Number(found.size) || 0 };
}

/** Look every entry up (and read the generated ones) before anything is uploaded. */
async function collect(items: AttachmentItem[], ctx: MailAttachmentCtx, deps: MailAttachmentDeps): Promise<{ wanted: Wanted[] } | { error: string }> {
    const wanted: Wanted[] = [];
    for (const item of items) {
        if ('path' in item) {
            let entry: StatEntry;
            try {
                entry = await deps.statFile(item.path, ctx);
            } catch (e) {
                return { error: (e as Error).message };
            }
            if (!entry) return { error: `Attachment not found in Nextcloud Files: ${item.path}` };
            if (entry.type === 'folder') return { error: `${item.path} is a folder; attach the files in it one by one.` };
            wanted.push({ kind: 'path', path: entry.path || item.path, name: entry.name, size: Number(entry.size) || 0 });
            continue;
        }
        if ('fileId' in item) {
            const found = await byFileId(item.fileId, ctx, deps);
            if ('error' in found) return found;
            wanted.push(found);
            continue;
        }
        let file: GeneratedFile;
        try {
            file = await deps.readGeneratedFile(item.sourceHandle, ctx.runScope || null);
        } catch (e) {
            return { error: (e as Error).message };
        }
        if (!file) return { error: 'That fileId is not a live file of this run (expired, or produced by another automation).' };
        wanted.push({ kind: 'generated', file });
    }
    return { wanted };
}

/** A multipart/form-data body with one file part, as bytes (the connector signs the exact body). */
export function multipartFile(field: string, filename: string, mimeType: string, bytes: Buffer): { body: Buffer, contentType: string } {
    const boundary = `----beeflow${crypto.randomBytes(12).toString('hex')}`;
    const safeName = filename.split('').filter(c => c !== '\r' && c !== '\n').join('').split('"').join('%22') || 'attachment';
    const safeType = mimeType.split('').filter(c => c !== '\r' && c !== '\n').join('') || 'application/octet-stream';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safeName}"\r\nContent-Type: ${safeType}\r\n\r\n`;
    return {
        body: Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

async function uploadLocal(file: NonNullable<GeneratedFile>, ctx: MailAttachmentCtx): Promise<{ id: number | string } | { error: string }> {
    const { body, contentType } = multipartFile('attachment', file.filename, file.mimeType, file.buffer);
    const res = await ctx.fetch(`${ctx.baseUrl}${MAIL_API_BASE}/attachments`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'OCS-APIRequest': 'true', 'Content-Type': contentType },
        body,
    });
    if (res.status === 401) return { error: ctx.authError };
    const text = await res.text().catch(() => '');
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* not JSON: handled below */ }
    const id = isObject(data) ? (data.id ?? (isObject(data.data) ? data.data.id : undefined)) : undefined;
    if (!res.ok || (typeof id !== 'number' && typeof id !== 'string')) {
        return { error: `Nextcloud Mail did not take the attachment ${file.filename} (${res.status}).` };
    }
    return { id };
}

/**
 * The draft's `attachments` for the given tool argument, or `{ error }`.
 * Nothing is uploaded until every entry is found and the caps hold.
 */
export async function resolveMailAttachments(raw: unknown, ctx: MailAttachmentCtx, deps: MailAttachmentDeps = defaultDeps()): Promise<ResolvedAttachments | { error: string }> {
    const parsed = parseAttachmentArgs(raw);
    if ('error' in parsed) return parsed;
    if (!parsed.items.length) return { attachments: [], names: [] };
    const { maxBytes, maxCount } = attachmentLimits();
    if (maxCount > 0 && parsed.items.length > maxCount) {
        return { error: `${parsed.items.length} attachments is more than the ${maxCount} one message may carry on this server (NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT).` };
    }
    const found = await collect(parsed.items, ctx, deps);
    if ('error' in found) return found;
    const total = found.wanted.reduce((sum, w) => sum + (w.kind === 'path' ? w.size : w.file.size), 0);
    if (maxBytes > 0 && total > maxBytes) return { error: tooLarge(total, maxBytes) };

    const attachments: DraftAttachment[] = [];
    const names: string[] = [];
    for (const w of found.wanted) {
        if (w.kind === 'path') {
            attachments.push({ type: 'cloud', fileName: w.path });
            names.push(w.name);
            continue;
        }
        const up = await uploadLocal(w.file, ctx);
        if ('error' in up) return up;
        attachments.push({ type: 'local', id: up.id });
        names.push(w.file.filename);
    }
    return { attachments, names };
}
