#!/usr/bin/env node
/**
 * gen-shared-mirror — write the generated copies of server/shared code that
 * other packages need in their own tree, from a manifest.
 *
 *   node scripts/gen-shared-mirror.mjs           # (re)write every target
 *   node scripts/gen-shared-mirror.mjs --check   # exit 1 if any target differs; writes nothing
 *   ... --manifest <file>                        # another manifest (tests); paths stay relative to the repo root
 *
 * Manifest: scripts/shared-mirror.manifest.json, `{ entries: [...] }`, each
 *
 *   { source, target, transform?, importRewrite?, include?, exclude?, keep? }
 *
 *   source / target  paths relative to the repo root. A directory source
 *                    copies every file under it except tests (*.test.*,
 *                    *.spec.*) into the target directory; a file source is
 *                    written to the target file.
 *   transform        "none" (default): byte for byte, no header — the copy has
 *                    to stay byte-identical to its source (the agent-hub sync
 *                    test and the mobile lockstep test compare bytes).
 *                    "cjs-to-esm": rewrites the plain CommonJS forms
 *                    (`const x = require('m')`, `const { a, b: c } = require('m')`,
 *                    `module.exports = { a, b: c }`, a leading 'use strict')
 *                    into import/export, and refuses a file that still has a
 *                    `require(` or `exports` afterwards.
 *   importRewrite    [[from, to], ...]: a quoted module specifier 'from' (or
 *                    "from") becomes 'to'.
 *   include/exclude  narrow the file list (paths relative to source).
 *   keep             hand-written files in target (e.g. a .d.mts): never
 *                    written, never reported as extra, never removed.
 *
 * Whenever a transform or importRewrite changes the text, each written file
 * starts with `// GENERATED from <source file> by scripts/gen-shared-mirror.mjs
 * — do not edit`. --check compares against the generated text, so a stale or
 * hand-edited target fails and the entry is named.
 *
 * Today's entries: server/shared/expr (the expression engine; the automation
 * runtime loads it through server/automation/expr.js) to
 * agent-hub/src/shared/expr (App Studio, through the `@shared` alias; the
 * agent-hub image builds with context ./agent-hub and cannot see server/)
 * and to mobile/src/shared/expr/vendor (the phone's flow editor).
 *
 * Tests are outside the mirror on BOTH sides: a server test is never copied,
 * and a test in a target directory is never reported as extra or removed.
 * Write mode removes any other target file the source no longer has, so a
 * rename on the server leaves no stale copy.
 *
 * History: the copies used to be "kept byte-identical" by hand. Edits landed
 * on the server copy only, and the vitest sync test
 * (agent-hub/src/components/admin/Studio/AppStudio/state/sharedExpr.sync.test.js)
 * failed a quarter of an hour into CI. That test (and mobile's
 * exprVendor.lockstep.test.ts) stay as the CI backstop; --check is
 * `npm run lint:shared-mirror`, which `npm run check:fast` runs in seconds.
 * The targets are in the ignore list of .jscpd.json: generated, not
 * duplication anyone writes.
 *
 * Zero dependencies: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_MANIFEST = path.join(HERE, 'shared-mirror.manifest.json');
const SCRIPT_NAME = 'scripts/gen-shared-mirror.mjs';
const TRANSFORMS = new Set(['none', 'cjs-to-esm']);
const ENTRY_KEYS = new Set(['source', 'target', 'transform', 'importRewrite', 'include', 'exclude', 'keep', 'why']);

/** Test files stay where they are: never copied, never counted as extra. */
export function isTest(name) {
    return /\.(test|spec)\.[^.]+$/.test(name);
}

/** The non-test files under `dir`, as sorted '/'-separated relative paths. */
export function listMirrorFiles(dir, rel = '') {
    const here = path.join(dir, rel);
    if (!fs.existsSync(here)) return [];
    const out = [];
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listMirrorFiles(dir, child));
        else if (entry.isFile() && !isTest(entry.name)) out.push(child);
    }
    return out.sort();
}

/** 1-based line of the first byte where two buffers part ways. */
function firstDifferentLine(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    let line = 1;
    for (let j = 0; j < i; j++) if (a[j] === 0x0a) line++;
    return line;
}

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

/** Validate and normalise the manifest's entries; throws on anything it does not understand. */
export function normaliseManifest(manifest) {
    if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
        throw new Error('the manifest has no entries');
    }
    return manifest.entries.map((raw, i) => {
        const name = `entry #${i + 1}`;
        if (!raw || typeof raw !== 'object') throw new Error(`${name} is not an object`);
        for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) throw new Error(`${name}: unknown key "${key}"`);
        if (typeof raw.source !== 'string' || !raw.source) throw new Error(`${name}: source is required`);
        if (typeof raw.target !== 'string' || !raw.target) throw new Error(`${name}: target is required`);
        const transform = raw.transform ?? 'none';
        if (!TRANSFORMS.has(transform)) throw new Error(`${name}: unknown transform "${transform}"`);
        const importRewrite = raw.importRewrite ?? [];
        if (!Array.isArray(importRewrite) || !importRewrite.every((p) => strings(p) && p.length === 2)) {
            throw new Error(`${name}: importRewrite must be a list of [from, to] pairs`);
        }
        for (const key of ['include', 'exclude', 'keep']) {
            if (raw[key] !== undefined && !strings(raw[key])) throw new Error(`${name}: ${key} must be a list of paths`);
        }
        return {
            label: `${name} (${raw.source}/ -> ${raw.target}/)`,
            source: raw.source.replace(/\/+$/, ''),
            target: raw.target.replace(/\/+$/, ''),
            transform,
            importRewrite,
            include: raw.include ? new Set(raw.include) : null,
            exclude: new Set(raw.exclude ?? []),
            keep: new Set(raw.keep ?? []),
        };
    });
}

/** The file list of one entry: the source's non-test files, narrowed by include/exclude. */
export function entryFiles(entry, sourceDir) {
    return listMirrorFiles(sourceDir).filter((f) => (!entry.include || entry.include.has(f)) && !entry.exclude.has(f));
}

function specifierRe(spec) {
    return new RegExp(`(['"])${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
}

/** `{ a, b: c }` (destructuring) -> `{ a, b as c }` (import list). */
function importList(body) {
    return body.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/^(\w+)\s*:\s*(\w+)$/, '$1 as $2')).join(', ');
}

/** `{ a, b: c }` (object literal) -> `{ a, c as b }` (export list). */
function exportList(body) {
    return body.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => {
            const m = s.match(/^(\w+)\s*:\s*(\w+)$/);
            if (m) return m[1] === m[2] ? m[1] : `${m[2]} as ${m[1]}`;
            if (!/^\w+$/.test(s)) throw new Error(`cannot turn "${s}" in module.exports into an export`);
            return s;
        }).join(', ');
}

/** The plain CommonJS forms into ESM; throws when something CommonJS is left over. */
export function cjsToEsm(text, file = 'file') {
    let out = text
        .replace(/^(\s*)['"]use strict['"];?[ \t]*\r?\n/, '$1')
        .replace(/^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*(['"][^'"]+['"])\s*\);?/gm, '$1import $2 from $3;')
        .replace(/^(\s*)(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*(['"][^'"]+['"])\s*\);?/gm,
            (_, ind, body, spec) => `${ind}import { ${importList(body)} } from ${spec};`)
        .replace(/^(\s*)module\.exports\s*=\s*\{([^}]*)\};?/gm, (_, ind, body) => `${ind}export { ${exportList(body)} };`);
    const left = out.match(/\brequire\s*\(|\bmodule\.exports\b|^\s*exports\.\w+/m);
    if (left) throw new Error(`cjs-to-esm: ${file} still has "${left[0].trim()}" after the rewrite; use the plain forms`);
    return out;
}

/**
 * What the target file must contain, as a Buffer. `from` is the repo-relative
 * source path the header names (a single-file entry passes entry.source).
 */
export function generate(entry, file, sourceBytes, from = `${entry.source}/${file}`) {
    if (entry.transform === 'none' && entry.importRewrite.length === 0) return sourceBytes;
    let text = sourceBytes.toString('utf8');
    if (entry.transform === 'cjs-to-esm') text = cjsToEsm(text, from);
    for (const [from, to] of entry.importRewrite) {
        text = text.replace(specifierRe(from), (_, q) => `${q}${to}${q}`);
    }
    const header = `// GENERATED from ${from} by ${SCRIPT_NAME} — do not edit\n`;
    return Buffer.from(header + text, 'utf8');
}

/**
 * Where an entry reads and writes. A source that is a single file mirrors to
 * `target` as a file (`single`); a directory mirrors into `target` as a directory.
 */
function entryPaths(entry, root) {
    const source = path.join(root, entry.source);
    const single = fs.existsSync(source) && fs.statSync(source).isFile();
    return single
        ? { single, sourceDir: path.dirname(source), targetDir: path.dirname(path.join(root, entry.target)), only: path.basename(source), as: path.basename(entry.target) }
        : { single, sourceDir: source, targetDir: path.join(root, entry.target) };
}

/** Repo-relative display path of one target file. */
function shown(entry, p, file) {
    return p.single ? entry.target : `${entry.target}/${file}`;
}

/**
 * Compare one entry's target with what the generator would write. `differ`
 * holds { file, line } for each target whose bytes differ; `missing` the files
 * the target lacks; `extra` the target's non-test, non-kept files the entry
 * does not produce (directories only). `wanted` maps each file to its
 * generated bytes; `targetOf` maps it to its absolute target path.
 */
export function compareEntry(entry, root = ROOT) {
    const p = entryPaths(entry, root);
    const files = p.single ? [p.only] : entryFiles(entry, p.sourceDir);
    for (const k of entry.keep) if (files.includes(k)) throw new Error(`${entry.label}: "${k}" is both generated and kept`);
    const targetOf = (file) => path.join(p.targetDir, p.single ? p.as : file);
    const wanted = new Map();
    const differ = [];
    const missing = [];
    for (const file of files) {
        const want = generate(entry, file, fs.readFileSync(path.join(p.sourceDir, file)), p.single ? entry.source : undefined);
        wanted.set(file, want);
        const to = targetOf(file);
        if (!fs.existsSync(to)) {
            missing.push(file);
            continue;
        }
        const got = fs.readFileSync(to);
        if (!want.equals(got)) differ.push({ file, line: firstDifferentLine(want, got) });
    }
    const extra = p.single ? [] : listMirrorFiles(p.targetDir).filter((file) => !wanted.has(file) && !entry.keep.has(file));
    return { files, wanted, differ, missing, extra, targetOf, single: p.single, show: (file) => shown(entry, p, file) };
}

/** Compare two plain directories byte for byte (absolute paths). */
export function compareTrees(sourceDir, targetDir) {
    const entry = normaliseManifest({ entries: [{ source: path.resolve(sourceDir), target: path.resolve(targetDir) }] })[0];
    const { files, differ, missing, extra } = compareEntry(entry, '/');
    return { files, differ, missing, extra };
}

function readManifest(file) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`cannot read the manifest ${path.relative(ROOT, file) || file}: ${e.message}`);
    }
    return normaliseManifest(parsed);
}

function report(entry, result, check) {
    const { files, wanted, differ, missing, extra, targetOf, show, single } = result;
    const source = single ? entry.source : `${entry.source}/`;
    const target = single ? entry.target : `${entry.target}/`;
    const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
    const clean = differ.length === 0 && missing.length === 0 && extra.length === 0;

    if (check) {
        if (clean) {
            console.log(`gen-shared-mirror: ${target} matches ${source} (${count}).`);
            return 0;
        }
        console.error(`gen-shared-mirror: ${target} is out of date with ${source} — ${entry.label}:`);
        for (const { file, line } of differ) console.error(`  differs: ${show(file)} (first difference at line ${line})`);
        for (const file of missing) console.error(`  missing: ${show(file)}`);
        for (const file of extra) console.error(`  extra:   ${show(file)} (not in ${source})`);
        console.error(`It is a generated copy — do not edit it by hand. Change ${source},\n`
            + 'then run `npm run gen:shared` (node scripts/gen-shared-mirror.mjs) and commit both.');
        return 1;
    }

    if (clean) {
        console.log(`gen-shared-mirror: ${target} already up to date (${count}).`);
        return 0;
    }
    for (const file of [...missing, ...differ.map((d) => d.file)].sort()) {
        const to = targetOf(file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, wanted.get(file));
        console.log(`gen-shared-mirror: wrote ${show(file)}`);
    }
    for (const file of extra) {
        fs.rmSync(targetOf(file));
        console.log(`gen-shared-mirror: removed ${show(file)} (not in ${source})`);
    }
    console.log(`gen-shared-mirror: ${target} now matches ${source} (${count}).`);
    return 0;
}

function main(argv = process.argv.slice(2)) {
    const check = argv.includes('--check');
    const at = argv.indexOf('--manifest');
    const manifestFile = at >= 0 ? path.resolve(argv[at + 1] ?? '') : DEFAULT_MANIFEST;
    const entries = readManifest(manifestFile);
    // Compute every entry before writing any, so a bad entry (no source
    // files, a transform that refuses a file) fails the run with nothing written.
    const results = entries.map((entry) => {
        const result = compareEntry(entry);
        if (result.files.length === 0) throw new Error(`${entry.source}/ has no files to mirror — is this the repo root? (${entry.label})`);
        return result;
    });
    let code = 0;
    entries.forEach((entry, i) => { code = Math.max(code, report(entry, results[i], check)); });
    return code;
}

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    try {
        process.exitCode = main();
    } catch (e) {
        console.error(`gen-shared-mirror: ${e.message}`);
        process.exitCode = 1;
    }
}
