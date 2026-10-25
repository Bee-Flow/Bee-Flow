// A TypeScript 6 language service over the server's JavaScript, for the JSDoc codemods.
// TypeScript 7 (what `npm run typecheck` runs) has no JavaScript API; 6.0.3 lives in agent-hub.
// The service is only used to find places and to try an edit in memory: whether the edit
// stays is decided by the same diagnostics, and `npm run typecheck` decides in the end.

import fs from 'node:fs';
import path from 'node:path';
import { createService } from '../ts-convert-codefix.mjs';
import { loadTs } from '../ts-fix.mjs';
import { LEVEL_OPTIONS } from '../../server/scripts/typecheck.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export { LEVEL_OPTIONS };

/**
 * @param {string[]} files absolute paths
 * @param {{ level?: keyof typeof LEVEL_OPTIONS, serverDir?: string }} [opts]
 */
export function openServer(files, { level = 'noImplicitAny', serverDir = path.join(ROOT, 'server') } = {}) {
    const ts = loadTs();
    const overrides = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const svc = createService(ts, overrides, { configPath: path.join(serverDir, 'jsconfig.json'), baseDir: serverDir, options: { checkJs: true, ...LEVEL_OPTIONS[level] } });
    const text = (/** @type {string} */ f) => svc.service.getProgram().getSourceFile(f).text;
    const diagnostics = (/** @type {string} */ f) => svc.service.getSemanticDiagnostics(f);
    return { ts, svc, text, diagnostics, update: svc.update };
}

/** Insert `edits` ({ at, text }) into `text`, last position first so offsets stay valid. */
export function insertAll(text, edits) {
    let out = text;
    for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
    return out;
}

/**
 * Keep the edits that do not make the file worse. All together first; when that adds
 * diagnostics, one by one in order, each kept only if the count does not rise.
 * `count(text)` returns the file's diagnostic count for a candidate text.
 * @returns {{ kept: { at: number, text: string }[], text: string }}
 */
export function keepHarmless(original, edits, count) {
    const base = count(original);
    const all = insertAll(original, edits);
    if (count(all) <= base) return { kept: edits, text: all };
    const kept = [];
    let current = original;
    let now = base;
    // Offsets shift once an earlier edit is in: apply from the last position backwards on the ORIGINAL positions.
    for (const e of [...edits].sort((a, b) => b.at - a.at)) {
        const candidate = current.slice(0, e.at) + e.text + current.slice(e.at);
        const n = count(candidate);
        if (n <= now) { kept.push(e); current = candidate; now = n; }
    }
    return { kept, text: current };
}
