#!/usr/bin/env node
/**
 * `npm run typecheck` — type-check every server file that opted in with a
 * `// @typecheck` line in its header, and report errors for those files only.
 *
 * Why not `// @ts-check`: agent-hub's tests import server modules, so
 * agent-hub's own typecheck (strict, noImplicitAny) reaches most of the server
 * tree and honours every `// @ts-check` it finds — under ITS options. A server
 * file that passes this check would still break the frontend job (it did:
 * 364 errors from server/utils alone). A marker only this script reads keeps
 * the two checks independent, so the server can tighten at its own pace.
 *
 * How: one TypeScript program over the marked files, using
 * server/jsconfig.json's options (checkJs off). The compiler host hands tsc
 * each marked file with its `// @typecheck` line read as `// @ts-check` —
 * in memory only, same line, so positions in errors stay right. Whatever the
 * marked files require is loaded for its types but not checked. (checkJs on
 * for the whole program checks that entire require graph too and ran out of
 * a 2 GB heap on the CI runner with only utils/ marked.)
 *
 * Usage: node scripts/typecheck.mjs [--list]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'coverage']);
export const MARKER = /^\s*\/\/\s*@typecheck\b/m;

/** The opted-in files: `// @typecheck` within the first lines. */
export function checkedFiles(dir = SERVER_DIR, prefix = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) out.push(...checkedFiles(path.join(dir, entry.name), rel));
        } else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
            const head = readFileSync(path.join(dir, entry.name), 'utf8').split('\n').slice(0, 30).join('\n');
            if (MARKER.test(head)) out.push(rel);
        }
    }
    return out.sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const files = checkedFiles();
    if (process.argv.includes('--list')) {
        for (const f of files) console.log(f);
        process.exit(0);
    }
    if (files.length === 0) {
        console.log('typecheck: no server file carries // @typecheck yet');
        process.exit(0);
    }

    const ts = createRequire(path.join(SERVER_DIR, 'package.json'))('typescript');
    const configPath = path.join(SERVER_DIR, 'jsconfig.json');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) {
        console.error(ts.formatDiagnostic(read.error, formatHost()));
        process.exit(2);
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, SERVER_DIR, undefined, configPath);
    const absolute = files.map((f) => path.join(SERVER_DIR, f));
    const typesDir = path.join(SERVER_DIR, 'types');
    const ambient = readdirSafe(typesDir).filter((f) => f.endsWith('.d.ts')).map((f) => path.join(typesDir, f));
    const wanted = new Set(absolute.map((f) => path.normalize(f)));
    const options = { ...parsed.options, checkJs: false, noEmit: true };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    host.readFile = (fileName) => {
        const text = readFile(fileName);
        if (text === undefined || !wanted.has(path.normalize(fileName))) return text;
        return text.replace(MARKER, (m) => m.replace('@typecheck', '@ts-check'));
    };
    const program = ts.createProgram({ rootNames: [...absolute, ...ambient], options, host });

    const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    for (const sf of program.getSourceFiles()) {
        if (!wanted.has(path.normalize(sf.fileName))) continue;
        diagnostics.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
    }

    if (diagnostics.length > 0) {
        process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost()));
        console.error(`\ntypecheck: ${diagnostics.length} error(s) in files marked // @typecheck`);
        process.exit(1);
    }
    console.log(`typecheck: ${files.length} file(s) with // @typecheck, no errors`);

    function formatHost() {
        return { getCanonicalFileName: (f) => f, getCurrentDirectory: () => SERVER_DIR, getNewLine: () => '\n' };
    }
}

function readdirSafe(dir) {
    try { return readdirSync(dir); } catch { return []; }
}
