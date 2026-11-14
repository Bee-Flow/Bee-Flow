/**
 * App Studio: the uploaded files of an app as they travel in a copy, the I/O half (the rules are
 * in portableAssets.mts).
 *
 *   collectPortableAssets(app, definition)        the files a copy of this app carries
 *   carryAssetsInto(app, definition, assets)      store a copy's files in `app`, and the definition
 *                                                 rewritten to the ids they got there
 *   carryTemplateAssets({ app, definition, seed, assets })
 *                                                 the same for a template, whose sample rows may
 *                                                 name files too (seedAssets.mts)
 *   applyCopiedAssets({ app, definition, seed?, ... })
 *                                                 the same for an app that is already stored:
 *                                                 save the rewritten definition (and move the
 *                                                 template stamp onto it)
 *
 * Every file is stored through appAssetStore.storeAsset, the upload's own door: the type is
 * sniffed again from the bytes, the malware scan runs before the row is written, and the app's
 * asset limits and attachment quotas hold. A file whose bytes this app already holds (a template
 * upgrade carries the same logo again) is not stored twice: the existing id is used.
 *
 * Nothing here throws over one file: a file that does not arrive is named in the report, and
 * its whole-string references become null (portableAssets.remapAssetRefs).
 */

import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { ASSET_LIMITS, collectAssetRefs, sniffAssetMime } from './appAssets.mts';
import type { AssetApp, AssetRow, AssetView } from './appAssetStore.mts';
import { PORTABLE_ASSET_ENV, portableAssetBudget, readPortableAssets, referencedAssetIds, remapAssetRefs, writePortableAssets } from './portableAssets.mts';
import type { PortableAsset } from './portableAssets.mts';
import { seedAssetIds } from './seedAssets.mts';

const nodeRequire = createRequire(import.meta.url);

type Env = Record<string, string | undefined>;

export type AssetStoreDeps = {
    listAssetRows: (app: AssetApp) => Promise<AssetRow[]>;
    openAsset: (app: AssetApp, row: AssetRow) => Promise<{ stream: Readable } | null>;
    storeAsset: (app: AssetApp, bytes: Buffer, mime: string) => Promise<AssetView>;
};

type AppStore = {
    saveDefinition: (id: string, ownerId: string, def: unknown) => Promise<{ ok?: boolean } | null>;
    setTemplateStamp: (id: string, ownerId: string, stamp: { templateVersion?: number; templateInstallHash?: string }) => Promise<unknown>;
};

function storeDeps(given: Partial<AssetStoreDeps>): AssetStoreDeps {
    const store = (): AssetStoreDeps => nodeRequire('./appAssetStore.mts') as AssetStoreDeps;
    return {
        listAssetRows: given.listAssetRows || ((app) => store().listAssetRows(app)),
        openAsset: given.openAsset || ((app, row) => store().openAsset(app, row)),
        storeAsset: given.storeAsset || ((app, bytes, mime) => store().storeAsset(app, bytes, mime)),
    };
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A refusal that the next file would meet as well (a quota, no storage). */
function isTerminal(e: unknown): boolean {
    const status = (e as { status?: unknown } | null)?.status;
    return status === 409 || status === 503;
}

async function readAll(stream: Readable, max: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += piece.length;
        if (size > max) { stream.destroy(); return null; }
        chunks.push(piece);
    }
    return Buffer.concat(chunks);
}

export interface CollectResult { assets: PortableAsset[]; left: string[] }

/** The files `definition` refers to, read from `app`, as entries of a copy; what cannot go is named in `left`. */
export async function collectPortableAssets(app: AssetApp, definition: unknown, given: Partial<AssetStoreDeps> = {}, env: Env = process.env): Promise<CollectResult> {
    const wanted = [...collectAssetRefs(definition).keys()].sort();
    if (!wanted.length) return { assets: [], left: [] };
    const deps = storeDeps(given);
    const rows = new Map((await deps.listAssetRows(app)).map((r) => [r.id, r]));
    const budget = portableAssetBudget(env);
    const files: Array<{ id: string; mime: string; bytes: Buffer }> = [];
    const left: string[] = [];
    let bytes = 0;
    for (const id of wanted) {
        const row = rows.get(id);
        if (!row) { left.push(`asset:${id} is not among this app's uploaded files`); continue; }
        if (bytes + row.size > budget) { left.push(`asset:${id}: the files together are over the ${budget} bytes a copy may carry (${PORTABLE_ASSET_ENV})`); continue; }
        const opened = await deps.openAsset(app, row);
        const buffer = opened ? await readAll(opened.stream, ASSET_LIMITS.MAX_ASSET_BYTES) : null;
        const mime = buffer ? sniffAssetMime(buffer) : null;
        if (!buffer || !mime) { left.push(`asset:${id}: its bytes could not be read`); continue; }
        bytes += buffer.length;
        files.push({ id, mime, bytes: buffer });
    }
    return { assets: writePortableAssets(files), left };
}

export interface AssetCarryReport { carried: number; reused: number; cleared: number; skipped: string[] }

/** Store the entries `wanted` names in `app`: copy id → the id in this app. */
async function storeEntries(app: AssetApp, assets: unknown, wanted: Set<string>, deps: AssetStoreDeps, env: Env) {
    const read = readPortableAssets(assets, wanted, env);
    const map = new Map<string, string>();
    const skipped = [...read.dropped];
    const bySha = new Map<string, string>();
    for (const row of await deps.listAssetRows(app)) if (row.sha256 && !bySha.has(row.sha256)) bySha.set(row.sha256, row.id);
    let stored = 0;
    let reused = 0;
    for (const asset of read.assets) {
        const have = bySha.get(asset.sha256);
        if (have) { map.set(asset.id, have); reused += 1; continue; }
        try {
            const view = await deps.storeAsset(app, Buffer.from(asset.data, 'base64'), asset.mime);
            map.set(asset.id, view.id);
            bySha.set(asset.sha256, view.id);
            stored += 1;
        } catch (e) {
            skipped.push(`asset:${asset.id}: ${reason(e)}`);
            if (isTerminal(e)) break;
        }
    }
    return { map, stored, reused, skipped };
}

export interface CarryResult { definition: unknown; report: AssetCarryReport | null; ids: Map<string, string> }

/** Store the entries of `wanted` and rewrite a copy of `definition` to their ids here. */
async function carry(app: AssetApp, definition: unknown, assets: unknown, wanted: Set<string>, given: Partial<AssetStoreDeps>, env: Env): Promise<CarryResult> {
    if (!Array.isArray(assets) || !assets.length || !wanted.size) return { definition, report: null, ids: new Map() };
    const { map, stored, reused, skipped } = await storeEntries(app, assets, wanted, storeDeps(given), env);
    const copy = structuredClone(definition);
    const remap = remapAssetRefs(copy, map);
    return { definition: copy, report: { carried: stored, reused, cleared: remap.cleared.length, skipped }, ids: map };
}

/**
 * Store the files of a copy in `app` and return the definition rewritten to their ids there (a
 * new object; `definition` is not touched), and `ids`: copy id → id in this app. `report` is null
 * when the copy carries no file the definition refers to: then the definition is returned as it is.
 */
export async function carryAssetsInto(app: AssetApp, definition: unknown, assets: unknown, given: Partial<AssetStoreDeps> = {}, env: Env = process.env): Promise<CarryResult> {
    return carry(app, definition, assets, referencedAssetIds(definition), given, env);
}

/**
 * A template's files: the ones its definition AND its sample rows name (seedAssets.mts). The
 * installer writes the rows after this, through `ids`; a file that did not arrive is not in it.
 */
export async function carryTemplateAssets(opts: {
    app: AssetApp; definition: unknown; seed?: unknown; assets: unknown; deps?: Partial<AssetStoreDeps>; env?: Env;
}): Promise<CarryResult> {
    const wanted = new Set([...referencedAssetIds(opts.definition), ...seedAssetIds(opts.seed)]);
    return carry(opts.app, opts.definition, opts.assets, wanted, opts.deps || {}, opts.env || process.env);
}

/**
 * For an app that is already stored with the copy's definition (create from a template, an app
 * archive import): carry the files, save the rewritten definition, and when `templateVersion` is
 * given move the template stamp onto it, so the app stays "unchanged since install".
 */
export async function applyCopiedAssets(opts: {
    app: AssetApp; definition: unknown; assets: unknown; seed?: unknown; templateVersion?: number;
    deps?: Partial<AssetStoreDeps>; appStore?: AppStore; env?: Env;
}): Promise<CarryResult> {
    const carried = await carryTemplateAssets(opts);
    if (!carried.report) return carried;
    const appStore = opts.appStore || (nodeRequire('../stores/studioAppStore') as AppStore);
    const saved = await appStore.saveDefinition(opts.app.id, opts.app.userId, carried.definition);
    if (!saved || saved.ok === false) {
        carried.report.skipped.push('The uploaded files were stored, but the app could not be saved with their new references.');
        return { definition: opts.definition, report: carried.report, ids: carried.ids };
    }
    if (opts.templateVersion !== undefined) {
        const { hashDefinition } = nodeRequire('../core/packaging/definitionHash.mts') as { hashDefinition: (d: unknown) => string };
        await appStore.setTemplateStamp(opts.app.id, opts.app.userId, { templateVersion: opts.templateVersion, templateInstallHash: hashDefinition(carried.definition) });
    }
    return carried;
}
