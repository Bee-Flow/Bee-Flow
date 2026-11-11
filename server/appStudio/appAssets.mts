/**
 * App Studio asset store, the pure half: what an asset is, what may be uploaded, how much,
 * where a definition refers to one, and how one is served.
 *
 * An asset is a file of the APP (a logo, a picture, a font), not of a record. It is stored
 * the way a record attachment is (appAssetStore.mts): a row in the attachment ledger under
 * the app owner, the bytes content-addressed in the owner's storage prefix, so the app's
 * attachment count and total-bytes quota count it too. What marks the row as an asset is its
 * field key, ASSET_FIELD_KEY: a data-model field key can never contain a colon, so no file
 * column of any table matches it and the record-shaped read rule (attachmentAccess.js) never
 * lets the record routes serve or relink one.
 *
 * A definition refers to an asset with the string `asset:<id>` (componentSpecs/valueTypes.js
 * isAssetRef), today in image.src, image.srcFrom, design.logoUrl and publicAccess.design.logoUrl.
 * A rich markdown block names one inside its text, as ![alt](asset:<id>) (markdownAssets.mts).
 * collectAssetRefs finds every such string anywhere in a definition, so a later key that takes
 * the `asset` value type is covered without being named here. A stylesheet (design.customCss)
 * names an asset inside its text, as url(asset:<id>): those are collected from CSS_PATHS.
 *
 * Limits: the size of one file and the number of assets per app are constants (they decide
 * whether an app can be copied to another installation); the total bytes per app is an
 * operator budget, STUDIO_APP_ASSET_TOTAL_BYTES, 0 = unlimited. SVG is not accepted.
 */

import { createRequire } from 'node:module';
import { sniffMime } from './attachmentSniff.mts';
import { cssAssetIds } from './appCss.mts';
import { eachRichMarkdownAsset } from './markdownAssets.mts';

const nodeRequire = createRequire(import.meta.url);
const { isAssetRef } = nodeRequire('./componentSpecs/valueTypes.js') as { isAssetRef: (v: unknown) => v is string };

export { isAssetRef };

/** The attachment-ledger field key of an app asset. */
export const ASSET_FIELD_KEY = 'app:asset';
export const ASSET_PREFIX = 'asset:';
/** The schema version a definition that refers to an asset needs. */
export const ASSET_REF_SINCE = 3;

export const ASSET_LIMITS = Object.freeze({
    /** One file. A logo or a picture for a screen, not a photo archive. */
    MAX_ASSET_BYTES: 5 * 1024 * 1024,
    MAX_ASSETS_PER_APP: 200,
});

export const DEFAULT_ASSET_TOTAL_BYTES = 100 * 1024 * 1024;

/** Raster images and one font format. No SVG: it can carry script. */
export const ASSET_MIMES: readonly string[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'font/woff2']);

const MAX_WALK_DEPTH = 64;
const MAX_PATHS_PER_ASSET = 20;

/** The operator's per-app budget in bytes: the env value, the default when unset or not a whole number, Infinity for 0. */
export function assetTotalBytesBudget(env: Record<string, string | undefined> = process.env): number {
    const raw = String(env.STUDIO_APP_ASSET_TOTAL_BYTES ?? '').trim();
    if (!raw) return DEFAULT_ASSET_TOTAL_BYTES;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return DEFAULT_ASSET_TOTAL_BYTES;
    return n === 0 ? Infinity : n;
}

type LedgerRow = { id?: string; fieldKey?: string | null; recordId?: string | null; quarantined?: boolean; scanned?: boolean } | null | undefined;

/** True for a ledger row that is an app asset (and not a record attachment): the asset key, on no record. */
export function isAppAssetRow(row: LedgerRow): boolean {
    return !!row && row.fieldKey === ASSET_FIELD_KEY && !row.recordId;
}

/**
 * True for a field key a RECORD upload may carry. The ledger's field key of a record file comes
 * from the request, so the asset key is refused there: a form upload is never filed as an asset.
 */
export function isRecordFieldKey(value: unknown): boolean {
    return value !== ASSET_FIELD_KEY;
}

export function assetRef(id: string): string {
    return `${ASSET_PREFIX}${id}`;
}

/** The id inside `asset:<id>`, or null for anything else. */
export function assetIdOf(value: unknown): string | null {
    return isAssetRef(value) ? value.slice(ASSET_PREFIX.length) : null;
}

/** True for an id that `asset:<id>` accepts (letters, digits, `_`, `-`, 1..64). */
export function isAssetId(value: unknown): value is string {
    return typeof value === 'string' && isAssetRef(`${ASSET_PREFIX}${value}`);
}

/** WOFF2: the 'wOF2' tag and the header's total length equal to the file (the upload guard's rule). */
function isWoff2(bytes: Uint8Array): boolean {
    if (bytes.length < 48) return false;
    if (bytes[0] !== 0x77 || bytes[1] !== 0x4f || bytes[2] !== 0x46 || bytes[3] !== 0x32) return false;
    const total = ((bytes[8] << 24) >>> 0) + (bytes[9] << 16) + (bytes[10] << 8) + bytes[11];
    return total === bytes.length;
}

/** The type the BYTES say, when it is one an asset may have; null otherwise. The declared type is never used. */
export function sniffAssetMime(bytes: Uint8Array): string | null {
    if (isWoff2(bytes)) return 'font/woff2';
    const mime = sniffMime(bytes, {});
    return ASSET_MIMES.includes(mime) ? mime : null;
}

function joinPath(path: string, key: string | number): string {
    if (typeof key === 'number') return `${path}[${key}]`;
    return path ? `${path}.${key}` : key;
}

function walk(value: unknown, path: string, depth: number, out: Map<string, string[]>): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (typeof value === 'string') {
        const id = assetIdOf(value);
        if (!id) return;
        const paths = out.get(id) || [];
        if (paths.length < MAX_PATHS_PER_ASSET) paths.push(path);
        out.set(id, paths);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, joinPath(path, i), depth + 1, out));
        return;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, joinPath(path, k), depth + 1, out);
    }
}

/** Where a definition holds stylesheet text, which names an asset inside the text (appCss.mts). */
const CSS_PATHS: readonly (readonly string[])[] = [['design', 'customCss'], ['publicAccess', 'design', 'customCss']];

function valueAt(root: unknown, path: readonly string[]): unknown {
    let at: unknown = root;
    for (const key of path) {
        if (!at || typeof at !== 'object' || Array.isArray(at)) return undefined;
        at = (at as Record<string, unknown>)[key];
    }
    return at;
}

/** Every asset a definition refers to: id → the paths that name it (at most 20 each). */
export function collectAssetRefs(definition: unknown): Map<string, string[]> {
    const out = new Map<string, string[]>();
    walk(definition, '', 0, out);
    eachRichMarkdownAsset(definition, (id, path) => {
        const paths = out.get(id) || [];
        if (paths.length < MAX_PATHS_PER_ASSET) paths.push(path);
        out.set(id, paths);
    }, '', 0, MAX_WALK_DEPTH);
    for (const path of CSS_PATHS) {
        for (const id of cssAssetIds(valueAt(definition, path))) {
            const paths = out.get(id) || [];
            if (paths.length < MAX_PATHS_PER_ASSET) paths.push(path.join('.'));
            out.set(id, paths);
        }
    }
    return out;
}

/** True when the definition refers to any asset; stops at the first. */
export function hasAssetRef(value: unknown, depth = 0): boolean {
    if (depth > MAX_WALK_DEPTH) return false;
    if (typeof value === 'string') return isAssetRef(value);
    if (Array.isArray(value)) return value.some((item) => hasAssetRef(item, depth + 1));
    if (value && typeof value === 'object') return Object.values(value).some((v) => hasAssetRef(v, depth + 1));
    return false;
}

/**
 * Replace every asset reference in `definition` (in place) by null, and return the paths.
 * For a copy that leaves this app (template capture, export): the bytes do not travel yet,
 * and an `asset:<id>` of this app would point at nothing in the other one.
 */
export function stripAssetRefs(definition: unknown): string[] {
    const stripped: string[] = [];
    const visit = (holder: Record<string, unknown> | unknown[], key: string | number, path: string, depth: number): void => {
        const value = (holder as Record<string | number, unknown>)[key];
        if (typeof value === 'string') {
            if (isAssetRef(value)) { (holder as Record<string | number, unknown>)[key] = null; stripped.push(path); }
            return;
        }
        if (depth > MAX_WALK_DEPTH || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) value.forEach((_, i) => visit(value, i, joinPath(path, i), depth + 1));
        else for (const k of Object.keys(value)) visit(value as Record<string, unknown>, k, joinPath(path, k), depth + 1);
    };
    if (definition && typeof definition === 'object') {
        for (const k of Object.keys(definition)) visit(definition as Record<string, unknown>, k, k, 1);
    }
    return stripped;
}

/**
 * The headers an asset is served with: its sniffed type, never sniffed again by the browser,
 * no document of this origin (a sandbox with nothing allowed if it is ever opened directly),
 * and a long private cache: the id names bytes that never change.
 */
export function assetResponseHeaders(mime: string): Record<string, string> {
    return {
        'Content-Type': ASSET_MIMES.includes(mime) ? mime : 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'same-site',
    };
}
