#!/usr/bin/env node
// Removes unused imports from TypeScript files with TypeScript's own quick fix
// ("Remove unused declaration"), and only imports: an unused `const x = f()`
// stays, because deleting it would delete the call. In a .ts/.tsx file an
// unused import is already dropped by the compiler (esbuild, Vite), so the
// emitted JavaScript does not change; the source just stops naming it.
// Imports without bindings (`import './x.css'`) are never touched.
//
//   node scripts/ts-remove-unused-imports.mjs agent-hub/src/a.tsx [more files]

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

const UNUSED = new Set([6133, 6192, 6196, 6198]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const ts = createRequire(path.join(HUB, 'package.json'))('typescript');
    const files = process.argv.slice(2).map((f) => path.resolve(f));
    const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(HUB, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, HUB);
    const options = { ...cfg.options, noUnusedLocals: true };
    const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const versions = new Map();
    const host = {
        getScriptFileNames: () => [...new Set([...cfg.fileNames.filter((f) => !/\.(test|spec)\./.test(f)), ...files])],
        getScriptVersion: (f) => String(versions.get(f) || 0),
        getScriptSnapshot: (f) => { const t = texts.has(f) ? texts.get(f) : ts.sys.readFile(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
        getCurrentDirectory: () => HUB,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: ts.sys.fileExists, readFile: (f) => (texts.has(f) ? texts.get(f) : ts.sys.readFile(f)),
        readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    const ls = ts.createLanguageService(host);
    let removed = 0;
    for (const f of files) {
        for (let guard = 0; guard < 100; guard++) {
            const sf = ls.getProgram().getSourceFile(f);
            const inImport = (pos) => { for (let n = ts.getTokenAtPosition(sf, pos); n; n = n.parent) if (ts.isImportDeclaration(n)) return n; return null; };
            let applied = false;
            for (const d of ls.getSuggestionDiagnostics(f).concat(ls.getSemanticDiagnostics(f))) {
                if (!UNUSED.has(d.code) || d.start === undefined) continue;
                const decl = inImport(d.start);
                if (!decl || !decl.importClause) continue;
                const fix = ls.getCodeFixesAtPosition(f, d.start, d.start + d.length, [d.code], {}, {}).find((x) => x.fixName === 'unusedIdentifier' && /^Remove (import|unused)/i.test(x.description));
                if (!fix) continue;
                const changes = fix.changes.filter((c) => path.resolve(c.fileName) === f).flatMap((c) => c.textChanges);
                // Only inside that import declaration (plus its line break).
                if (!changes.length || changes.some((c) => c.span.start < decl.getFullStart() || c.span.start + c.span.length > decl.getEnd() + 1)) continue;
                const text = [...changes].sort((a, b) => b.span.start - a.span.start).reduce((t, c) => t.slice(0, c.span.start) + c.newText + t.slice(c.span.start + c.span.length), texts.get(f));
                texts.set(f, text); versions.set(f, (versions.get(f) || 0) + 1);
                removed++; applied = true;
                break;
            }
            if (!applied) break;
        }
        fs.writeFileSync(f, texts.get(f));
    }
    console.error(`removed ${removed} unused import(s) in ${files.length} file(s)`);
}
