/**
 * cloudFolder.mts: a folder in Nextcloud, OneDrive or Google Drive as a knowledge source.
 *
 * ONE ADAPTER OVER THE THREE STORAGES. The storage code is the spreadsheet mirror's provider layer
 * (core/dataEngine/sources/spreadsheetFile/providers), switched to its documents mode: a listing
 * returns folders plus every file the text extractor reads, and Google's native Docs, Slides and
 * Sheets are exported to docx, pptx and xlsx on download. This file only walks the folder, compares
 * change markers and hands the bytes to the extractor.
 *
 * AS WHOM. Every call runs as the person who ADDED the folder (`created_by`), through the same
 * gates an agent tool passes: the integration is on for that account, Google/Microsoft credentials
 * come from the long-lived vault (refreshed, rotated tokens saved), and for Nextcloud the account's
 * per-folder scope covers the folder. A revoked or missing connection is an error on the SOURCE,
 * with a sentence that says whose connection and where to fix it, not an empty folder.
 *
 * IDENTITY. A document's external id is the storage's file id (Nextcloud: oc:fileid), never the path,
 * so a renamed or moved file keeps its document, its citations and its history. "Unchanged" is the
 * storage's own change marker (etag, cTag, version), compared on the listing: an untouched file costs
 * nothing, not even a download.
 *
 * CAPS. All of them configurable, 0 = no limit: KB_CLOUD_MAX_FILES (files per folder, default 2000),
 * KB_CLOUD_MAX_FILE_MB (default 50), KB_CLOUD_CHANGE_POLL_SECONDS (how often an "on change" folder is
 * checked, default 300). A tree deeper than 10 levels is not walked below that. When a listing stops
 * short for any reason the pass says so (`ctx.partial`) and the engine removes nothing: "I did not
 * list it" must never read as "it was deleted".
 *
 * PRIVACY. Nothing here sends a file anywhere. The document metadata is built from an explicit
 * allow-list: marker, provider, path, webUrl.
 */

import { createRequire } from 'node:module';

import { MAX_DEPTH, walkFolder, type CloudConfig, type CloudItem, type CloudProvider, type FileApi, type Marker } from './cloudFolderWalk.mts';

export { MAX_DEPTH };
export type { CloudItem, CloudProvider };

const nodeRequire = createRequire(import.meta.url);

interface CloudSource {
    id: string;
    createdBy: string | null;
    config: CloudConfig;
}

interface CloudCtx {
    kb: { organization_id?: string | null };
    log: (...a: unknown[]) => void;
    partial?: boolean;
}


interface CloudDeps {
    resolveLinker: (source: Record<string, unknown>, opts: { orgId: string | null; accept: string }) => Promise<{ api: FileApi }>;
    markerEquals: (provider: string, a: Marker, b: Marker) => boolean;
    extract: (buffer: Buffer, mime: string, filename: string) => Promise<{ text: string; meta: { pageCount: number | null; sheetNames: string[] | null } }>;
}

/** The engine's `deps`, which a test may extend with `cloud` to replace the storage and the extractor. */
type EngineDeps = object | undefined;

const ACCEPT = 'documents';
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_MB = 50;
const DEFAULT_POLL_SECONDS = 300;
/** Remembered extraction failures, so an unreadable file is not downloaded again every few minutes. */
const FAILED_MEMORY = 5000;

const PROVIDER_NAME: Record<string, string> = {
    nextcloud_files: 'Nextcloud',
    onedrive: 'OneDrive',
    google_drive: 'Google Drive',
};

// ─── Limits ─────────────────────────────────────────────────────────────

function limitFromEnv(name: string, fallback: number): number {
    const { envByteLimit } = nodeRequire('../../http/httpResponseLimits.js') as { envByteLimit: (n: string, f: number) => number };
    return envByteLimit(name, fallback);
}

/** Files one pass lists, KB_CLOUD_MAX_FILES (0 = no limit). */
export function maxFiles(): number {
    return limitFromEnv('KB_CLOUD_MAX_FILES', DEFAULT_MAX_FILES);
}

/** Bytes of the largest file that is read, KB_CLOUD_MAX_FILE_MB (0 = no limit). */
export function maxFileBytes(): number {
    return limitFromEnv('KB_CLOUD_MAX_FILE_MB', DEFAULT_MAX_FILE_MB) * 1024 * 1024;
}

/** Seconds between two checks of an "on change" folder, KB_CLOUD_CHANGE_POLL_SECONDS. */
export function changePollSeconds(): number {
    const n = Number(process.env.KB_CLOUD_CHANGE_POLL_SECONDS);
    return process.env.KB_CLOUD_CHANGE_POLL_SECONDS && Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_SECONDS;
}

/** The engine's own per-pass item ceiling for this kind: the file cap, read when the module loads. */
export const maxItems: number = maxFiles();

// ─── Wiring ─────────────────────────────────────────────────────────────

function defaultDeps(): CloudDeps {
    return {
        resolveLinker: (source, opts) => nodeRequire('../../dataEngine/sources/spreadsheetFile/linkerAuth.js').resolveLinker(source, opts),
        markerEquals: (provider, a, b) => nodeRequire('../../dataEngine/sources/spreadsheetFile/providers/index.js').providerFor(provider).markerEquals(a, b),
        extract: (buffer, mime, filename) => nodeRequire('../kbFileExtract.js').extractFileContentWithMeta(buffer, mime, filename),
    };
}

function depsOf(deps: EngineDeps): CloudDeps {
    const override = deps ? (deps as { cloud?: Partial<CloudDeps> }).cloud : undefined;
    return { ...defaultDeps(), ...(override || {}) };
}

const documentsHelpers = () => nodeRequire('../../dataEngine/sources/spreadsheetFile/providers/documents.js') as {
    exportFor: (mime: string | null | undefined) => { ext: string; mime: string } | null;
    mimeForFormat: (format: string | null | undefined) => string;
};

type CodedError = Error & { code?: string };

function cloudError(code: string, message: string): CodedError {
    return Object.assign(new Error(message), { code });
}

/**
 * The spreadsheet mirror words its refusals for "the account that linked this table". A folder
 * source says "the person who added this folder"; the rest passes through unchanged.
 */
export function friendlyError(e: unknown, provider: string): Error {
    const err = (e && typeof e === 'object' ? e : {}) as { code?: string; message?: string; detail?: unknown };
    const name = PROVIDER_NAME[provider] || 'the storage';
    switch (err.code) {
        case 'provider_not_connected':
            return cloudError(err.code, err.detail === 'needs_reauth'
                ? `${name} needs to be reconnected by the person who added this folder: reconnect it under Settings, Connections.`
                : `The person who added this folder is not connected to ${name}: connect it under Settings, Connections.`);
        case 'provider_integration_off':
            return cloudError(err.code, `${name} is switched off for the person who added this folder.`);
        case 'linker_unavailable':
            return cloudError(err.code, `${name} could not be reached with the account of the person who added this folder. It may need to be reconnected.`);
        case 'nc_scope_denied':
            return cloudError(err.code, 'The person who added this folder no longer shares it with Bee Flow.');
        case 'nc_instance_changed':
            return cloudError(err.code, 'This organisation is connected to a different Nextcloud than the one this folder was added from.');
        case 'spreadsheet_forbidden':
            return cloudError(err.code, `${name} refused: the person who added this folder may not read it there.`);
        case 'spreadsheet_not_found':
            return cloudError(err.code, `${name} no longer has this folder.`);
        default:
            return e instanceof Error ? e : new Error(String(err.message || e));
    }
}

const linkers = new WeakMap<object, Promise<{ api: FileApi }>>();

/** The storage client for this pass: resolved once per pass, as the person who added the folder. */
function linkerFor(source: CloudSource, ctx: CloudCtx, deps: EngineDeps): Promise<{ api: FileApi }> {
    const cached = linkers.get(ctx);
    if (cached) return cached;
    const cfg = source.config || {};
    const provider = String(cfg.provider);
    const pending = (async () => {
        if (!source.createdBy) {
            throw cloudError('linker_unavailable', 'The person who added this folder is no longer in Bee Flow. Add the folder again.');
        }
        try {
            return await depsOf(deps).resolveLinker({
                provider,
                file: provider === 'nextcloud_files' ? { path: cfg.path || '/' } : { id: cfg.folderId || '' },
                linkedByUserId: source.createdBy,
                ...(cfg.ncInstanceId ? { ncInstanceId: cfg.ncInstanceId } : {}),
            }, { orgId: ctx.kb?.organization_id || null, accept: ACCEPT });
        } catch (e) {
            throw friendlyError(e, provider);
        }
    })();
    linkers.set(ctx, pending);
    // A failed resolve must not stay cached for a retry inside the same pass object.
    pending.catch(() => linkers.delete(ctx));
    return pending;
}

// ─── Walking the folder ─────────────────────────────────────────────────

/** The files of the folder (and, when `recursive`, of the folders below it): see ./cloudFolderWalk.mts. */
export async function enumerate(source: CloudSource, ctx: CloudCtx, deps?: EngineDeps): Promise<CloudItem[]> {
    const cfg = source.config || {};
    const { api } = await linkerFor(source, ctx, deps);
    return walkFolder(api, cfg, maxFiles(), ctx, (e) => friendlyError(e, String(cfg.provider)));
}

// ─── Change detection ───────────────────────────────────────────────────

/** The storage's own marker of the listing against the one stored on the document; an errored document is retried. */
export function isUnchanged(item: CloudItem, stored: Record<string, unknown>, deps?: EngineDeps): boolean {
    if (stored.status === 'error') return false;
    let meta = stored.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const previous = meta && typeof meta === 'object' ? (meta as { marker?: Marker }).marker : null;
    if (!previous || typeof previous !== 'object' || !item.marker) return false;
    return depsOf(deps).markerEquals(item.provider, item.marker, previous);
}

/**
 * "Has anything changed since the last complete pass?", asked of the storage before anything is
 * listed (see ./precheck.js). The cursor is kept in `config.syncCursor`; any problem with it
 * re-anchors and runs the pass.
 */
export async function precheck(source: CloudSource, ctx: CloudCtx, deps?: EngineDeps): Promise<{ changed: boolean; cursor?: string }> {
    const cfg = source.config || {};
    const { api } = await linkerFor(source, ctx, deps);
    if (typeof api.changeCursor !== 'function') return { changed: true };
    const folder = { folderId: cfg.folderId || null, driveId: cfg.driveId || null, path: cfg.path || null };
    const stored = typeof cfg.syncCursor === 'string' && cfg.syncCursor ? cfg.syncCursor : null;
    try {
        const verdict = await api.changeCursor(folder, stored);
        return { changed: verdict.changed !== false || !stored, ...(verdict.cursor ? { cursor: verdict.cursor } : {}) };
    } catch (e) {
        ctx.log(`cloud folder: the change check failed (${(e as Error).message}); running the full pass`);
        if (!stored) return { changed: true };
    }
    // The stored cursor may have expired (a delta link, a page token): anchor afresh and run the pass.
    try {
        const verdict = await api.changeCursor(folder, null);
        return { changed: true, ...(verdict.cursor ? { cursor: verdict.cursor } : {}) };
    } catch {
        return { changed: true };
    }
}

// ─── Reading a file ─────────────────────────────────────────────────────

const failed = new Map<string, string>();

function rememberFailure(key: string, reason: string): void {
    if (failed.size >= FAILED_MEMORY) failed.delete(failed.keys().next().value as string);
    failed.set(key, reason);
}

/** For tests: forget which files could not be read. */
export function forgetFailures(): void {
    failed.clear();
}

function megabytes(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
}

/**
 * Download one file, extract its text and hand the engine the document: the text for the index,
 * the file itself as `original` (the engine decides whether the knowledge base keeps it).
 */
export async function fetch(item: CloudItem, stored: Record<string, unknown> | null, ctx: CloudCtx & { source?: CloudSource }, deps?: EngineDeps) {
    const source = ctx.source as CloudSource;
    const { api } = await linkerFor(source, ctx, deps);
    const limit = maxFileBytes();
    const memory = `${source.id}|${item.externalId}|${JSON.stringify(item.marker)}`;
    const remembered = failed.get(memory);
    if (remembered) throw new Error(remembered);
    if (item.size != null && item.size > limit) {
        // Not remembered: this costs nothing to find out again, and an admin may raise the limit.
        throw new Error(`"${item.name}" is ${megabytes(item.size)} MB; the limit is ${megabytes(limit)} MB (KB_CLOUD_MAX_FILE_MB).`);
    }

    const downloaded = await api.download({
        provider: item.provider, fileId: item.fileId, driveId: item.driveId, path: item.path, name: item.name,
        mimeType: item.mimeType, format: item.format,
    }, { maxBytes: Number.isFinite(limit) ? limit : null }).catch((e: unknown) => { throw friendlyError(e, item.provider); });

    const docs = documentsHelpers();
    const exported = docs.exportFor(item.mimeType);
    const mime = exported ? exported.mime : docs.mimeForFormat(item.format);
    const filename = exported && !/\.[a-z0-9]+$/i.test(item.name) ? `${item.name}.${exported.ext}` : item.name;

    let extracted: Awaited<ReturnType<CloudDeps['extract']>>;
    try {
        extracted = await depsOf(deps).extract(downloaded.buffer, mime, filename);
    } catch (e) {
        const reason = `"${item.name}" could not be read: ${(e as Error).message}`;
        rememberFailure(memory, reason);
        throw new Error(reason);
    }
    if (!extracted.text || extracted.text.trim().length < 3) {
        const reason = `"${item.name}" has no text to read.`;
        rememberFailure(memory, reason);
        throw new Error(reason);
    }

    // The marker probed BEFORE the bytes (the provider's download answers it), so a change in between is caught next pass.
    const marker = downloaded.marker || item.marker;
    return {
        content: extracted.text,
        title: item.name,
        sourceType: 'cloud_folder',
        sourceUri: item.webUrl,
        sourceModifiedAt: item.modifiedAt,
        sizeBytes: downloaded.buffer.length,
        mime,
        pageCount: extracted.meta.pageCount,
        sheetCount: extracted.meta.sheetNames ? extracted.meta.sheetNames.length : null,
        // An explicit allow-list: never the listing's own object, never a token or a download link.
        metadata: { marker, provider: item.provider, path: item.path, webUrl: item.webUrl },
        original: { buffer: downloaded.buffer, mime, filename },
    };
}

export const supportsModes = ['manual', 'schedule', 'on_change'];
export const defaultMode = 'manual';
