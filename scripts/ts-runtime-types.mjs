#!/usr/bin/env node
// Runtime type observation for scripts/ts-convert-codefix.mjs.
//
// Where no typed caller or consumer exists, the tests still run the code: this
// records what values the parameters, props and useState slots of the files
// to convert actually hold while agent-hub's own vitest suites run, and turns
// those observations into types. Nothing here changes a source file: a vitest
// plugin instruments the JavaScript in memory for the test run only.
//
//   node scripts/ts-runtime-types.mjs collect --batch <list> --out obs.json [--tests a,b]          (agent-hub, vitest)
//   node scripts/ts-runtime-types.mjs collect-server --batch <list> --out obs.json [--tests a,b] (server, node --test)
//
// What the converter does with obs.json: a slot static analysis could not type
// gets the observed type when it is writable (no functions, no `any`, a
// bounded size); an observed object shape that fits an exported interface of
// agent-hub becomes that interface's name. The typecheck still decides: a
// shape the tests only partly filled shows up as a missing property there.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { functionKeys } from './ts-callsite-types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

// ---------------------------------------------------------------- instrument

const isState = (ts, call) => ts.isCallExpression(call) && /(^|\.)useState$/.test(call.expression.getText());

/**
 * The source with a `__tcRec(file, key, { slot: value })` call at the start of
 * every named function and after every `const [x, setX] = useState(...)`.
 * Slots: `#i` a plain parameter, `.name` a destructured prop, `=` the state.
 */
export function instrument(ts, source, file) {
    // agent-hub's .js may hold JSX; the server's never does (and `a < b` must stay a comparison).
    const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : /^server\//.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.JSX;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const keys = functionKeys(ts, sf);
    const inserts = [];
    const rec = (key, slots) => `__tcRec(${JSON.stringify(file)}, ${JSON.stringify(key)}, { ${slots.join(', ')} });`;
    for (const [fn, key] of keys) {
        const slots = [];
        fn.parameters.forEach((p, i) => {
            if (ts.isIdentifier(p.name)) slots.push(`${JSON.stringify(`#${i}`)}: ${p.name.text}`);
            else if (ts.isObjectBindingPattern(p.name)) for (const el of p.name.elements) {
                if (!el.dotDotDotToken && ts.isIdentifier(el.name)) slots.push(`${JSON.stringify(`.${(el.propertyName || el.name).getText(sf)}`)}: ${el.name.text}`);
            }
        });
        if (!slots.length || !fn.body) continue;
        if (ts.isBlock(fn.body)) inserts.push({ at: fn.body.getStart(sf) + 1, text: rec(key, slots) });
        else {
            inserts.push({ at: fn.body.getStart(sf), text: `{ ${rec(key, slots)} return (` });
            inserts.push({ at: fn.body.getEnd(), text: '); }' });
        }
    }
    const visit = (n) => {
        if (ts.isVariableStatement(n) && ts.isBlock(n.parent)) {
            for (const d of n.declarationList.declarations) {
                if (d.initializer && isState(ts, d.initializer) && ts.isArrayBindingPattern(d.name) && d.name.elements.length >= 2) {
                    const [v, set] = d.name.elements;
                    if (ts.isBindingElement(v) && ts.isIdentifier(v.name) && ts.isBindingElement(set) && ts.isIdentifier(set.name)) {
                        inserts.push({ at: n.getEnd(), text: ` ${rec(`state:${set.name.text}`, [`"=": ${v.name.text}`])}` });
                    }
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    let out = source;
    for (const i of inserts.map((x, k) => ({ ...x, k })).sort((a, b) => b.at - a.at || b.k - a.k)) out = out.slice(0, i.at) + i.text + out.slice(i.at);
    return out;
}

// ---------------------------------------------------------------- synthesise

const IDENT = /^[A-Za-z_$][\w$]*$/;
// Globals whose name is a type in lib.dom / lib.es and needs no type argument.
const CLASS_OK = /^(?!Synthetic)(Date|RegExp|Error|TypeError|File|Blob|FormData|URL|URLSearchParams|AbortController|AbortSignal|Headers|Response|Request|DOMRect|HTML\w*Element|SVG\w*Element|Element|Node|Text|Document|Window|\w*Event|ArrayBuffer|Uint8Array|DataTransfer|FileList)$/;

/**
 * A TypeScript type for the observed descriptors, or null when one may not be
 * written (a function, an unknown class, too large). `named(objDescs)` may name
 * an object shape. `opts.optional` is set when `undefined` was seen.
 */
export function typeFromSamples(descs, named = (/** @type {any} */ _objs) => null, depth = 0, opts = {}) {
    if (!descs.length || depth > 3) return null;
    const parts = new Set(); const objs = []; const arrs = [];
    for (const d of descs) {
        switch (d.k) {
        case 'undefined': opts.optional = true; break;
        case 'null': case 'string': case 'number': case 'boolean': case 'bigint': parts.add(d.k); break;
        case 'node': parts.add('React.ReactNode'); break;
        case 'class': if (!CLASS_OK.test(d.name)) return null; parts.add(d.name); break;
        case 'obj': objs.push(d); break;
        case 'arr': arrs.push(d); break;
        default: return null; // fn, symbol, anything unknown
        }
    }
    if (objs.length) {
        const n = named(objs);
        if (n) parts.add(n);
        else {
            const keys = new Map();
            for (const o of objs) for (const [k, v] of Object.entries(o.p)) { if (!keys.has(k)) keys.set(k, []); keys.get(k).push(v); }
            const fields = [];
            for (const [k, vs] of keys) {
                const o2 = {};
                const t = typeFromSamples(vs, named, depth + 1, o2);
                if (!t) return null;
                const opt = o2.optional || vs.length < objs.length;
                fields.push(`${IDENT.test(k) ? k : JSON.stringify(k)}${opt ? '?' : ''}: ${t}`);
            }
            if (!fields.length) return null; // {} says nothing
            parts.add(`{ ${fields.join('; ')} }`);
        }
    }
    if (arrs.length) {
        const els = arrs.flatMap((a) => a.e);
        if (els.length) {
            const t = typeFromSamples(els, named, depth + 1, {});
            if (!t) return null;
            parts.add(/[|&\s]/.test(t) && !/^\{.*\}$/.test(t) ? `(${t})[]` : `${t}[]`);
        } else if (!parts.size && !objs.length) return null; // only [] seen
    }
    if (!parts.size || [...parts].every((x) => x === 'null')) return null; // only null seen says nothing
    // boolean stays boolean, null last for reading.
    const order = [...parts].sort((a, b) => Number(a === 'null') - Number(b === 'null'));
    const text = order.join(' | ');
    return text.length > 160 ? null : text;
}

// ---------------------------------------------------------------- collect

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

/** Tests that import one of `files` (by basename): the ones worth running. */
export function testsFor(files) {
    const bases = new Set(files.map((f) => path.basename(f).replace(/\.[jt]sx?$/, '')));
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.test\.[jt]sx?$/.test(e.name)) {
                const src = fs.readFileSync(p, 'utf8');
                for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]|vi\.mock\(\s*['"]([^'"]+)['"]/g)) {
                    const spec = m[1] || m[2] || m[3];
                    if (bases.has(path.basename(spec).replace(/\.[jt]sx?$/, ''))) { out.push(path.relative(HUB, p)); break; }
                }
            }
        }
    };
    walk(path.join(HUB, 'src'));
    return out;
}

/**
 * The server is CommonJS and its tests run with `node --test`, one process per
 * file: a `--require` hook instruments the listed files as Node compiles
 * them (Module.prototype._compile), and writes what it recorded when the
 * process exits. Keys are paths relative to the repo root.
 */
export function serverHookSource(targetsFile, recDir) {
    return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = Module.createRequire(${JSON.stringify(path.join(HUB, 'package.json'))})('typescript');
const { instrument } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'ts-runtime-types.mjs'))});
const { describe } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'ts-runtime-recorder.mjs'))});
const targets = new Set(JSON.parse(fs.readFileSync(${JSON.stringify(targetsFile)}, 'utf8')));
const records = {};
globalThis.__tcRec = (file, key, slots) => {
    try {
        const bySlot = ((records[file] ??= {})[key] ??= {});
        for (const [slot, value] of Object.entries(slots)) {
            const list = (bySlot[slot] ??= []);
            if (list.length >= 20) continue;
            const d = describe(value); const j = JSON.stringify(d);
            if (!list.some((x) => JSON.stringify(x) === j)) list.push(d);
        }
    } catch { /* observing must never break a test */ }
};
const compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
    if (targets.has(filename)) content = instrument(ts, content, path.relative(${JSON.stringify(ROOT)}, filename));
    return compile.call(this, content, filename);
};
process.on('exit', () => {
    if (Object.keys(records).length) fs.writeFileSync(path.join(${JSON.stringify(recDir)}, process.pid + '-' + Math.random().toString(36).slice(2) + '.json'), JSON.stringify(records));
});
`;
}

/** Server test files that require one of `files` (by basename). */
export function serverTestsFor(files) {
    const bases = new Set(files.map((f) => path.basename(f).replace(/\.[cm]?js$/, '')));
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === 'node_modules') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.test\.[cm]?js$/.test(e.name)) {
                const src = fs.readFileSync(p, 'utf8');
                for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g)) {
                    if (bases.has(path.basename(m[1] || m[2]).replace(/\.[cm]?js$/, ''))) { out.push(p); break; }
                }
            }
        }
    };
    walk(path.join(ROOT, 'server'));
    return out;
}

function mergeRecords(recDir) {
    const merged = {};
    for (const f of fs.readdirSync(recDir)) {
        const part = JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8'));
        for (const [file, byKey] of Object.entries(part)) for (const [key, bySlot] of Object.entries(byKey)) for (const [slot, list] of Object.entries(bySlot)) {
            const m = (((merged[file] ??= {})[key] ??= {})[slot] ??= []);
            for (const d of list) { const j = JSON.stringify(d); if (!m.some((x) => JSON.stringify(x) === j) && m.length < 30) m.push(d); }
        }
    }
    return merged;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'collect-server') {
    const batch = arg('--batch'); const outFile = path.resolve(arg('--out', 'obs-server.json'));
    const files = fs.readFileSync(batch, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((f) => path.resolve(ROOT, f)).filter((f) => fs.existsSync(f));
    const tests = arg('--tests') ? arg('--tests').split(',').map((t) => path.resolve(ROOT, t)) : serverTestsFor(files);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-runtime-server-'));
    const recDir = path.join(work, 'rec'); fs.mkdirSync(recDir);
    const targetsFile = path.join(work, 'targets.json'); fs.writeFileSync(targetsFile, JSON.stringify(files));
    const hook = path.join(work, 'hook.cjs'); fs.writeFileSync(hook, serverHookSource(targetsFile, recDir));
    console.error(`collect-server: ${files.length} files, ${tests.length} test files`);
    const t0 = Date.now(); let failed = 0;
    // One process per test file, like server/scripts/run-tests.mjs; a failing test still records.
    for (const t of tests) {
        const r = spawnSync(process.execPath, ['--require', hook, '--test', t], { cwd: path.join(ROOT, 'server'), stdio: 'ignore', timeout: 300000, env: { ...process.env, NODE_ENV: 'test' } });
        if (r.status !== 0) failed++;
    }
    const merged = mergeRecords(recDir);
    fs.writeFileSync(outFile, JSON.stringify(merged));
    console.error(`collect-server: ${tests.length - failed}/${tests.length} test files passed, ${Object.keys(merged).length} files observed in ${Math.round((Date.now() - t0) / 1000)} s -> ${outFile}`);
    fs.rmSync(work, { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'collect') {
    const batch = arg('--batch'); const outFile = path.resolve(arg('--out', 'obs.json'));
    const files = fs.readFileSync(batch, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).filter((f) => fs.existsSync(path.join(HUB, f)));
    const tests = arg('--tests') ? arg('--tests').split(',') : testsFor(files);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-runtime-'));
    const recDir = path.join(work, 'rec'); fs.mkdirSync(recDir);
    const listFile = path.join(work, 'files.json');
    fs.writeFileSync(listFile, JSON.stringify(files.map((f) => path.join(HUB, f))));
    // The config lives under agent-hub/node_modules so its imports resolve there.
    const cfgDir = path.join(HUB, 'node_modules', '.ts-runtime-types'); fs.mkdirSync(cfgDir, { recursive: true });
    const cfg = path.join(cfgDir, 'vitest.config.mjs');
    fs.writeFileSync(cfg, `
import base from ${JSON.stringify(path.join(HUB, 'vite.config.js'))};
import { instrument } from ${JSON.stringify(path.join(ROOT, 'scripts', 'ts-runtime-types.mjs'))};
import { createRequire } from 'node:module';
import fs from 'node:fs';
const ts = createRequire(${JSON.stringify(path.join(HUB, 'package.json'))})('typescript');
const targets = new Set(JSON.parse(fs.readFileSync(${JSON.stringify(listFile)}, 'utf8')));
export default async (env) => {
    const c = await (typeof base === 'function' ? base(env) : base);
    c.root = ${JSON.stringify(HUB)};
    c.plugins = [{ name: 'ts-runtime-types', enforce: 'pre', transform(code, id) {
        const file = id.split('?')[0];
        if (!targets.has(file)) return null;
        const rel = file.startsWith(${JSON.stringify(HUB + '/')}) ? file.slice(${JSON.stringify(HUB + '/')}.length) : file;
        return { code: instrument(ts, code, rel), map: null };
    } }, ...(c.plugins || [])];
    c.test = { ...c.test, setupFiles: [${JSON.stringify(path.join(ROOT, 'scripts', 'ts-runtime-recorder.mjs'))}, ...(c.test.setupFiles || [])], coverage: { enabled: false } };
    return c;
};
`);
    console.error(`collect: ${files.length} files, ${tests.length} test files`);
    const t0 = Date.now();
    const r = spawnSync(path.join(HUB, 'node_modules', '.bin', 'vitest'), ['run', '--config', cfg, '--reporter=dot', '--passWithNoTests', ...tests], {
        cwd: HUB, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TS_RUNTIME_REC_DIR: recDir }, maxBuffer: 1 << 28,
    });
    // Merge every worker's records: file -> key -> slot -> unique descriptors.
    const merged = {};
    for (const f of fs.readdirSync(recDir)) {
        const part = JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8'));
        for (const [file, byKey] of Object.entries(part)) for (const [key, bySlot] of Object.entries(byKey)) for (const [slot, list] of Object.entries(bySlot)) {
            const m = (((merged[file] ??= {})[key] ??= {})[slot] ??= []);
            for (const d of list) { const j = JSON.stringify(d); if (!m.some((x) => JSON.stringify(x) === j) && m.length < 30) m.push(d); }
        }
    }
    fs.writeFileSync(outFile, JSON.stringify(merged));
    const slots = Object.values(merged).flatMap((k) => Object.values(k).flatMap((s) => Object.keys(s))).length;
    console.error(`collect: vitest exit ${r.status}, ${Object.keys(merged).length} files and ${slots} slots observed in ${Math.round((Date.now() - t0) / 1000)} s -> ${outFile}`);
    fs.rmSync(work, { recursive: true, force: true });
}
