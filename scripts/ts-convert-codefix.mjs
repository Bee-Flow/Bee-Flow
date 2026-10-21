#!/usr/bin/env node
// JavaScript -> TypeScript conversion of agent-hub files by TOOLING, no model.
//
// Per file: `git mv` to .ts/.tsx, then the TypeScript language service's own
// quick fixes add the types (the same fixes an editor offers on a red squiggle):
//   - annotateWithTypeFromJSDoc  turns `@param {string} x` into `x: string`
//   - inferFromUsage             types a parameter from how it is used and called
// A quick fix whose inserted text contains `any` is refused (the conversion
// rules forbid it), so what the tooling cannot type stays an error for the next
// step. The language service is TypeScript 6's (the JS API; TypeScript 7 has no
// stable one yet); the typecheck that decides stays `npm run typecheck` (tsc 7).
//
//   node scripts/ts-convert-codefix.mjs --batch .claude/handoff/ts-conversion/batches/NN.txt
//   node scripts/ts-convert-codefix.mjs --files src/a.jsx,src/b.js [--dry]
//
// Prints JSON: per file the target, the fixes applied and refused, and the
// diagnostics that remain in that file. The remaining work (types the tooling
// could not find) goes to a person or an agent under the rules in
// .claude/handoff/ts-conversion/README.md, and `scripts/ts-equivalence.mjs`
// proves the result compiles to the same JavaScript.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEdits, inferFile } from './ts-callsite-types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

export const FIX_IDS = ['annotateWithTypeFromJSDoc', 'inferFromUsage'];

/** True when a quick fix would write a forbidden type into the file. */
export function forbiddenInsert(text) {
    return /\bany\b|\bFunction\b|@ts-|\bunknown\b\s*as\b/.test(text);
}

export function targetName(file, source) {
    if (file.endsWith('.jsx')) return file.replace(/\.jsx$/, '.tsx');
    return file.replace(/\.js$/, /<[A-Za-z][\w.]*[\s/>]|<>/.test(source) ? '.tsx' : '.ts');
}

/** Apply text changes (sorted descending so offsets stay valid). */
export function applyChanges(text, changes) {
    const sorted = [...changes].sort((a, b) => b.span.start - a.span.start);
    let out = text;
    for (const c of sorted) out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
    return out;
}

function loadTs() {
    return createRequire(path.join(HUB, 'package.json'))('typescript');
}

function createService(ts, overrides) {
    const configPath = path.join(HUB, 'tsconfig.json');
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, HUB);
    const versions = new Map();
    const files = new Set(parsed.fileNames.map((f) => path.resolve(f)));
    for (const f of overrides.keys()) files.add(f);
    const host = {
        getScriptFileNames: () => [...files],
        getScriptVersion: (f) => String(versions.get(f) || 0),
        getScriptSnapshot: (f) => {
            const text = overrides.has(f) ? overrides.get(f) : ts.sys.readFile(f);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => HUB,
        getCompilationSettings: () => parsed.options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => overrides.has(f) || ts.sys.fileExists(f),
        readFile: (f) => (overrides.has(f) ? overrides.get(f) : ts.sys.readFile(f)),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const update = (f, text) => { overrides.set(f, text); versions.set(f, (versions.get(f) || 0) + 1); };
    return { service, update };
}

const FORMAT = { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: 'insert' };
const PREFS = { quotePreference: 'single', importModuleSpecifierPreference: 'relative', includeCompletionsForModuleExports: false };

/** One file: per round every non-overlapping allowed quick fix at once, until a round adds nothing. */
function fixFile(ts, svc, abs, inferred) {
    const applied = []; const refused = new Set();
    for (let round = 0; round < 6; round++) {
        const taken = [];
        for (const d of svc.service.getSemanticDiagnostics(abs)) {
            if (d.start === undefined) continue;
            const key = `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
            if (refused.has(key)) continue;
            let fixes;
            try { fixes = svc.service.getCodeFixesAtPosition(abs, d.start, d.start + d.length, [d.code], FORMAT, PREFS); } catch { refused.add(key); continue; }
            const fix = fixes.find((f) => FIX_IDS.includes(f.fixId));
            if (!fix || fix.changes.some((c) => path.resolve(c.fileName) !== abs)) { refused.add(key); continue; }
            const changes = fix.changes.flatMap((c) => c.textChanges);
            if (!changes.length || changes.some((c) => forbiddenInsert(c.newText))) { refused.add(key); continue; }
            const overlaps = changes.some((c) => taken.some((t) => c.span.start <= t.span.start + t.span.length && t.span.start <= c.span.start + c.span.length));
            if (overlaps) continue; // next round
            taken.push(...changes); applied.push(fix.fixId);
        }
        if (!taken.length) break;
        svc.update(abs, applyChanges(svc.service.getProgram().getSourceFile(abs).text, taken));
    }
    const remaining = svc.service.getSemanticDiagnostics(abs).concat(svc.service.getSyntacticDiagnostics(abs));
    return { applied, callsites: inferred.report, refused: refused.size, remaining: remaining.map((d) => ({ code: d.code, line: d.file ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') })) };
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const batch = arg('--batch'); const list = arg('--files');
    if (!batch && !list) { console.error('usage: --batch <list file> | --files a,b [--dry]'); process.exit(2); }
    const dry = process.argv.includes('--dry');
    const files = (batch ? fs.readFileSync(batch, 'utf8').split('\n') : list.split(','))
        .map((l) => l.trim()).filter(Boolean).filter((f) => fs.existsSync(path.join(HUB, f)));
    const ts = loadTs();
    const overrides = new Map(); const plan = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(HUB, file), 'utf8');
        const target = targetName(file, source);
        const abs = path.resolve(HUB, target);
        overrides.set(abs, source);
        plan.push({ file, target, abs });
    }
    // The old names must vanish from the program, or the imports still resolve to them.
    const gone = new Set(plan.map((p) => path.resolve(HUB, p.file)));
    const origExists = ts.sys.fileExists; const origRead = ts.sys.readFile;
    ts.sys.fileExists = (f) => !gone.has(path.resolve(f)) && origExists(f);
    ts.sys.readFile = (f, e) => (gone.has(path.resolve(f)) ? undefined : origRead(f, e));
    const origReadDir = ts.sys.readDirectory;
    ts.sys.readDirectory = (...a) => origReadDir(...a).filter((f) => !gone.has(path.resolve(f)));
    const svc = createService(ts, overrides);
    const t0 = Date.now(); const result = [];
    // Call-site pass first, over the whole batch until nothing new is typed:
    // a function typed in one pass makes its callers' arguments typed in the next.
    const reports = new Map(plan.map((p) => [p.abs, []]));
    for (let pass = 0; pass < 5; pass++) {
        let n = 0;
        for (const p of plan) {
            const inf = inferFile(ts, svc.service, p.abs);
            reports.set(p.abs, inf.report);
            if (!inf.edits.length) continue;
            svc.update(p.abs, applyEdits(svc.service.getProgram().getSourceFile(p.abs).text, inf.edits));
            n += inf.edits.length;
        }
        console.error(`call-site pass ${pass + 1}: ${n} edits`);
        if (!n) break;
    }
    for (const p of plan) {
        const r = fixFile(ts, svc, p.abs, { report: reports.get(p.abs) });
        const text = overrides.get(p.abs);
        if (!dry) {
            execFileSync('git', ['-C', HUB, 'mv', p.file, p.target]);
            fs.writeFileSync(p.abs, text);
        }
        result.push({ file: p.file, target: p.target, applied: r.applied.length, callsites: r.callsites, refused: r.refused, remaining: r.remaining });
        console.error(`${r.remaining.length ? 'open ' : 'clean'} ${p.target} (+${r.applied.length} fixes, ${r.refused} refused, ${r.remaining.length} left)`);
    }
    console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), files: result }, null, 1));
}
