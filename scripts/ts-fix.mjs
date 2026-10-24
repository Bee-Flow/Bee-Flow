#!/usr/bin/env node
// Apply TypeScript quick fixes headlessly, by fix id, to a list of files.
//
//   node scripts/ts-fix.mjs --fix inferFromUsage,fixMissingImport --files src/a.ts,src/b.tsx [--allow-any] [--dry]
//   node scripts/ts-fix.mjs --fix annotateWithTypeFromJSDoc --list files.txt
//   options: --root <dir>  directory with the tsconfig.json (default agent-hub)
//
// Files are paths relative to --root, to the working directory, or absolute.
// Per fix id and file it first asks the language service for the combined fix
// (`getCombinedCodeFix`, the editor's "fix all in file"); when that fails, or
// would put an `any` into the file, it falls back to the single fixes at each
// diagnostic (`getCodeFixesAtPosition`) and keeps those that are acceptable.
// Without --allow-any a change that adds an `any` keyword is dropped, as is one
// that adds a ts-comment or touches another file.
//
// Fix id aliases: fixAddMissingMember = fixMissingMember + fixMissingProperties.
// Supported ids are whatever the TypeScript 6 language service knows; common
// ones: inferFromUsage, fixMissingImport, annotateWithTypeFromJSDoc,
// fixAddMissingMember, fixAwaitInSyncFunction, addMissingAwait, addMissingAsync.
//
// Prints JSON: per file the fixes applied (fixId, how, edits) and skipped (reason).
// The typecheck that decides stays `npm run typecheck` in agent-hub (tsc 7).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyChanges, createService } from './ts-convert-codefix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

export const FIX_ALIASES = {
    fixAddMissingMember: ['fixMissingMember', 'fixMissingProperties'],
};

const FORMAT = { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: 'insert' };
const PREFS = { quotePreference: 'single', importModuleSpecifierPreference: 'relative', includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true };

export function loadTs(hub = HUB) {
    return createRequire(path.join(hub, 'package.json'))('typescript');
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** True when inserted text contains an `any` keyword outside comments. */
export function insertsAny(newText) {
    return /\bany\b/.test(stripComments(newText));
}

/** Number of `any` keywords in a source text (parsed). */
export function countAny(ts, text, fileName = 'x.tsx') {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    let n = 0;
    const visit = (node) => { if (node.kind === ts.SyntaxKind.AnyKeyword) n++; ts.forEachChild(node, visit); };
    visit(sf);
    return n;
}

const insertsTsComment = (t) => /@ts-(ignore|expect-error|nocheck)/.test(t);

function expandIds(ids) {
    return ids.flatMap((id) => FIX_ALIASES[id] || [id]);
}

/** Diagnostics a quick fix can hang on: errors plus suggestions (JSDoc and inferFromUsage live there). */
function allDiagnostics(svc, abs) {
    return [...svc.service.getSyntacticDiagnostics(abs), ...svc.service.getSemanticDiagnostics(abs), ...svc.service.getSuggestionDiagnostics(abs)];
}

/**
 * Apply one fix id to one file. Returns `{ text, applied, skipped }` where text
 * is the new content (or null for no change). The service is updated by the caller.
 */
export function applyFixId(ts, svc, abs, fixId, { allowAny = false, maxRounds = 8 } = {}) {
    const ids = expandIds([fixId]);
    const skipped = [];
    const applied = [];
    const before = svc.service.getProgram().getSourceFile(abs)?.text ?? fs.readFileSync(abs, 'utf8');
    const anyBefore = countAny(ts, before, abs);
    const acceptable = (changes) => {
        if (!changes.length) return 'empty';
        if (changes.some((c) => path.resolve(c.fileName) !== abs)) return 'touches another file';
        const texts = changes.flatMap((c) => c.textChanges.map((t) => t.newText));
        if (texts.some(insertsTsComment)) return 'adds a ts-comment';
        if (!allowAny && texts.some(insertsAny)) return 'adds any';
        return null;
    };

    // 1. combined fix per id
    let current = before;
    for (const id of ids) {
        let combined = null;
        try { combined = svc.service.getCombinedCodeFix({ type: 'file', fileName: abs }, id, FORMAT, PREFS); } catch (e) { skipped.push({ fixId: id, reason: `combined fix unavailable: ${String(e.message).split('\n')[0]}` }); }
        if (!combined) continue;
        const why = acceptable(combined.changes);
        if (why === 'empty') continue;
        if (why) { skipped.push({ fixId: id, reason: `combined fix refused (${why}), trying one by one` }); continue; }
        const changes = combined.changes.flatMap((c) => c.textChanges);
        const out = applyChanges(current, changes);
        if (!allowAny && countAny(ts, out, abs) > anyBefore) { skipped.push({ fixId: id, reason: 'combined fix refused (adds any), trying one by one' }); continue; }
        if (out === current) continue;
        current = out; applied.push({ fixId: id, how: 'combined', edits: changes.length });
        svc.update(abs, current); // the next id sees this one's result
    }
    if (current !== before) return { text: current, applied, skipped: dedupe(skipped) };

    // 2. per-diagnostic fallback, rounds of non-overlapping fixes
    const refused = new Set();
    let text = before;
    for (let round = 0; round < maxRounds; round++) {
        const taken = [];
        const roundApplied = [];
        for (const d of allDiagnostics(svc, abs)) {
            if (d.start === undefined) continue;
            const key = `${d.code}:${d.start}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
            if (refused.has(key)) continue;
            let fixes;
            try { fixes = svc.service.getCodeFixesAtPosition(abs, d.start, d.start + (d.length || 0), [d.code], FORMAT, PREFS); } catch { refused.add(key); continue; }
            const fix = fixes.find((f) => ids.includes(f.fixId));
            if (!fix) { refused.add(key); continue; }
            const why = acceptable(fix.changes);
            if (why) { refused.add(key); if (why !== 'empty') skipped.push({ fixId: fix.fixId, reason: `TS${d.code} at ${lineOf(d)}: ${why}` }); continue; }
            const changes = fix.changes.flatMap((c) => c.textChanges);
            const overlaps = changes.some((c) => taken.some((t) => c.span.start <= t.span.start + t.span.length && t.span.start <= c.span.start + c.span.length));
            if (overlaps) continue; // next round
            taken.push(...changes);
            roundApplied.push({ fixId: fix.fixId, how: 'single', code: d.code, line: lineOf(d), edits: changes.length });
        }
        if (!taken.length) break;
        text = applyChanges(text, taken);
        applied.push(...roundApplied);
        svc.update(abs, text);
    }
    return { text: text === before ? null : text, applied, skipped: dedupe(skipped) };
}

function dedupe(list) {
    const seen = new Set();
    return list.filter((s) => { const k = `${s.fixId}|${s.reason}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function lineOf(d) {
    return d.file ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
}

/** Run all fix ids over all files. Returns `[{ file, changed, applied, skipped }]`; writes unless dry. */
export function fixFiles(ts, files, fixIds, { root = HUB, allowAny = false, dry = false } = {}) {
    const overrides = new Map();
    const svc = createService(ts, overrides, { configPath: path.join(root, 'tsconfig.json'), baseDir: root, includeTests: true });
    const results = [];
    for (const abs of files) {
        const original = fs.readFileSync(abs, 'utf8');
        const r = { file: path.relative(root, abs), changed: false, applied: [], skipped: [] };
        let text = original;
        for (const id of fixIds) {
            let out;
            try { out = applyFixId(ts, svc, abs, id, { allowAny }); } catch (e) { r.skipped.push({ fixId: id, reason: `error: ${String(e.message).split('\n')[0]}` }); continue; }
            r.applied.push(...out.applied); r.skipped.push(...out.skipped);
            if (out.text !== null && out.text !== text) { text = out.text; svc.update(abs, text); }
        }
        if (text !== original) {
            r.changed = true;
            if (!dry) fs.writeFileSync(abs, text);
            else r.preview = text;
        }
        results.push(r);
    }
    return results;
}

export function resolveFile(f, root) {
    for (const c of [path.resolve(f), path.resolve(root, f)]) if (fs.existsSync(c)) return c;
    return null;
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const fix = arg('--fix'); const list = arg('--list'); const filesArg = arg('--files');
    const root = path.resolve(arg('--root', HUB));
    if (!fix || (!list && !filesArg)) {
        console.error('usage: ts-fix.mjs --fix <fixId[,fixId]> (--files a,b | --list file.txt) [--root dir] [--allow-any] [--dry]');
        process.exit(2);
    }
    const names = (list ? fs.readFileSync(list, 'utf8').split('\n') : filesArg.split(',')).map((l) => l.trim()).filter(Boolean);
    const missing = []; const files = [];
    for (const n of names) { const abs = resolveFile(n, root); if (abs) files.push(abs); else missing.push(n); }
    const ts = loadTs(root);
    const results = fixFiles(ts, files, fix.split(',').map((s) => s.trim()), { root, allowAny: process.argv.includes('--allow-any'), dry: process.argv.includes('--dry') });
    for (const m of missing) results.push({ file: m, changed: false, applied: [], skipped: [{ fixId: '*', reason: 'file not found' }] });
    const slim = results.map(({ preview, ...r }) => r);
    console.log(JSON.stringify({ dry: process.argv.includes('--dry'), files: slim }, null, 1));
}
