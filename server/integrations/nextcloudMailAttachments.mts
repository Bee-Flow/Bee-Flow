/**
 * Attachments for `nextcloud_mail_send`: files from the sender's Nextcloud
 * Files (`{ path }`) and files a document step of the same automation run kept
 * (`{ sourceHandle: { kind: 'generated_file', fileId } }`).
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
}

/** One entry of the outbox draft's `attachments`. */
export type DraftAttachment = { type: 'cloud', fileName: string } | { type: 'local', id: number | string };

export type ResolvedAttachments = { attachments: DraftAttachment[], names: string[] };

const DEFAULT_MAX_MB = 25;
const DEFAULT_MAX_COUNT = 20;
const MAIL_API_BASE = '/index.php/apps/mail/api';

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
    };
}

type Wanted =
    | { kind: 'path', path: string, name: string, size: number }
    | { kind: 'generated', file: NonNullable<GeneratedFile> };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

type AttachmentItem = { path: string } | { sourceHandle: { kind: 'generated_file', fileId: string } };

/** One entry of the argument as an item, or the reason it is not one. */
function parseEntry(entry: unknown, i: number): AttachmentItem | { error: string } {
    const path = isObject(entry) && typeof entry.path === 'string' ? entry.path.trim() : '';
    const handle = isObject(entry) && isObject(entry.sourceHandle) ? entry.sourceHandle : null;
    if (path && handle) return { error: `attachments[${i}]: give a path or a sourceHandle, not both.` };
    if (path) return { path };
    if (!handle) return { error: `attachments[${i}]: needs a path in Nextcloud Files (e.g. "/Documents/offer.pdf") or a sourceHandle.` };
    if (handle.kind !== 'generated_file' || typeof handle.fileId !== 'string' || !handle.fileId) {
        return { error: `attachments[${i}]: sourceHandle must be { kind: "generated_file", fileId } from a document step of this automation.` };
    }
    return { sourceHandle: { kind: 'generated_file', fileId: handle.fileId } };
}

/** The `{ path }` and `{ sourceHandle }` entries as given, or the reason the list is malformed. */
export function parseAttachmentArgs(raw: unknown): { items: AttachmentItem[] } | { error: string } {
    if (raw === undefined || raw === null) return { items: [] };
    if (!Array.isArray(raw)) return { error: 'attachments must be a list of { path } or { sourceHandle } entries.' };
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
