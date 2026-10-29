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

import { applyEdits, inferFile, MISFIT, resetCaches, slotOfDiagnostic } from './ts-callsite-types.mjs';
import { mergeTypeImports } from './ts-merge-type-imports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

export const FIX_IDS = ['annotateWithTypeFromJSDoc', 'inferFromUsage', 'fixMissingMember'];

/** True when a quick fix would write a forbidden type into the file. */
export function forbiddenInsert(text) {
    return /\bany\b|\bFunction\b|@ts-|\bunknown\b\s*as\b/.test(text);
}

/** True when `source` holds JSX (parsed, so a `<` in a comment, string or comparison does not count). */
export function hasJsx(source) {
    const ts = loadTs();
    const sf = ts.createSourceFile('x.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let found = false;
    const visit = (n) => { if (found) return; if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) { found = true; return; } ts.forEachChild(n, visit); };
    visit(sf);
    return found;
}

export function targetName(file, source) {
    return file.replace(/\.jsx?$/, hasJsx(source) ? '.tsx' : '.ts');
}

/**
 * Apply text changes (sorted descending so offsets stay valid). Two inserts at
 * one offset keep the order the fix gave them: inferFromUsage types `t => ...`
 * in a JavaScript file as `(`, `/** @type {string} *\/ `, `)` at the same
 * position, and reversed the comment lands before the paren, binds to nothing,
 * and is written again on every round.
 */
export function applyChanges(text, changes) {
    const sorted = changes.map((c, i) => ({ c, i })).sort((a, b) => b.c.span.start - a.c.span.start || b.i - a.i).map((x) => x.c);
    let out = text;
    for (const c of sorted) out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
    return out;
}

function loadTs() {
    return createRequire(path.join(HUB, 'package.json'))('typescript');
}

export function createService(ts, overrides, { configPath = path.join(HUB, 'tsconfig.json'), baseDir = HUB, options: extra = {}, includeTests = /** @type {boolean | ((f: string) => boolean)} */ (false) } = {}) {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, baseDir);
    Object.assign(parsed.options, extra);
    const versions = new Map();
    // Tests are never a source of types here (their values are mocks), and they
    // are a third of the program: leaving them out makes the first build and
    // every reference search cheaper. A converted file is never a test.
    // includeTests: true keeps every test file, a function keeps the test files it says yes to
    // (the server driver wants the tests next to its batch, not the thousands of others).
    const keepTest = (f) => includeTests === true || (typeof includeTests === 'function' && includeTests(f));
    const files = new Set(parsed.fileNames.map((f) => path.resolve(f)).filter((f) => keepTest(f) || !/\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\//.test(f)));
    for (const f of overrides.keys()) files.add(f);
    const host = {
        getScriptFileNames: () => [...files],
        getScriptVersion: (f) => String(versions.get(f) || 0),
        getScriptSnapshot: (f) => {
            const text = overrides.has(f) ? overrides.get(f) : ts.sys.readFile(f);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => baseDir,
        getCompilationSettings: () => parsed.options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => overrides.has(f) || ts.sys.fileExists(f),
        readFile: (f) => (overrides.has(f) ? overrides.get(f) : ts.sys.readFile(f)),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    if (process.env.TS_CONVERT_PROFILE) {
        // Time per language-service call, printed at exit: where a run spends its minutes.
        const stats = {};
        for (const k of ['findReferences', 'getSemanticDiagnostics', 'getCodeFixesAtPosition', 'getProgram', 'getSyntacticDiagnostics']) {
            const f = service[k].bind(service);
            service[k] = (...a) => { const t = performance.now(); try { return f(...a); } finally { const ms = performance.now() - t; const s = (stats[k] ??= { n: 0, ms: 0, max: 0, slow: 0 }); s.n++; s.ms += ms; s.max = Math.max(s.max, ms); if (ms > 500) s.slow++; } };
        }
        process.on('exit', () => console.error(JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { n: v.n, s: Math.round(v.ms / 1000), maxS: Math.round(v.max / 100) / 10, over500ms: v.slow }])))));
    }
    const update = (f, text) => { overrides.set(f, text); versions.set(f, (versions.get(f) || 0) + 1); };
    return { service, update };
}

const FORMAT = { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: 'insert' };
const PREFS = { quotePreference: 'single', importModuleSpecifierPreference: 'relative', includeCompletionsForModuleExports: false };

/**
 * One round for one file: every non-overlapping allowed quick fix against the
 * current program. `refuse(newText)` lets a caller ban more than forbiddenInsert
 * does (the JSDoc driver refuses casts and `{null}`).
 */
export function fixRound(ts, svc, abs, state, { fixIds = FIX_IDS, refuse = (/** @type {string} */ _t, /** @type {{ span: { start: number, length: number } }} */ _c) => /** @type {boolean} */ (false) } = {}) {
    const taken = [];
    for (const d of svc.service.getSemanticDiagnostics(abs)) {
        if (d.start === undefined) continue;
        const key = `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
        if (state.refused.has(key)) continue;
        let fixes;
        try { fixes = svc.service.getCodeFixesAtPosition(abs, d.start, d.start + d.length, [d.code], FORMAT, PREFS); } catch { state.refused.add(key); continue; }
        const fix = fixes.find((f) => fixIds.includes(f.fixId));
        if (!fix || fix.changes.some((c) => path.resolve(c.fileName) !== abs)) { state.refused.add(key); continue; }
        let changes = fix.changes.flatMap((c) => c.textChanges);
        if (!changes.length || changes.some((c) => forbiddenInsert(c.newText) || refuse(c.newText, c))) { state.refused.add(key); continue; }
        if (fix.fixId === 'fixMissingMember') {
            // `this.host = host` in a JS class: the member goes in as `declare host: T;`,
            // which emits nothing (a plain field would, with useDefineForClassFields).
            // Only into a class or interface of this file; never an index signature.
            const sf = svc.service.getProgram().getSourceFile(abs);
            const intoClass = (pos) => { for (let n = ts.getTokenAtPosition(sf, pos); n; n = n.parent) { if (ts.isClassLike(n)) return 'class'; if (ts.isInterfaceDeclaration(n) || ts.isTypeLiteralNode(n)) return 'type'; } return null; };
            if (changes.some((c) => /^\s*\[/.test(c.newText) || /:\s*(null|undefined)\s*;/.test(c.newText))) { state.refused.add(key); continue; }
            const where = intoClass(changes[0].span.start);
            if (!where) { state.refused.add(key); continue; }
            if (where === 'class') changes = changes.map((c) => ({ ...c, newText: c.newText.replace(/^(\s*)(?!declare\b)([\w$]+\??:)/, '$1declare $2') }));
        }
        const overlaps = changes.some((c) => taken.some((t) => c.span.start <= t.span.start + t.span.length && t.span.start <= c.span.start + c.span.length));
        if (overlaps) continue; // next round
        taken.push(...changes); state.applied.push(fix.fixId);
    }
    return taken.length ? applyChanges(svc.service.getProgram().getSourceFile(abs).text, taken) : null;
}

/** All files, round by round: one program per round, every file's fixes applied together at its end. */
function fixAll(ts, svc, plan) {
    const states = new Map(plan.map((p) => [p.abs, { applied: [], refused: new Set() }]));
    let active = plan.map((p) => p.abs);
    for (let round = 0; round < 6 && active.length; round++) {
        const next = [];
        for (const abs of active) { const text = fixRound(ts, svc, abs, states.get(abs)); if (text) next.push([abs, text]); }
        for (const [abs, text] of next) svc.update(abs, text);
        active = next.map(([abs]) => abs);
    }
    return new Map(plan.map((p) => {
        const remaining = svc.service.getSemanticDiagnostics(p.abs).concat(svc.service.getSyntacticDiagnostics(p.abs));
        const st = states.get(p.abs);
        return [p.abs, { applied: st.applied, refused: st.refused.size, remaining: remaining.map((d) => ({ code: d.code, line: d.file ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') })) }];
    }));
}

/** `files` with every importer before what it imports (Kahn); files in a cycle keep their order at the end. */
export function orderByImports(files) {
    const set = new Set(files); const edges = new Map(files.map((f) => [f, new Set()])); const indeg = new Map(files.map((f) => [f, 0]));
    for (const f of files) {
        const src = fs.readFileSync(path.join(HUB, f), 'utf8');
        for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
            const base = path.join(path.dirname(f), m[1]).replace(/\.[jt]sx?$/, '');
            const t = files.find((c) => c !== f && (c.replace(/\.[jt]sx?$/, '') === base || c.replace(/\/index\.[jt]sx?$/, '') === base));
            if (t && set.has(t) && !edges.get(f).has(t)) { edges.get(f).add(t); indeg.set(t, indeg.get(t) + 1); }
        }
    }
    const out = []; const queue = files.filter((f) => indeg.get(f) === 0);
    while (queue.length) { const f = queue.shift(); out.push(f); for (const t of edges.get(f)) { indeg.set(t, indeg.get(t) - 1); if (!indeg.get(t)) queue.push(t); } }
    return out.concat(files.filter((f) => !out.includes(f)));
}

/** Connected components of the relative-import graph among `files` (paths relative to agent-hub). */
export function importGroups(files) {
    const set = new Set(files); const parent = new Map(files.map((f) => [f, f]));
    const find = (f) => { while (parent.get(f) !== f) { parent.set(f, parent.get(parent.get(f))); f = parent.get(f); } return f; };
    const resolve = (from, spec) => {
        const base = path.join(path.dirname(from), spec);
        for (const c of [base, ...['.js', '.jsx', '.ts', '.tsx'].map((e) => base.replace(/\.[jt]sx?$/, '') + e), ...['/index.js', '/index.jsx'].map((e) => base + e)]) if (set.has(c)) return c;
        return null;
    };
    for (const f of files) {
        const src = fs.readFileSync(path.join(HUB, f), 'utf8');
        for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
            const t = resolve(f, m[1]);
            if (t) parent.set(find(f), find(t));
        }
    }
    const groups = new Map();
    for (const f of files) { const r = find(f); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); }
    return [...groups.values()];
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const batch = arg('--batch'); const list = arg('--files');
    if (!batch && !list) { console.error('usage: --batch <list file> | --files a,b [--observed obs.json] [--workers n] [--heap-mb total] [--out dir] [--dry]'); process.exit(2); }
    const outDir = arg('--out');
    const dry = process.argv.includes('--dry') || !!outDir;
    const all = (batch ? fs.readFileSync(batch, 'utf8').split('\n') : list.split(','))
        .map((l) => l.trim()).filter(Boolean).filter((f) => fs.existsSync(path.join(HUB, f)));
    // A target whose name differs only in case from a file next to it
    // (ToolChooser.tsx beside toolChooser.ts) breaks module resolution on a
    // case-insensitive disk: it needs a deliberate rename, not this tool.
    const collides = (f) => {
        const t = path.basename(targetName(f, fs.readFileSync(path.join(HUB, f), 'utf8'))).toLowerCase();
        return fs.readdirSync(path.join(HUB, path.dirname(f))).some((o) => o !== path.basename(f) && o.toLowerCase() === t);
    };
    const skippedCase = all.filter(collides);
    for (const f of skippedCase) console.error(`skip  ${f}: its .ts/.tsx name differs only in case from a file beside it`);
    const files = all.filter((f) => !skippedCase.includes(f));
    const workers = Number(arg('--workers', 1));
    if (workers > 1 && files.length > 1) {
        // Split along the import graph: files that import each other (directly
        // or through other files of the run) stay in one worker, because types
        // flow between them. Components are dealt out largest first.
        const chunks = Array.from({ length: workers }, () => []);
        const groups = importGroups(files);
        for (const group of groups.sort((a, b) => b.length - a.length)) chunks.sort((a, b) => a.length - b.length)[0].push(...group);
        const passOn = process.argv.slice(2).filter((a, i, all) => !['--batch', '--files', '--workers', '--heap-mb'].includes(a) && !['--batch', '--files', '--workers', '--heap-mb'].includes(all[i - 1]));
        const { spawn } = await import('node:child_process');
        const t0 = Date.now();
        const outs = await Promise.all(chunks.filter((c) => c.length).map((c) => new Promise((resolve, reject) => {
            // Heap by share of the files: one import component can hold most of them.
            const heap = Math.max(3072, Math.round((Number(arg('--heap-mb', 12288)) * c.length) / files.length));
            const child = spawn(process.execPath, [`--max-old-space-size=${heap}`, fileURLToPath(import.meta.url), '--files', c.join(','), ...passOn], { stdio: ['ignore', 'pipe', 'inherit'] });
            let out = ''; child.stdout.on('data', (d) => { out += d; });
            child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited ${code}`))));
        })));
        console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), workers, files: outs.flatMap((o) => o.files) }, null, 1));
        process.exit(0);
    }
    const ts = loadTs();
    // Runtime observations (scripts/ts-runtime-types.mjs collect): a source for what static analysis cannot see.
    const observed = arg('--observed') ? JSON.parse(fs.readFileSync(arg('--observed'), 'utf8')) : {};
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
    // Then the check: a slot typed from a demand or an observation whose own
    // references now carry type errors had the wrong source. Those sources are
    // banned for that slot and the whole batch is redone from the original text.
    // A large run goes in chunks, importers first: each chunk is inferred
    // against the already typed text of the chunks before it, and the checker
    // only ever has to answer for one chunk's files (all of them at once ran
    // out of memory at ~440 files).
    const chunkSize = Number(arg('--chunk', 120));
    const ordered = orderByImports(plan.map((p) => p.file)).map((f) => plan.find((p) => p.file === f));
    const allReports = new Map(); let fixedAll = new Map();
    const runChunk = (chunk) => {
        const originals = new Map(chunk.map((p) => [p.abs, overrides.get(p.abs)]));
        const bans = new Map(chunk.map((p) => [p.abs, new Set()]));
        let reports; let fixed;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt) for (const [abs, text] of originals) svc.update(abs, text);
            reports = new Map(chunk.map((p) => [p.abs, []]));
            const chosen = new Map(chunk.map((p) => [p.abs, new Map()]));
            for (let pass = 0; pass < 5; pass++) {
                // One program per pass: infer every file against it, then apply all edits
                // at once (each update would otherwise rebuild the checker).
                let n = 0; const next = [];
                resetCaches();
                for (const p of chunk) {
                    const inf = inferFile(ts, svc.service, p.abs, observed[p.file] || null, bans.get(p.abs));
                    reports.get(p.abs).push(...inf.report.map((l) => `[${attempt + 1}.${pass + 1}] ${l}`));
                    for (const c of inf.chosen || []) chosen.get(p.abs).set(c.slot, c.source);
                    if (!inf.edits.length) continue;
                    next.push([p.abs, applyEdits(svc.service.getProgram().getSourceFile(p.abs).text, inf.edits)]);
                    n += inf.edits.length;
                }
                for (const [abs, text] of next) svc.update(abs, text);
                console.error(`attempt ${attempt + 1} pass ${pass + 1}: ${n} edits${process.env.TS_CONVERT_PROFILE ? `, heap ${(globalThis.gc?.(), Math.round(process.memoryUsage().heapUsed / 1e6))} MB` : ''}`);
                if (!n) break;
            }
            fixed = fixAll(ts, svc, chunk);
            let banned = 0;
            const program = svc.service.getProgram();
            for (const p of chunk) {
                for (const d of svc.service.getSemanticDiagnostics(p.abs)) {
                    if (!MISFIT.has(d.code)) continue;
                    const slot = slotOfDiagnostic(ts, program, p.abs, d);
                    const source = slot && chosen.get(p.abs).get(slot);
                    if (!source || source === 'call') continue; // typed callers are the truth; the error is the code's
                    const key = `${slot}|${source}`;
                    if (!bans.get(p.abs).has(key)) { bans.get(p.abs).add(key); banned++; }
                }
            }
            console.error(`attempt ${attempt + 1}: ${banned} slot source(s) rejected`);
            if (!banned) break;
        }
        return { reports, fixed };
    };
    for (let i = 0; i < ordered.length; i += chunkSize) {
        const chunk = ordered.slice(i, i + chunkSize);
        if (ordered.length > chunkSize) console.error(`chunk ${i / chunkSize + 1}/${Math.ceil(ordered.length / chunkSize)}: ${chunk.length} files`);
        const { reports: r, fixed: f } = runChunk(chunk);
        for (const [k, v] of r) allReports.set(k, v);
        for (const [k, v] of f) fixedAll.set(k, v);
    }
    // Later chunks change what earlier ones see: count what remains at the end.
    if (ordered.length > chunkSize) {
        const final = new Map();
        for (const p of plan) {
            const remaining = svc.service.getSemanticDiagnostics(p.abs).concat(svc.service.getSyntacticDiagnostics(p.abs));
            final.set(p.abs, { ...fixedAll.get(p.abs), remaining: remaining.map((d) => ({ code: d.code, line: d.file ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') })) });
        }
        fixedAll = final;
    }
    const reports = allReports; const fixed = fixedAll;
    for (const p of plan) {
        const r = { ...fixed.get(p.abs), callsites: reports.get(p.abs) };
        const text = mergeTypeImports(overrides.get(p.abs));
        if (outDir) { const o = path.join(outDir, p.target); fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, text); }
        if (!dry) {
            execFileSync('git', ['-C', HUB, 'mv', p.file, p.target]);
            fs.writeFileSync(p.abs, text);
        }
        result.push({ file: p.file, target: p.target, applied: r.applied.length, callsites: r.callsites, refused: r.refused, remaining: r.remaining });
        console.error(`${r.remaining.length ? 'open ' : 'clean'} ${p.target} (+${r.applied.length} fixes, ${r.refused} refused, ${r.remaining.length} left)`);
    }
    console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), files: result }, null, 1));
}
