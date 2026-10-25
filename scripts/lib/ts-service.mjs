// A long-lived TypeScript language service over one package (agent-hub), with an
// in-memory overlay so a script can apply edits, ask again, and write only when
// it is satisfied. Shared by api-relocate.mjs and jsx-extract.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `typescript` agent-hub locks (the language service API lives there). */
export function loadTs() {
    return createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
}

/** `noResolve` keeps the program to `only`: imports are still resolved but their targets are not pulled in. `only`: restrict the program to these files (a rename or an extract only needs the files that touch the subject; a whole-package program takes a minute per query). */
export function createService(pkgDir, ts = loadTs(), { only, noResolve = false } = {}) {
    const tsconfig = path.join(pkgDir, 'tsconfig.json');
    const cfg = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    if (!cfg) throw new Error(`cannot read ${tsconfig}`);
    const files = new Set(only ?? cfg.fileNames);
    const overlay = new Map(); // absolute path -> text ('' deletes via `removed`)
    const removed = new Set();
    const versions = new Map();
    const bump = (f) => versions.set(f, (versions.get(f) ?? 0) + 1);
    const read = (f) => (removed.has(f) ? undefined : overlay.has(f) ? overlay.get(f) : ts.sys.readFile(f));
    const host = {
        getScriptFileNames: () => [...files],
        getScriptVersion: (f) => String(versions.get(f) ?? 0),
        getScriptSnapshot: (f) => {
            const text = read(f);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        useCaseSensitiveFileNames: () => true, // ToolChooser.tsx and toolChooser.ts live side by side
        getCurrentDirectory: () => pkgDir,
        getCompilationSettings: () => (noResolve ? { ...cfg.options, noResolve: true } : cfg.options),
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: (f) => !removed.has(f) && (overlay.has(f) || ts.sys.fileExists(f)),
        readFile: read,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
    };
    const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
    return {
        ts,
        ls,
        options: cfg.options,
        files,
        read,
        /** Replace the text of a file (also adds it to the program). */
        set(f, text) { overlay.set(f, text); removed.delete(f); files.add(f); bump(f); },
        /** Drop a file from the program (the caller renames or deletes it on disk). */
        remove(f) { removed.add(f); overlay.delete(f); files.delete(f); bump(f); },
        /** Everything changed against the disk: { written: Map(path -> text), removed: Set }. */
        pending() { return { written: new Map(overlay), removed: new Set(removed) }; },
        /** Write the overlay to disk. */
        flush() {
            for (const f of removed) if (fs.existsSync(f)) fs.rmSync(f);
            for (const [f, text] of overlay) {
                fs.mkdirSync(path.dirname(f), { recursive: true });
                fs.writeFileSync(f, text);
            }
        },
        /** Apply TS file text changes (from getEditsForFileRename / getEditsForRefactor) to the overlay. */
        applyChanges(fileTextChanges) {
            for (const fc of fileTextChanges) {
                let text = fc.isNewFile ? '' : read(fc.fileName);
                if (text === undefined) continue;
                const sorted = [...fc.textChanges].sort((a, b) => b.span.start - a.span.start);
                for (const c of sorted) text = text.slice(0, c.span.start) + c.newText + text.slice(c.span.start + c.span.length);
                this.set(fc.fileName, text);
            }
        },
    };
}
