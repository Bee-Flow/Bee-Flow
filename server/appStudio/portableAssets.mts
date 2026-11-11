/**
 * App Studio: the uploaded files of an app (appAssets.mts) as they travel in a copy of the app,
 * the pure half. The I/O half is portableAssetStore.mts.
 *
 * A copy that leaves the app (save as template, a template file, an app archive) carries the
 * files its definition refers to, as entries
 *
 *   { id, mime, sha256, size, data }      data: the bytes in base64
 *
 * keyed by the id the definition names (`asset:<id>`). The id is a name inside the copy and
 * nothing more: on install every file is stored again in the new app, gets that app's own id,
 * and the definition is rewritten to it (remapAssetRefs), in every place collectAssetRefs finds
 * one: a whole `asset:<id>` string, a picture in rich markdown, a url() in custom CSS.
 *
 * Reading entries from a copy decides everything again, exactly as an upload does
 * (readPortableAssets): the bytes must match their sha256, fit the size of one asset, and
 * SNIFF as a type an asset may have. The `mime` the copy declares is never used. The number of
 * files is the app's asset limit; their total bytes is an operator budget,
 * STUDIO_APP_PORTABLE_ASSET_BYTES (0 = unlimited). An entry the definition does not refer to
 * is left out. Storing (portableAssetStore.mts) runs the upload's malware scan and quotas.
 *
 * A copy that carries no file writes no `assets` key at all, so it is the same bytes as before.
 */

import { createHash } from 'node:crypto';
import { ASSET_LIMITS, ASSET_PREFIX, CSS_PATHS, bytesBudget, collectAssetRefs, isAssetId, isAssetRef, sniffAssetMime } from './appAssets.mts';

export const PORTABLE_ASSET_ENV = 'STUDIO_APP_PORTABLE_ASSET_BYTES';
/** Inside the 20 MB request body a template or archive file arrives in, base64 included. */
export const DEFAULT_PORTABLE_ASSET_BYTES = 10 * 1024 * 1024;

export interface PortableAsset { id: string; mime: string; sha256: string; size: number; data: string }
export interface PortableAssetsRead { assets: PortableAsset[]; bytes: number; dropped: string[] }

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const ID_MAX = 64;
const HEX = '0123456789abcdef';
const MAX_WALK_DEPTH = 64;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The budget in bytes for the files of one copy: the env value, the default when unset or not a whole number, Infinity for 0. */
export function portableAssetBudget(env: Record<string, string | undefined> = process.env): number {
    return bytesBudget(env[PORTABLE_ASSET_ENV], DEFAULT_PORTABLE_ASSET_BYTES);
}

export function sha256Of(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function isSha256(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 64) return false;
    for (const ch of value) if (!HEX.includes(ch)) return false;
    return true;
}

/** The ids a definition refers to. */
export function referencedAssetIds(definition: unknown): Set<string> {
    return new Set(collectAssetRefs(definition).keys());
}

function decode(data: unknown): Buffer | null {
    if (typeof data !== 'string' || !data) return null;
    const buffer = Buffer.from(data, 'base64');
    return buffer.length ? buffer : null;
}

/** One entry decided again, or why not. */
function readOne(raw: unknown): { asset: PortableAsset; buffer: Buffer } | { why: string } {
    if (!isObject(raw)) return { why: 'an entry that is not an object' };
    if (!isAssetId(raw.id)) return { why: 'an entry without a usable id' };
    const id = raw.id;
    const buffer = decode(raw.data);
    if (!buffer) return { why: `asset:${id} carries no readable bytes` };
    if (buffer.length > ASSET_LIMITS.MAX_ASSET_BYTES) return { why: `asset:${id} is over the ${ASSET_LIMITS.MAX_ASSET_BYTES} bytes one uploaded file may have` };
    const sha256 = sha256Of(buffer);
    if (!isSha256(raw.sha256) || raw.sha256 !== sha256) return { why: `asset:${id}: the bytes do not match the sha256 in the file` };
    const mime = sniffAssetMime(buffer);
    if (!mime) return { why: `asset:${id} is not a picture or font an app may hold (PNG, JPEG, WebP, GIF, WOFF2)` };
    return { asset: { id, mime, sha256, size: buffer.length, data: buffer.toString('base64') }, buffer };
}

/**
 * The entries of a copy, each decided again (see the header), limited to the ids in `wanted`.
 * Nothing throws: an entry that does not pass is left out and named in `dropped`.
 */
export function readPortableAssets(raw: unknown, wanted: Set<string>, env: Record<string, string | undefined> = process.env): PortableAssetsRead {
    const out: PortableAssetsRead = { assets: [], bytes: 0, dropped: [] };
    const budget = portableAssetBudget(env);
    const seen = new Set<string>();
    for (const entry of Array.isArray(raw) ? raw : []) {
        const read = readOne(entry);
        if ('why' in read) { out.dropped.push(read.why); continue; }
        const { asset } = read;
        if (seen.has(asset.id)) { out.dropped.push(`asset:${asset.id}: a second entry claims this id`); continue; }
        seen.add(asset.id);
        if (!wanted.has(asset.id)) continue; // not used by the app: nothing to carry it for
        if (out.assets.length >= ASSET_LIMITS.MAX_ASSETS_PER_APP) { out.dropped.push(`asset:${asset.id}: over the ${ASSET_LIMITS.MAX_ASSETS_PER_APP} files an app may hold`); continue; }
        if (out.bytes + asset.size > budget) { out.dropped.push(`asset:${asset.id}: the files together are over the ${budget} bytes a copy may carry (${PORTABLE_ASSET_ENV})`); continue; }
        out.bytes += asset.size;
        out.assets.push(asset);
    }
    out.assets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
}

/** Entries for a copy, from files this installation holds (already sniffed), sorted by id so a copy reads the same twice. */
export function writePortableAssets(files: Array<{ id: string; mime: string; bytes: Uint8Array }>): PortableAsset[] {
    return files
        .map((f) => ({ id: f.id, mime: f.mime, sha256: sha256Of(f.bytes), size: f.bytes.length, data: Buffer.from(f.bytes).toString('base64') }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every `asset:<id>` token inside a text, rewritten through `map`; ids not in it are left as they are (and counted, unless already a new id). */
export function remapTextAssetTokens(text: string, map: ReadonlyMap<string, string>): { text: string; changed: number; left: number } {
    const already = new Set(map.values());
    let out = '';
    let from = 0;
    let changed = 0;
    let left = 0;
    for (;;) {
        const at = text.indexOf(ASSET_PREFIX, from);
        if (at === -1) break;
        let end = at + ASSET_PREFIX.length;
        while (end < text.length && end - at - ASSET_PREFIX.length < ID_MAX && ID_CHARS.includes(text[end])) end += 1;
        const id = text.slice(at + ASSET_PREFIX.length, end);
        const next = id ? map.get(id) : undefined;
        out += text.slice(from, at + ASSET_PREFIX.length);
        if (next !== undefined) { out += next; changed += 1; } else { out += id; if (id && !already.has(id)) left += 1; }
        from = end;
    }
    return { text: out + text.slice(from), changed, left };
}

export interface RemapResult { remapped: number; cleared: string[]; textLeft: number }

function remapWhole(holder: Obj | unknown[], key: string | number, path: string, depth: number, map: ReadonlyMap<string, string>, out: RemapResult): void {
    const value = (holder as Record<string | number, unknown>)[key];
    if (typeof value === 'string') {
        if (!isAssetRef(value)) return;
        const next = map.get(value.slice(ASSET_PREFIX.length));
        (holder as Record<string | number, unknown>)[key] = next === undefined ? null : `${ASSET_PREFIX}${next}`;
        if (next === undefined) out.cleared.push(path); else out.remapped += 1;
        return;
    }
    if (depth > MAX_WALK_DEPTH || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((_, i) => remapWhole(value, i, `${path}[${i}]`, depth + 1, map, out)); return; }
    for (const k of Object.keys(value)) remapWhole(value as Obj, k, path ? `${path}.${k}` : k, depth + 1, map, out);
}

function remapText(holder: Obj, key: string, map: ReadonlyMap<string, string>, out: RemapResult): void {
    if (typeof holder[key] !== 'string') return;
    const r = remapTextAssetTokens(holder[key] as string, map);
    holder[key] = r.text;
    out.remapped += r.changed;
    out.textLeft += r.left;
}

/** The pictures of rich markdown blocks (markdownAssets.mts reads the same blocks). */
function remapMarkdown(value: unknown, depth: number, map: ReadonlyMap<string, string>, out: RemapResult): void {
    if (depth > MAX_WALK_DEPTH || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) remapMarkdown(item, depth + 1, map, out); return; }
    const node = value as Obj;
    if (node.type === 'markdown' && isObject(node.props) && node.props.rich === true) remapText(node.props, 'content', map, out);
    for (const item of Object.values(node)) remapMarkdown(item, depth + 1, map, out);
}

/**
 * Rewrite every asset reference of `definition` IN PLACE through `map` (copy id → new id).
 * A whole `asset:<id>` string whose id is not in the map becomes null (the file did not
 * arrive, and a pointer at nothing in this app helps nobody); a token inside markdown or CSS
 * text that is not in the map is left as it is (the text is the author's) and counted.
 */
export function remapAssetRefs(definition: unknown, map: ReadonlyMap<string, string>): RemapResult {
    const out: RemapResult = { remapped: 0, cleared: [], textLeft: 0 };
    if (!isObject(definition)) return out;
    for (const k of Object.keys(definition)) remapWhole(definition, k, k, 1, map, out);
    remapMarkdown(definition, 0, map, out);
    for (const path of CSS_PATHS) {
        let holder: unknown = definition;
        for (const key of path.slice(0, -1)) holder = isObject(holder) ? holder[key] : undefined;
        if (isObject(holder)) remapText(holder, path[path.length - 1], map, out);
    }
    return out;
}
