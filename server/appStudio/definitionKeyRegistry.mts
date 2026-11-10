/**
 * App Studio — the registry of top-level definition keys added after the
 * frozen base (meta, theme, roles, variables, screens, actions, design, nav,
 * publicAccess, aiBrowsing, homeScreenId are built by canonicalize/definition.js
 * itself and are NOT in here).
 *
 * One file per key: `definitionKeys/<key>.js`, found by a sorted directory
 * read, exporting
 *
 *   { key, since, canon, validate, public: false }
 *
 *   key      the top-level key; must equal the file name
 *   since    the schema version that introduced it (3 or higher)
 *   canon    (value, push, ctx) => canonical value, or undefined to drop the key.
 *            Only called when the key is present: an absent key stays absent.
 *            ctx: { renameMap, screenIds }
 *   validate (value, ctx) => void, optional. ctx: { def, pushE, pushW }
 *   public   true sends the key to an anonymous visitor of a public page.
 *            Anything else keeps it out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type Push = (code: string, path: string, message: string) => void;
export interface CanonContext { renameMap: unknown; screenIds: Set<string> }
export interface Finding { code: string; severity: string; path: string; message: string; hint?: string }
export interface ValidateContext { def: Record<string, unknown>; pushE: (f: Finding) => void; pushW: (f: Finding) => void }
export interface DefinitionKeyEntry {
    key: string;
    since: number;
    canon: (value: unknown, push: Push, ctx: CanonContext) => unknown;
    validate?: (value: unknown, ctx: ValidateContext) => void;
    public?: boolean;
}

/** Keys the canonicalizer builds itself: a registry entry may never claim one. */
export const BASE_DEFINITION_KEYS: readonly string[] = Object.freeze([
    'schemaVersion', 'meta', 'theme', 'homeScreenId', 'roles', 'variables', 'screens', 'actions',
    'design', 'nav', 'publicAccess', 'aiBrowsing',
]);

const KEYS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definitionKeys');
const requireEntry = createRequire(import.meta.url);

/** Throws on a malformed entry: a broken registry file must fail the boot, not drop a key in silence. */
export function checkEntry(entry: unknown, fileKey: string | null = null): DefinitionKeyEntry {
    const e = entry as Partial<DefinitionKeyEntry> | null;
    const where = fileKey ? `definitionKeys/${fileKey}.js` : 'definition key entry';
    if (!e || typeof e !== 'object') throw new Error(`${where}: must export an object.`);
    if (typeof e.key !== 'string' || !e.key) throw new Error(`${where}: "key" must be a non-empty string.`);
    if (fileKey !== null && e.key !== fileKey) throw new Error(`${where}: "key" (${e.key}) must equal the file name.`);
    if (BASE_DEFINITION_KEYS.includes(e.key)) throw new Error(`${where}: "${e.key}" is a base key.`);
    if (!Number.isInteger(e.since) || (e.since as number) < 3) throw new Error(`${where}: "since" must be an integer of 3 or higher.`);
    if (typeof e.canon !== 'function') throw new Error(`${where}: "canon" must be a function.`);
    if (e.validate !== undefined && typeof e.validate !== 'function') throw new Error(`${where}: "validate" must be a function when present.`);
    return e as DefinitionKeyEntry;
}

/** Every `<key>.js` in `dir`, sorted by file name. A missing directory is an empty registry. */
export function loadDefinitionKeys(dir: string = KEYS_DIR): DefinitionKeyEntry[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
    }
    return names
        .filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))
        .sort()
        .map((n) => checkEntry(requireEntry(path.join(dir, n)), n.slice(0, -'.js'.length)));
}

let entries: DefinitionKeyEntry[] | null = null;

/** The registered keys, in file-name order. */
export function definitionKeys(): DefinitionKeyEntry[] {
    if (!entries) entries = loadDefinitionKeys();
    return entries;
}

/** Test-only: run `fn` with `list` as the registry. */
export function _withDefinitionKeys<T>(list: unknown[], fn: () => T): T {
    const before = entries;
    entries = list.map((e) => checkEntry(e));
    try {
        return fn();
    } finally {
        entries = before;
    }
}
