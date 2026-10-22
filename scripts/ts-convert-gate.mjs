#!/usr/bin/env node
// The gate after scripts/ts-convert-codefix.mjs has converted files in the
// working tree: only what is green in every respect stays TypeScript.
//
//   node scripts/ts-convert-gate.mjs --result run.json [--report open.json]
//
// run.json is the converter's output ({ files: [{ file, target }] }). Loop:
//   1. agent-hub's typecheck (tsc 7, the project tsconfig). A converted file
//      with an error of its own goes back to JavaScript; an error in another
//      file sends back the converted files that file imports.
//   2. scripts/ts-equivalence.mjs's compile: the new file must compile to the
//      same JavaScript as the old one, or it goes back.
// Going back means `git mv` to the old name and the old content from HEAD,
// byte for byte. Repeat until a round sends nothing back. --report writes, per
// file sent back, the errors it had: the to-do list for whatever comes next.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from './ts-equivalence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** `src/a.tsx(3,5): error TS2339: ...` lines -> [{ file, line, code, message }]. */
export function parseTsc(out) {
    const errs = [];
    for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) errs.push({ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), code: m[4], message: m[5] });
    return errs;
}

function typecheck() {
    const r = spawnSync(process.execPath, [path.join(HUB, 'node_modules', 'typescript-7', 'bin', 'tsc'), '--noEmit', '--pretty', 'false'], { cwd: HUB, encoding: 'utf8', maxBuffer: 1 << 28 });
    return parseTsc(`${r.stdout}\n${r.stderr}`);
}

/** Relative imports of a source file, resolved against `candidates` (paths relative to agent-hub). */
function importsOf(file, candidates) {
    let src; try { src = fs.readFileSync(path.join(HUB, file), 'utf8'); } catch { return []; }
    const out = [];
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const base = path.join(path.dirname(file), m[1]).replace(/\.[jt]sx?$/, '');
        for (const c of candidates) if (c.replace(/\.[jt]sx?$/, '') === base || c.replace(/\/index\.[jt]sx?$/, '') === base) out.push(c);
    }
    return out;
}

function sendBack(entry) {
    git('mv', '-f', `agent-hub/${entry.target}`, `agent-hub/${entry.file}`);
    git('checkout', 'HEAD', '--', `agent-hub/${entry.file}`);
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const result = JSON.parse(fs.readFileSync(arg('--result'), 'utf8'));
    let kept = result.files.filter((f) => fs.existsSync(path.join(HUB, f.target)));
    const back = new Map(); // target -> { file, target, reason, errors }
    for (let round = 1; ; round++) {
        const errs = typecheck();
        const byTarget = new Map(kept.map((k) => [k.target, k]));
        const bad = new Map();
        for (const e of errs) {
            if (byTarget.has(e.file)) { const b = bad.get(e.file) || { reason: 'typecheck', errors: [] }; b.errors.push(e); bad.set(e.file, b); continue; }
            // An error elsewhere: the converted files it imports caused it.
            const blame = importsOf(e.file, [...byTarget.keys()]);
            for (const t of blame) { const b = bad.get(t) || { reason: 'breaks an importer', errors: [] }; b.errors.push(e); bad.set(t, b); }
            if (!blame.length) console.error(`gate: unattributed error ${e.file}(${e.line}) ${e.code}`);
        }
        if (!bad.size) {
            // Typecheck green: now the compiled program must be unchanged.
            for (const k of kept) {
                const a = await compile(git('show', `HEAD:agent-hub/${k.file}`));
                const b = await compile(fs.readFileSync(path.join(HUB, k.target), 'utf8'));
                if (a.length !== b.length || a.some((l, i) => l !== b[i])) bad.set(k.target, { reason: 'compiled JavaScript differs', errors: [] });
            }
            if (!bad.size) { console.error(`gate: round ${round}: green, ${kept.length} files stay TypeScript`); break; }
        }
        for (const [t, b] of bad) { const k = byTarget.get(t); sendBack(k); back.set(t, { ...k, ...b }); }
        kept = kept.filter((k) => !bad.has(k.target));
        console.error(`gate: round ${round}: ${bad.size} sent back, ${kept.length} left`);
        if (!kept.length) break;
    }
    if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify([...back.values()], null, 1));
    console.log(JSON.stringify({ kept: kept.map((k) => k.target), sentBack: back.size }, null, 1));
}
