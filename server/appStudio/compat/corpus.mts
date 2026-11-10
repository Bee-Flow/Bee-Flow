/**
 * App Studio compatibility corpus: where the files live and how they are read.
 *
 * `corpus/<name>.json` is one app AS STORED: `{ about, definition, dataModel?, datasets? }`.
 * `definition` is the bytes a studio_apps row holds (draft or published), `dataModel` the
 * studio_app_data_meta model next to it, `datasets` the saved dataset descriptors.
 * `frozen/<name>.json` is what today's code does with that input (see expectations.mts and
 * readSql.mts). Neither file is ever rewritten once it is on main: scripts/check-compat-corpus.mjs
 * fails a pull request that modifies or deletes one. README.md says how to add one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Obj = Record<string, unknown>;

export interface CorpusEntry {
    name: string;
    about: Obj;
    definition: unknown;
    dataModel?: Obj;
    datasets?: Obj[];
}

export const COMPAT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = path.join(COMPAT_DIR, 'corpus');
export const FROZEN_DIR = path.join(COMPAT_DIR, 'frozen');

/** A corpus name: lower-case words joined by single dashes (it is also a file name). */
export function isCorpusName(name: string): boolean {
    if (!name || name.startsWith('-') || name.endsWith('-') || name.includes('--')) return false;
    for (const ch of name) {
        const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-';
        if (!ok) return false;
    }
    return true;
}

export function isObject(v: unknown): v is Obj {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function jsonNames(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
}

/** Every corpus input, sorted by name. */
export function corpusNames(): string[] {
    return jsonNames(CORPUS_DIR);
}

/** Every frozen expectation file, sorted by name. */
export function frozenNames(): string[] {
    return jsonNames(FROZEN_DIR);
}

export function corpusPath(name: string): string {
    return path.join(CORPUS_DIR, `${name}.json`);
}

export function frozenPath(name: string): string {
    return path.join(FROZEN_DIR, `${name}.json`);
}

export function readCorpus(name: string): CorpusEntry {
    const raw: unknown = JSON.parse(fs.readFileSync(corpusPath(name), 'utf8'));
    if (!isObject(raw) || !isObject(raw.about) || !('definition' in raw)) {
        throw new Error(`compat corpus ${name}: expected { about, definition, dataModel?, datasets? }`);
    }
    const entry: CorpusEntry = { name, about: raw.about, definition: raw.definition };
    if (isObject(raw.dataModel)) entry.dataModel = raw.dataModel;
    if (Array.isArray(raw.datasets)) entry.datasets = raw.datasets.filter(isObject);
    return entry;
}

export function readFrozen(name: string): Obj | null {
    const file = frozenPath(name);
    if (!fs.existsSync(file)) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(raw) ? raw : null;
}

/** The text a frozen file is written as: two-space JSON and a final newline. */
export function formatJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}
