/**
 * App Studio asset store, the I/O half (the pure rules are in appAssets.mts).
 *
 * Stored exactly like a record attachment, so there is one storage envelope and one quota:
 *   - the ledger row is a studio_app_attachments row under the app OWNER, with
 *     field_key ASSET_FIELD_KEY and no record;
 *   - the bytes sit content-addressed in the owner's prefix (storageStore
 *     buildStudioAppAttachmentKey), and a blob is only deleted when no ledger row
 *     (asset or attachment) still names its sha256;
 *   - an upload is a quarantine flow: quota, put, scan, and only a clean scan writes the row.
 *
 * The quota is the app's attachment quota (count, per-file size, total bytes) plus the asset
 * limits of their own (appAssets.mts ASSET_LIMITS and the operator budget).
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ASSET_FIELD_KEY, ASSET_LIMITS, assetRef, assetTotalBytesBudget, collectAssetRefs, isAppAssetRow } from './appAssets.mts';

const nodeRequire = createRequire(import.meta.url);

export interface AssetApp { id: string; userId: string; definition?: unknown; publishedDefinition?: unknown }
export interface AssetRow { id: string; fieldKey: string | null; mimeType: string; sha256: string; size: number; scanned: boolean; quarantined: boolean; createdAt: string | null }
export interface AssetView { id: string; ref: string; mime: string; size: number; createdAt: string | null; usedBy: { draft: string[]; published: string[] } }

type Ledger = {
    listAttachments: (appId: string, ownerId: string) => Promise<AssetRow[]>;
    getAttachment: (id: string, appId: string, ownerId: string) => Promise<AssetRow | null>;
    addAttachment: (appId: string, ownerId: string, row: { fieldKey: string; mimeType: string; sha256: string; size: number }) => Promise<AssetRow>;
    setAttachmentScan: (id: string, appId: string, ownerId: string, s: { scanned: boolean; quarantined: boolean }) => Promise<unknown>;
    deleteAttachment: (id: string, appId: string, ownerId: string) => Promise<boolean>;
    countAttachmentsBySha: (appId: string, ownerId: string, sha256: string) => Promise<number>;
};
type Storage = {
    isAvailable: () => boolean;
    uploadFile: (key: string, buffer: Buffer, contentType: string) => Promise<unknown>;
    deleteFile: (key: string) => Promise<unknown>;
    streamFile: (key: string) => Promise<{ stream: Readable; contentLength?: number; contentType?: string }>;
    buildStudioAppAttachmentKey: (ownerId: string, appId: string, sha256: string) => string;
};
type HttpErrorCtor = new (status: number, code: string, message: string) => Error;

const ledger = (): Ledger => nodeRequire('../stores/studioAppDataStore.js') as Ledger;
const storage = (): Storage => nodeRequire('../stores/storageStore.js') as Storage;
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: HttpErrorCtor };
const { bestEffort } = nodeRequire('../utils/bestEffort.js') as { bestEffort: (label: string, err: unknown) => void };

function keyOf(app: AssetApp, sha256: string): string {
    return storage().buildStudioAppAttachmentKey(app.userId, app.id, sha256);
}

/** The app's assets that passed the scan, newest first. */
export async function listAssetRows(app: AssetApp): Promise<AssetRow[]> {
    const rows = await ledger().listAttachments(app.id, app.userId);
    return (Array.isArray(rows) ? rows : []).filter((r) => isAppAssetRow(r) && r.scanned && !r.quarantined);
}

/** One asset of this app, or null: a record attachment, another app's file or a quarantined one is not an asset here. */
export async function getAssetRow(app: AssetApp, assetId: string): Promise<AssetRow | null> {
    const row = await ledger().getAttachment(assetId, app.id, app.userId);
    return row && isAppAssetRow(row) && !row.quarantined ? row : null;
}

/** The ids of the app's assets, for the validator's "this asset does not exist" warning. */
export async function listAssetIds(app: AssetApp): Promise<string[]> {
    return (await listAssetRows(app)).map((r) => r.id);
}

/** Each asset with the places the draft and the published definition name it. */
export async function listAssets(app: AssetApp): Promise<AssetView[]> {
    const draft = collectAssetRefs(app.definition);
    const published = collectAssetRefs(app.publishedDefinition);
    return (await listAssetRows(app)).map((r) => ({
        id: r.id,
        ref: assetRef(r.id),
        mime: r.mimeType,
        size: r.size,
        createdAt: r.createdAt,
        usedBy: { draft: draft.get(r.id) || [], published: published.get(r.id) || [] },
    }));
}

function quotaError(code: string, message: string, limit: number, used: number): Error {
    return Object.assign(new HttpError(409, code, message), { limit, used });
}

/** Refuse an upload of `size` bytes that would break an asset limit or the app's attachment quota. */
export async function assertAssetQuota(app: AssetApp, size: number): Promise<void> {
    const rows = await listAssetRows(app);
    if (rows.length >= ASSET_LIMITS.MAX_ASSETS_PER_APP) {
        throw quotaError('asset_limit', `An app holds at most ${ASSET_LIMITS.MAX_ASSETS_PER_APP} uploaded files. Delete one you no longer use.`, ASSET_LIMITS.MAX_ASSETS_PER_APP, rows.length);
    }
    const seen = new Set<string>();
    let used = 0;
    for (const r of rows) {
        if (r.sha256 && seen.has(r.sha256)) continue;
        seen.add(r.sha256);
        used += r.size;
    }
    const budget = assetTotalBytesBudget();
    if (used + size > budget) {
        throw quotaError('quota_exceeded', `The uploaded files of this app may take ${budget} bytes in total. Delete one you no longer use.`, budget, used);
    }
    const quota = nodeRequire('./studioAppQuota.js') as { assertAttachmentQuota: (a: AssetApp, n: number) => Promise<void> };
    const mail = nodeRequire('./mailboxAttachments.js') as { assertAttachmentTotalBytes: (a: AssetApp, n: number) => Promise<void> };
    await quota.assertAttachmentQuota(app, size);
    await mail.assertAttachmentTotalBytes(app, size);
}

/**
 * Store `bytes` (already sniffed as `mime`) as an asset: put, scan, then the ledger row.
 * A dirty scan removes the blob and is refused with a 422; the bytes are never linked.
 */
export async function storeAsset(app: AssetApp, bytes: Buffer, mime: string): Promise<AssetView> {
    if (!storage().isAvailable()) throw new HttpError(503, 'storage_unavailable', 'File storage is not available');
    await assertAssetQuota(app, bytes.length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = keyOf(app, sha256);
    await storage().uploadFile(key, bytes, mime);
    const { scanBuffer } = nodeRequire('../middleware/uploadGuard.js') as { scanBuffer: (b: Buffer) => Promise<{ clean: boolean }> };
    const verdict = await scanBuffer(bytes);
    if (!verdict.clean) {
        if ((await ledger().countAttachmentsBySha(app.id, app.userId, sha256)) === 0) await storage().deleteFile(key).catch((e: unknown) => bestEffort('appStudio/appAssetStore:dirty-blob', e));
        throw new HttpError(422, 'scan_failed', 'The file failed a malware scan and was refused.');
    }
    const row = await ledger().addAttachment(app.id, app.userId, { fieldKey: ASSET_FIELD_KEY, mimeType: mime, sha256, size: bytes.length });
    await ledger().setAttachmentScan(row.id, app.id, app.userId, { scanned: true, quarantined: false });
    return { id: row.id, ref: assetRef(row.id), mime, size: bytes.length, createdAt: row.createdAt, usedBy: { draft: [], published: [] } };
}

/** Delete one asset; its bytes go only when no other ledger row names them. False when it is not an asset of this app. */
export async function deleteAsset(app: AssetApp, assetId: string): Promise<boolean> {
    const row = await getAssetRow(app, assetId);
    if (!row) return false;
    await ledger().deleteAttachment(row.id, app.id, app.userId);
    const stillUsed = await ledger().countAttachmentsBySha(app.id, app.userId, row.sha256);
    if (stillUsed === 0 && row.sha256 && storage().isAvailable()) {
        // The row is gone, so the bytes no longer count; an orphan blob is a sweep matter.
        await storage().deleteFile(keyOf(app, row.sha256)).catch((e: unknown) => bestEffort('appStudio/appAssetStore:delete-blob', e));
    }
    return true;
}

/** The stored bytes of an asset, or null when the blob is missing. */
export async function openAsset(app: AssetApp, row: AssetRow): Promise<{ stream: Readable; contentLength?: number } | null> {
    try {
        return await storage().streamFile(keyOf(app, row.sha256));
    } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}
