#!/usr/bin/env node
// JSDoc types for the server, by tooling. The server stays JavaScript and
// CommonJS (no rename, no build step, see server/jsconfig.json): this writes
// JSDoc comments, and marks a file `// @typecheck` once it passes the
// server's own typecheck, so scripts/checkjs-ratchet.mjs can be raised.
//
// It is the agent-hub converter's inference (scripts/ts-callsite-types.mjs:
// typed call sites, what a value is handed to, how a callback is called,
// values observed while the tests run, lookup tables, caught errors, grown
// objects) with every annotation lowered to JSDoc (scripts/jsdoc-lower.mjs),
// plus TypeScript's own "infer from usage" quick fix, which in a JavaScript
// file already writes JSDoc. Nothing but comments and the parentheses of a
// JSDoc cast is added, so the compiled program stays the same; --check
// proves it per file.
//
//   node scripts/jsdoc-convert-server.mjs --files server/a.js,server/b.js [--observed obs.json] --out <dir>
//   node scripts/jsdoc-convert-server.mjs --batch list.txt --write [--mark]
//   node scripts/jsdoc-convert-server.mjs --batch list.txt --check      (HEAD vs working tree, compiled)
//
// --mark adds `// @typecheck` to every file that has no error under the
// server's jsconfig after the run. Paths are relative to the repo root.
// The JSON on stdout carries, per file, the errors left under noImplicitAny
// (code, line, message) and `byCodeBefore` / `byCode` totals over the run:
// the measure of what the tooling did. `--no-strict-null` infers without
// strictNullChecks (the default keeps a caller's null in the types).
// See .claude/handoff/ts-conversion/SERVER.md for the workflow.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lowerToJsDoc } from './jsdoc-lower.mjs';
import { applyEdits, inferFile, MISFIT, resetCaches, setSiteFilter, slotOfDiagnostic } from './ts-callsite-types.mjs';
import { createService, forbiddenInsert, fixRound } from './ts-convert-codefix.mjs';
import { compile } from './ts-equivalence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const MARK = '// @typecheck';

/** JSDoc a type may not say: the same bans as the TypeScript side. */
export function forbiddenJsDoc(text) {
    return /\{[^}]*\b(any|Function)\b[^}]*\}|\{\*\}|\{\?\}|@ts-(ignore|expect-error|nocheck)/.test(text);
}

/**
 * What TypeScript's own inferFromUsage may write in a JavaScript file that is
 * no help: a JSDoc cast on an arrow parameter (`/** @type {string} *\/ (t)`
 * types the expression, not the parameter, so the diagnostic stays and the
 * cast nests on every round), a type that says nothing (`{null}`, `{{}}`,
 * `{Object}`), or a shape guessed from one use (`{ definition: undefined; }`,
 * `rows?: never[]`), which turns the next assignment into an error (TS2322).
 */
export function uselessQuickFix(text) {
    return /\*\/\s*\(/.test(text)
        || /\{\s*(null|undefined|\{\}|Object|object|never|unknown)\s*\}/.test(text)
        || /\{\s*(null|undefined)\s*\|/.test(text)
        || /\bnever\b/.test(text)
        || /:\s*(null|undefined)(\s*\|\s*(null|undefined))?\s*[;,}]/.test(text);
}

/**
 * Inference edits with a forbidden type dropped as a group: a `@typedef` whose
 * member names `Function` goes, and with it the `@param {Name}` that would
 * point at a typedef that does not exist (TS2552), and the other way round.
 */
export function safeInferenceEdits(edits) {
    const typeText = (e) => (e.kind === 'interface' ? e.members.map((m) => `{${m.type}}`).join(' ') : e.type ? `{${e.type}}` : '');
    const bad = new Set(edits.filter((e) => forbiddenJsDoc(typeText(e))));
    const badNames = new Set([...bad].filter((e) => e.kind === 'interface').map((e) => e.name));
    for (const e of edits) if (e.kind === 'param' && badNames.has(e.type)) bad.add(e);
    const badParamTypes = new Set([...bad].filter((e) => e.kind === 'param').map((e) => e.type));
    for (const e of edits) if (e.kind === 'interface' && badParamTypes.has(e.name)) bad.add(e);
    return { edits: edits.filter((e) => !bad.has(e)), dropped: [...bad].map((e) => `${e.kind} ${e.name || e.type || ''} (forbidden type)`) };
}

/**
 * A typedef for a destructured options object that leaves a bound name out is
 * dropped, with the `@param` that would point at it. On the TypeScript side an
 * incomplete interface is a to-do list (the destructure then names the missing
 * members as errors for an agent). In a JavaScript file that already passes the
 * server's typecheck it is a regression: TS2339 on every name the typedef lacks,
 * and typecheck-settle then reverts the whole file, the good edits with it. The
 * slot stays open instead, for the next source of types.
 */
export function completeOptionsEdits(edits) {
    const partial = new Set(edits.filter((e) => e.kind === 'interface' && e.open && e.open.length));
    const names = new Set([...partial].map((e) => e.name));
    for (const e of edits) if (e.kind === 'param' && names.has(e.type)) partial.add(e);
    return { edits: edits.filter((e) => !partial.has(e)), dropped: [...partial].map((e) => `${e.kind} ${e.name || e.type || ''} (typedef leaves ${e.kind === 'interface' ? e.open.join(', ') : 'members'} untyped)`) };
}
/**
 * TypeScript's inferFromUsage brings the types it names into scope through its import
 * adder, which in a CommonJS file is a real `const { T } = require('./m')`: a module load
 * that was not there, for a type. The compiled program changes, so such a fix is refused;
 * the inference writes its own type imports as `@typedef {import('./m').T} T`.
 */
export function addsRequire(before, after) {
    const count = (t) => (t.match(/\brequire\s*\(/g) || []).length;
    return count(after) > count(before);
}
/** Puts `// @typecheck` on the first line that may hold it (after a shebang). */
export function addMark(text) {
    if (/^\s*\/\/\s*@typecheck\b/m.test(text)) return text;
    if (text.startsWith('#!')) { const nl = text.indexOf('\n') + 1; return `${text.slice(0, nl)}${MARK}\n${text.slice(nl)}`; }
    return `${MARK}\n${text}`;
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const list = arg('--files') ? arg('--files').split(',') : fs.readFileSync(arg('--batch'), 'utf8').split('\n');
    const files = list.map((l) => l.trim()).filter(Boolean).map((f) => path.resolve(ROOT, f)).filter((f) => fs.existsSync(f) && f.startsWith(`${SERVER}/`) && !/\.test\.[cm]?js$/.test(f));

    if (process.argv.includes('--check')) {
        let bad = 0;
        for (const f of files) {
            const rel = path.relative(ROOT, f);
            let old; try { old = execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { continue; }
            const a = await compile(old); const b = await compile(fs.readFileSync(f, 'utf8'));
            if (a.length !== b.length || a.some((l, i) => l !== b[i])) { bad++; console.log(`DIFFERENT ${rel}`); }
        }
        console.log(`${files.length - bad} identical, ${bad} different`);
        process.exit(bad ? 1 : 0);
    }

    const ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
    const outDir = arg('--out'); const write = process.argv.includes('--write'); const mark = process.argv.includes('--mark');
    if (!outDir && !write) { console.error('pass --out <dir> to look first, or --write to change the files'); process.exit(2); }
    const observed = arg('--observed') ? JSON.parse(fs.readFileSync(arg('--observed'), 'utf8')) : {};
    // JavaScript callers are typed callers here (JSDoc and inference); tests are not.
    setSiteFilter((f) => !/\.(test|spec)\.[cm]?js$|\/node_modules\//.test(f));
    // The server's jsconfig, made strict for the run: `noImplicitAny` gives the
    // diagnostics that say where a type is missing; `strictNullChecks` keeps a
    // caller's `string|null` (and a literal null argument) in the types the
    // inference sees, so the JSDoc it writes says `string | null` and is right
    // the day the server turns that option on. The server's own options still
    // decide --mark, and the error counts are measured under its NEXT option
    // (noImplicitAny) alone, so a run's numbers compare with the last one's.
    const overrides = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const originals = new Map(overrides);
    const serverCfg = { configPath: path.join(SERVER, 'jsconfig.json'), baseDir: SERVER };
    const svc = createService(ts, overrides, { ...serverCfg, options: { checkJs: true, noImplicitAny: true, strictNullChecks: !process.argv.includes('--no-strict-null') } });
    const measure = createService(ts, new Map(originals), { ...serverCfg, options: { checkJs: true, noImplicitAny: true } });
    const bans = new Map(files.map((f) => [f, new Set()]));
    const t0 = Date.now(); const report = new Map(files.map((f) => [f, []]));
    const diag = (f) => measure.service.getSemanticDiagnostics(f).map((d) => ({ code: `TS${d.code}`, line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
    const countByCode = (errs, into = {}) => { for (const e of errs) into[e.code] = (into[e.code] || 0) + 1; return into; };
    // What the files looked like before any edit: the measure of what the run removes.
    const before = new Map(files.map((f) => [f, diag(f)]));
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) for (const [f, t] of originals) svc.update(f, t);
        const chosen = new Map(files.map((f) => [f, new Map()]));
        for (let pass = 0; pass < 5; pass++) {
            resetCaches(); let n = 0; const next = [];
            for (const f of files) {
                const rel = path.relative(SERVER, f);
                const inf = inferFile(ts, svc.service, f, observed[rel] || observed[path.relative(ROOT, f)] || null, bans.get(f));
                for (const c of inf.chosen || []) chosen.get(f).set(c.slot, c.source);
                const text = svc.service.getProgram().getSourceFile(f).text;
                const complete = completeOptionsEdits(inf.edits);
                const { edits: kept, dropped: forbidden } = safeInferenceEdits(complete.edits);
                forbidden.unshift(...complete.dropped);
                const { edits, dropped } = lowerToJsDoc(text, kept);
                const safe = edits.filter((e) => !forbiddenJsDoc(e.text));
                report.get(f).push(...inf.report.map((l) => `[${attempt + 1}.${pass + 1}] ${l}`), ...[...forbidden, ...dropped].map((d) => `dropped ${d}`));
                if (!safe.length) continue;
                next.push([f, applyEdits(text, safe)]); n += safe.length;
            }
            for (const [f, t] of next) svc.update(f, t);
            console.error(`attempt ${attempt + 1} pass ${pass + 1}: ${n} JSDoc edits`);
            if (!n) break;
        }
        // TypeScript's own quick fix: in a JavaScript file it writes JSDoc already.
        for (let round = 0; round < 4; round++) {
            let any = false;
            for (const f of files) {
                const prev = svc.service.getProgram().getSourceFile(f).text;
                const t = fixRound(ts, svc, f, { applied: [], refused: new Set() }, { fixIds: ['inferFromUsage'], refuse: uselessQuickFix });
                if (t && !forbiddenInsert(t) && !forbiddenJsDoc(t) && !addsRequire(prev, t)) { svc.update(f, t); any = true; }
                else if (t && addsRequire(prev, t)) report.get(f).push('dropped quick fix (adds a require for a type)');
            }
            if (!any) break;
        }
        let banned = 0; const program = svc.service.getProgram();
        for (const f of files) for (const d of svc.service.getSemanticDiagnostics(f)) {
            if (!MISFIT.has(d.code)) continue;
            const slot = slotOfDiagnostic(ts, program, f, d); const source = slot && chosen.get(f).get(slot);
            if (!source || source === 'call') continue;
            const key = `${slot}|${source}`; if (!bans.get(f).has(key)) { bans.get(f).add(key); banned++; }
        }
        console.error(`attempt ${attempt + 1}: ${banned} slot source(s) rejected`);
        if (!banned) break;
    }
    // --mark: clean under the server's own options (scripts/typecheck.mjs decides in CI).
    const plain = mark ? createService(ts, new Map(files.map((f) => [f, svc.service.getProgram().getSourceFile(f).text])), { configPath: path.join(SERVER, 'jsconfig.json'), baseDir: SERVER, options: { checkJs: true } }) : null;
    const result = []; const byCodeBefore = {}; const byCode = {};
    for (const f of files) measure.update(f, svc.service.getProgram().getSourceFile(f).text);
    for (const f of files) {
        let text = svc.service.getProgram().getSourceFile(f).text;
        const errors = diag(f);
        const clean = plain ? plain.service.getSemanticDiagnostics(f).length === 0 : null;
        if (mark && clean) text = addMark(text);
        const rel = path.relative(ROOT, f);
        if (outDir) { const o = path.join(outDir, rel); fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, text); }
        if (write && text !== originals.get(f)) fs.writeFileSync(f, text);
        countByCode(before.get(f), byCodeBefore); countByCode(errors, byCode);
        result.push({ file: rel, changed: text !== originals.get(f), errorsUnderNoImplicitAny: errors.length, errorsBefore: before.get(f).length, errorsByCode: countByCode(errors), errors, cleanUnderServerConfig: clean, marked: mark && clean && !/^\s*\/\/\s*@typecheck\b/m.test(originals.get(f)), report: report.get(f) });
    }
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    console.error(`errors under the run's options: ${sum(byCodeBefore)} before, ${sum(byCode)} after`);
    console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), byCodeBefore, byCode, files: result }, null, 1));
}
