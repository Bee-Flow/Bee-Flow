#!/usr/bin/env node
// server-mv: move CommonJS files inside server/ and fix every reference, leaving no shim.
//
//   node scripts/server-mv.mjs <from> <to> [<from> <to> ...] [--dry] [--no-tests] [--json]
//   node scripts/server-mv.mjs --check <old-ref> <from> <to> [...]   move-equivalence gate
//
// Paths are server-relative (`stores/x.js`) or repo-relative (`server/stores/x.js`).
// `<to>` may be an existing directory (the file keeps its name). Several pairs move in one
// call, so files that require each other keep working.
//
// What moves and what is rewritten:
// - The file, plus its colocated `x.test.js` / `x.<what>.test.js` / `x.testkit.js` (--no-tests
//   leaves them), with `git mv` when the tree is a git checkout.
// - EVERY quoted relative specifier (`'./x'`, `'../stores/x'`, quotes of any kind, also in
//   JSDoc `import('./x')`, `require.resolve(...)`, `require.cache[...]` stub keys and test mocks)
//   in the files under server/ (.js .cjs .mjs .ts .mts) that resolves to a moved file is
//   pointed at the new place. The extension style of the old specifier is kept.
// - Inside a moved file every relative specifier that resolves to an existing file or folder is
//   re-based, so its own requires keep landing on the same targets.
// - `path.join(ROOT, 'stores/x')`-style server-rooted literals (the `mockModule` idiom) that
//   name a moved file are rewritten.
// - The old server-relative path in server/*.json budgets and `server/<path>` in other text
//   files of the repo (workflows, mobile lockstep tests, docs) is replaced.
// - Nothing is left behind at the old path: no re-export shim.
//
// The move-equivalence gate (--check, also run by the move itself before writing): the moved
// file's content is byte-identical to the old one except its own relative specifiers, and each
// of those still resolves to the same target (taking the move into account).
//
// Prints a JSON report: { moved, rewritten, warnings }. Exit 2 on a refusal.
// Zero dependencies: node:* only.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = (p) => p.split(path.sep).join('/');

const CODE_EXT = /\.(?:c|m)?[jt]s$/;
const RESOLVE_EXT = ['', '.js', '.cjs', '.mjs', '.json', '.ts', '.mts', '.d.ts'];
const TEXT_EXT = /\.(?:m?js|cjs|ts|mts|tsx|jsx|json|ya?ml|md|mdx|sh|txt)$/;
const SKIP_DIR = new Set(['node_modules', '.git', '.claude', 'coverage', 'dist', 'build', '.next']);
/** A quoted specifier that starts with ./ or ../ (or is exactly . / ..). */
const REL_LITERAL = /(['"`])(\.{1,2}(?:\/[^'"`\n\\]*)?)\1/g;
/** `path.join(ROOT, 'stores/x')` / `path.resolve(SERVER, "stores/x.js")` */
const ROOTED = /(path\.(?:join|resolve)\(\s*[A-Za-z_$][\w$.]*\s*,\s*)(['"])([^'"\n]+)\2/g;

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The file a specifier lands on, as Node picks it (enough of it): abs path or null. */
export function resolveSpec(abs) {
    for (const ext of RESOLVE_EXT) if (isFile(abs + ext)) return abs + ext;
    for (const idx of ['index.js', 'index.cjs', 'index.mjs']) if (isFile(path.join(abs, idx))) return path.join(abs, idx);
    return null;
}

/** All files under dir (skipping vendored folders), absolute. */
function walk(dir, ok, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIR.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, ok, out);
        else if (ok(e.name)) out.push(full);
    }
    return out;
}

/** Relative specifier from fromDir to target, written in the style of `oldSpec`. */
function writeSpec(fromDir, target, oldSpec, oldTarget) {
    let t = target;
    const hadExt = RESOLVE_EXT.slice(1).some((e) => oldSpec.endsWith(e)) && path.basename(oldSpec).includes('.');
    const wasIndex = !hadExt && path.basename(oldTarget).startsWith('index.') && !/index(\.|$)/.test(path.basename(oldSpec));
    if (wasIndex && path.basename(t).startsWith('index.')) t = path.dirname(t);
    else if (!hadExt) t = t.replace(/\.(?:c|m)?js$/, '');
    let r = posix(path.relative(fromDir, t));
    if (r === '') r = '.';
    if (!r.startsWith('.')) r = `./${r}`;
    return r;
}

/** Colocated companions of a source file: x.test.js, x.<what>.test.js, x.testkit.js. */
function companions(abs) {
    const dir = path.dirname(abs);
    const base = path.basename(abs).replace(/\.(?:c|m)?[jt]s$/, '');
    const ext = path.extname(abs);
    return fs.readdirSync(dir).filter((n) => {
        if (n === path.basename(abs)) return false;
        return (n.startsWith(`${base}.`) && /\.test\.(?:c|m)?[jt]s$/.test(n)) || n === `${base}.testkit${ext}`;
    }).map((n) => path.join(dir, n));
}

/**
 * Plan + apply a move. `pairs` are [fromAbs, toAbs]. Returns the report; writes nothing when `dry`.
 * @param {Array<[string, string]>} pairs
 * @param {{ root?: string, dry?: boolean, tests?: boolean, git?: boolean }} opts
 */
export function move(pairs, opts = {}) {
    const root = opts.root ?? REPO;
    const server = path.join(root, 'server');
    const warnings = [];
    /** old abs -> new abs */
    const map = new Map();
    for (const [from, rawTo] of pairs) {
        if (!isFile(from)) throw refuse(`not a file: ${from}`);
        let to = rawTo;
        if (isDir(to) || rawTo.endsWith('/')) to = path.join(to, path.basename(from));
        if (!to.startsWith(`${server}${path.sep}`)) throw refuse(`target is outside server/: ${to}`);
        if (isFile(to)) throw refuse(`target exists: ${to}`);
        map.set(from, to);
        if (opts.tests !== false) {
            const nb = path.basename(to).replace(/\.(?:c|m)?[jt]s$/, '');
            const ob = path.basename(from).replace(/\.(?:c|m)?[jt]s$/, '');
            for (const c of companions(from)) {
                const nn = nb + path.basename(c).slice(ob.length);
                map.set(c, path.join(path.dirname(to), nn));
            }
        }
    }
    const seen = new Set();
    for (const to of map.values()) {
        if (seen.has(to)) throw refuse(`two files move to ${to}`);
        seen.add(to);
        if (isFile(to)) throw refuse(`target exists: ${to}`);
    }

    const files = walk(server, (n) => CODE_EXT.test(n));
    const edits = new Map(); // abs file (old location) -> new text
    /** every file's rewritten specifiers (moved or not) */
    const allChanges = new Map();
    const aliasedFiles = new Set();
    const touchesMoved = new Set(); // files that name a moved file
    const specChanges = new Map(); // moved file -> [{ oldSpec, newSpec, target(old abs), mapped }]
    const reportRewritten = [];

    for (const file of files) {
        const oldDir = path.dirname(file);
        const newFile = map.get(file) ?? file;
        const newDir = path.dirname(newFile);
        const moved = map.has(file);
        const src = fs.readFileSync(file, 'utf8');
        const changes = [];
        let text = src.replace(REL_LITERAL, (whole, q, spec) => {
            const abs = path.resolve(oldDir, spec);
            const hit = resolveSpec(abs);
            let target = hit;
            let isDirLit = false;
            if (!hit && isDir(abs)) { target = abs; isDirLit = true; }
            if (!target) {
                if (moved && /require\(\s*$/.test(src.slice(0, src.indexOf(whole)))) warnings.push(`${rel(root, file)}: unresolved require ${spec}`);
                return whole;
            }
            const mapped = map.get(target);
            const newTarget = mapped ?? target;
            if (!moved && !mapped) return whole;
            const next = isDirLit
                ? (() => { let r = posix(path.relative(newDir, newTarget)) || '.'; if (!r.startsWith('.')) r = `./${r}`; return r; })()
                : writeSpec(newDir, newTarget, spec, hit);
            if (next === spec) return whole;
            changes.push({ oldSpec: spec, newSpec: next, target, mapped: Boolean(mapped) });
            return `${q}${next}${q}`;
        });
        // server-rooted literals ('stores/x') naming a moved file
        text = text.replace(ROOTED, (whole, head, q, lit) => {
            if (lit.startsWith('.')) return whole;
            const abs = path.join(server, lit);
            const hit = resolveSpec(abs);
            const mapped = hit && map.get(hit);
            if (!mapped) return whole;
            const hadExt = /\.(?:c|m)?js$/.test(lit);
            let n = posix(path.relative(server, mapped));
            if (!hadExt) n = n.replace(/\.(?:c|m)?js$/, '');
            changes.push({ oldSpec: lit, newSpec: n, target: hit, mapped: true, rooted: true });
            return `${head}${q}${n}${q}`;
        });
        allChanges.set(file, changes);
        if (changes.some((c) => c.mapped)) touchesMoved.add(file);
        if (text !== src) {
            edits.set(file, text);
            reportRewritten.push({ file: rel(root, newFile), changes: changes.length });
            if (moved) specChanges.set(file, changes);
        }
        if (moved) {
            if (/__dirname|process\.cwd\(\)/.test(src) && !/path\.(join|resolve)\(\s*__dirname\s*,\s*['"]\./.test(src) && /__dirname/.test(src)) {
                warnings.push(`${rel(root, file)}: uses __dirname in a way the mover cannot re-base; check it by hand`);
            }
        }
    }

    // Resolve-stub keys are the require strings AS WRITTEN in the module under test
    // (testUtils/stubRequire.js): when a moved file's string changes, a stub keyed on the old
    // string silently stops applying. Warn for every test that names an old string as a key.
    const stubTests = files.filter((f) => /\.(?:test|testkit)\.(?:c|m)?js$/.test(f));
    for (const f of stubTests) {
        const t = edits.get(f) ?? fs.readFileSync(f, 'utf8');
        if (!/installResolveStub|_resolveFilename/.test(t)) continue;
        if (!touchesMoved.has(f) && !map.has(f)) continue;
        /** @type {Array<[string, string]>} */
        const pairs = [];
        for (const changes of allChanges.values()) {
            for (const c of changes) {
                if (c.rooted || c.oldSpec === c.newSpec) continue;
                if (!pairs.some(([a, b]) => a === c.oldSpec && b === c.newSpec)) pairs.push([c.oldSpec, c.newSpec]);
            }
        }
        const { text: aliased, added } = aliasStubKeys(t, pairs.filter(([o]) => new RegExp(`['"]${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`).test(t)));
        if (added.length) {
            edits.set(f, aliased);
            aliasedFiles.add(f);
            if (!reportRewritten.some((r) => r.file === rel(root, map.get(f) ?? f))) reportRewritten.push({ file: rel(root, map.get(f) ?? f), changes: added.length });
            warnings.push(`${rel(root, f)}: added ${added.length} stub-key alias(es): ${added.map(([a, b]) => `${a} -> ${b}`).join(', ')}`);
        }
        if (/_resolveFilename/.test(t) && !/installResolveStub/.test(t)) warnings.push(`${rel(root, f)}: hand-rolled _resolveFilename stub; check its keys by hand`);
    }

    // Move-equivalence gate: undo the recorded specifier changes on the new text; must equal the old text.
    for (const [file, changes] of specChanges) {
        if (aliasedFiles.has(file)) continue;
        const gate = equivalence(fs.readFileSync(file, 'utf8'), edits.get(file), changes);
        if (gate) throw refuse(`move-equivalence failed for ${rel(root, file)}: ${gate}`);
    }

    // Non-code text: server/*.json budgets, and `server/<path>` anywhere else in the repo.
    const textEdits = new Map();
    const oldRels = [...map].map(([o, n]) => [posix(path.relative(server, o)), posix(path.relative(server, n))]);
    for (const f of walk(root, (n) => TEXT_EXT.test(n))) {
        if (f.startsWith(`${server}${path.sep}`) && CODE_EXT.test(f)) continue;
        if (edits.has(f)) continue;
        const rf = posix(path.relative(root, f));
        if (/package-lock\.json$/.test(rf)) continue;
        let src;
        try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
        let text = src;
        const inServerJson = f.startsWith(`${server}${path.sep}`) && f.endsWith('.json') && path.dirname(f) === server
            || f.startsWith(path.join(server, 'scripts') + path.sep) && f.endsWith('.json');
        for (const [o, n] of oldRels) {
            text = replacePath(text, `server/${o}`, `server/${n}`);
            if (inServerJson) text = replacePath(text, o, n, true);
        }
        if (text !== src) textEdits.set(f, text);
    }
    // JS files (other than server code) that name the repo path, e.g. mobile lockstep tests
    for (const f of walk(root, (n) => CODE_EXT.test(n) || /\.tsx$/.test(n))) {
        if (f.startsWith(`${server}${path.sep}`)) continue;
        if (edits.has(f) || textEdits.has(f)) continue;
        const src = fs.readFileSync(f, 'utf8');
        let text = src;
        for (const [o, n] of oldRels) text = replacePath(text, `server/${o}`, `server/${n}`);
        if (text !== src) textEdits.set(f, text);
    }

    // Leftovers worth a look: the old path as a bare string somewhere we did not rewrite.
    for (const [o] of oldRels) {
        const base = o.replace(/\.(?:c|m)?js$/, '');
        const leftover = grepRepo(root, base, new Set([...edits.keys(), ...textEdits.keys()]));
        for (const l of leftover.slice(0, 5)) warnings.push(`mentions ${o}: ${l}`);
    }

    if (!opts.dry) {
        for (const [file, text] of edits) fs.writeFileSync(file, text);
        for (const [file, text] of textEdits) fs.writeFileSync(file, text);
        for (const [from, to] of map) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            gitMv(root, from, to, opts.git !== false);
        }
        // an emptied directory is not left behind
        for (const [from] of map) pruneEmpty(path.dirname(from), server);
    }
    return {
        moved: [...map].map(([f, t]) => ({ from: rel(root, f), to: rel(root, t) })),
        rewritten: reportRewritten,
        textFiles: [...textEdits.keys()].map((f) => rel(root, f)),
        warnings: [...new Set(warnings)],
    };
}

/**
 * Give a stub key an alias for the require string its module now uses. `text` has
 * `'<old>': VALUE` inside an `installResolveStub({...})` call; the value is hoisted into a const
 * before that statement (one object, two keys) and the alias is added after the entry.
 * Returns the new text and the aliases added.
 * @param {string} text
 * @param {Array<[string, string]>} pairs [oldSpec, newSpec]
 */
export function aliasStubKeys(text, pairs) {
    const added = [];
    let out = text;
    let n = 0;
    for (const [oldSpec, newSpec] of pairs) {
        const esc = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const keyRe = new RegExp(`(['"])${esc}\\1\\s*:\\s*`, 'g');
        let m;
        while ((m = keyRe.exec(out))) {
            const callAt = out.lastIndexOf('installResolveStub(', m.index);
            if (callAt < 0 || out.indexOf(`'${newSpec}'`, callAt) >= 0 && out.indexOf(`'${newSpec}'`, callAt) < m.index + 2000) continue;
            // the value runs to the next top-level comma or the closing brace of the object
            let i = m.index + m[0].length;
            const vStart = i;
            let depth = 0;
            let quote = '';
            for (; i < out.length; i += 1) {
                const c = out[i];
                if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
                if (c === '/' && out[i + 1] === '/') { while (i < out.length && out[i] !== '\n') i += 1; continue; }
                if (c === '/' && out[i + 1] === '*') { i = out.indexOf('*/', i + 2) + 1; continue; }
                if ('({['.includes(c)) depth += 1;
                else if (')}]'.includes(c)) { if (depth === 0) break; depth -= 1; } else if (c === ',' && depth === 0) break;
            }
            const value = out.slice(vStart, i).trimEnd();
            if (!value) continue;
            const indent = (/^[ \t]*/.exec(out.slice(out.lastIndexOf('\n', m.index) + 1))?.[0]) ?? '    ';
            let entryValue = value;
            let hoist = '';
            if (!/^[A-Za-z_$][\w$.]*$/.test(value)) {
                n += 1;
                const name = `stubFor${n}`;
                hoist = `const ${name} = ${value};\n\n`;
                entryValue = name;
            }
            const tail = out[i] === ',' ? i + 1 : i;
            const insertEntry = `\n${indent}'${newSpec}': ${entryValue},`;
            const stmtStart = out.lastIndexOf('\n', callAt) + 1;
            // apply the later edit first so the earlier offsets stay valid
            out = `${out.slice(0, vStart)}${entryValue}${out.slice(i, tail)}${insertEntry}${out.slice(tail)}`;
            out = `${out.slice(0, stmtStart)}${hoist}${out.slice(stmtStart)}`;
            added.push([oldSpec, newSpec]);
            keyRe.lastIndex = 0;
            break;
        }
    }
    return { text: out, added };
}

function replacePath(text, from, to, quotedOnly = false) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = quotedOnly ? new RegExp(`(["'])${esc}\\1`, 'g') : new RegExp(`(^|[^\\w./-])${esc}(?![\\w-]|\\.(?:test\\.)?(?:c|m)?[jt]s\\w)`, 'g');
    if (quotedOnly) return text.replace(re, (_m, q) => `${q}${to}${q}`);
    // path with or without its extension: replace the stem, keep what follows
    const stem = from.replace(/\.(?:c|m)?js$/, '');
    const stemTo = to.replace(/\.(?:c|m)?js$/, '');
    if (stem !== from) {
        const e2 = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return text.replace(new RegExp(`(^|[^\\w./-])${e2}(?![\\w/-])`, 'g'), (_m, pre) => `${pre}${stemTo}`);
    }
    return text.replace(re, (_m, pre) => `${pre}${to}`);
}

function grepRepo(root, needle, skip) {
    const out = [];
    const re = new RegExp(`(?<![\\w-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    for (const f of walk(root, (n) => TEXT_EXT.test(n))) {
        if (skip.has(f) || /package-lock\.json$/.test(f)) continue;
        let src;
        try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
        // Only server-rooted mentions are interesting: 'stores/x' preceded by a quote or "server/".
        if (!re.test(src)) continue;
        const line = src.split('\n').findIndex((l) => re.test(l));
        const l = src.split('\n')[line];
        if (/require\(\s*['"]\./.test(l)) continue; // a relative require elsewhere with the same tail
        out.push(`${rel(root, f)}:${line + 1}`);
    }
    return out;
}

function gitMv(root, from, to, useGit) {
    if (useGit) {
        try {
            execFileSync('git', ['mv', from, to], { cwd: root, stdio: 'pipe' });
            return;
        } catch { /* untracked or no git: plain rename */ }
    }
    fs.renameSync(from, to);
}

function pruneEmpty(dir, stop) {
    let d = dir;
    while (d.startsWith(`${stop}${path.sep}`)) {
        try { if (fs.readdirSync(d).length) return; fs.rmdirSync(d); } catch { return; }
        d = path.dirname(d);
    }
}

const rel = (root, p) => posix(path.relative(root, p));
function refuse(msg) { const e = /** @type {any} */ (new Error(msg)); e.refused = true; return e; }

/**
 * Gate: replacing the new specifiers with the old ones turns `after` back into `before`.
 * Returns an error string or null.
 */
function equivalence(before, after, changes) {
    // Walk both texts: the skeleton outside the changed literals must be identical.
    let a = after;
    const queue = changes.filter((c) => !c.rooted).map((c) => [c.newSpec, c.oldSpec]);
    const rooted = changes.filter((c) => c.rooted).map((c) => [c.newSpec, c.oldSpec]);
    const re = REL_LITERAL;
    re.lastIndex = 0;
    let i = 0;
    a = a.replace(re, (whole, q, spec) => {
        const hit = queue[i];
        if (hit && hit[0] === spec) { i += 1; return `${q}${hit[1]}${q}`; }
        return whole;
    });
    for (const [n, o] of rooted) a = a.replace(n, o);
    return a === before ? null : 'content differs beyond relative specifiers';
}

/**
 * --check: `before` is the old content (e.g. `git show HEAD:server/x.js`), `after` the new file.
 * Everything except relative specifier literals must be identical, and the literal counts must match.
 */
export function checkEquivalent(before, after) {
    const skel = (s) => s.replace(REL_LITERAL, '$1.$1').replace(ROOTED, '$1$2.$2');
    if (skel(before) !== skel(after)) return 'content differs beyond relative specifiers';
    return null;
}

function cli(argv) {
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    const args = argv.filter((a) => !a.startsWith('--'));
    const abs = (p) => path.resolve(REPO, p.startsWith('server/') ? p : `server/${p}`);
    try {
        if (flags.has('--check')) {
            const [ref, ...rest] = args;
            let bad = 0;
            for (let i = 0; i < rest.length; i += 2) {
                const from = posix(path.relative(REPO, abs(rest[i])));
                const before = execFileSync('git', ['show', `${ref}:${from}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
                let to = abs(rest[i + 1]);
                if (isDir(to)) to = path.join(to, path.basename(from));
                const err = checkEquivalent(before, fs.readFileSync(to, 'utf8'));
                console.log(`${err ? 'FAIL' : 'ok  '} ${from} -> ${rel(REPO, to)}${err ? `: ${err}` : ''}`);
                if (err) bad += 1;
            }
            process.exit(bad ? 1 : 0);
        }
        if (args.length < 2 || args.length % 2) {
            console.error('usage: node scripts/server-mv.mjs <from> <to> [<from> <to> ...] [--dry] [--no-tests]');
            process.exit(2);
        }
        const pairs = [];
        for (let i = 0; i < args.length; i += 2) pairs.push([abs(args[i]), abs(args[i + 1])]);
        const report = move(pairs, { dry: flags.has('--dry'), tests: !flags.has('--no-tests') });
        console.log(JSON.stringify(report, null, 2));
    } catch (e) {
        if (e.refused) { console.error(`refused: ${e.message}`); process.exit(2); }
        throw e;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
