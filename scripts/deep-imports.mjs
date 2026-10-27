#!/usr/bin/env node
/**
 * Deep relative imports in agent-hub/src -> the `@/` alias.
 *
 * `@/` maps to agent-hub/src (tsconfig `paths`, vite `resolve.alias`, which vitest
 * shares). A specifier that climbs three or more levels (`../../../utils/helpers`)
 * says nothing about where the module lives and breaks when the importing file
 * moves; `@/utils/helpers` does neither. This module is the one place that knows
 * which specifiers those are:
 *
 *   - the codemod (this file's CLI) rewrites them;
 *   - the `deep-imports` metric in scripts/count-ratchet.mjs counts what is left.
 *
 * What it rewrites, found with the TypeScript parser (so a string that merely
 * looks like an import, in a comment or in test data, is never touched):
 *   import ... from '…'        export ... from '…'        import x = require('…')
 *   import('…')                require('…')               import('…') as a type
 *   vi.mock / doMock / unmock / importActual / importMock (and the jest.* twins)
 * Only the text between the quotes changes: the quote style, the extension (or
 * the lack of one) and a trailing slash stay exactly as written. A specifier that
 * resolves outside src/ (`../../../../shared/x` from a shallow file) is left alone.
 *
 * Files the alias must NOT reach (isExcluded):
 *   - generated copies and sources of generated copies (scripts/shared-mirror.manifest.json):
 *     a source is copied byte for byte into mobile/, where `@/` means mobile/src, and a
 *     target must stay identical to its source;
 *   - files mobile's jest executes (agent-hub/src files required by a lockstep test, and
 *     what they import in turn): jest there maps `@/` to mobile/src. Listed in
 *     scripts/deep-imports.exclude.json, which lists files, never folders.
 *
 * Usage:
 *   node scripts/deep-imports.mjs            rewrite agent-hub/src in place
 *   node scripts/deep-imports.mjs --dry      list what would change, write nothing
 *   node scripts/deep-imports.mjs <files…>   only these files (paths from the repo root or agent-hub/src)
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'agent-hub', 'src');

let tsCache;
/** The TypeScript compiler API: the root's `typescript-api` alias, else agent-hub's own copy. */
function loadTs() {
    if (tsCache) return tsCache;
    try {
        tsCache = createRequire(path.join(ROOT, 'package.json'))('typescript-api');
    } catch {
        tsCache = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
    }
    return tsCache;
}

/** A specifier that starts with three or more `../`. */
export const DEEP_PREFIX = /^(?:\.\.\/){3,}/;
// Cheap pre-filter: a file without this text has nothing to parse.
const DEEP_TEXT = /['"`](?:\.\.\/){3}/;

const MOCK_OBJECTS = new Set(['vi', 'jest']);
const MOCK_METHODS = new Set([
    'mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock',
    'requireActual', 'requireMock', 'setMock', 'dontMock', 'deepUnmock',
]);

function scriptKind(ts, file) {
    if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
    if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
    return ts.ScriptKind.JSX;
}

/**
 * Every module specifier written in the file, as { start, end, spec } where
 * text.slice(start, end) === spec is the text between the quotes.
 */
export function findSpecifiers(text, file = 'x.ts') {
    const ts = loadTs();
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(ts, file));
    const out = [];
    const take = (lit) => {
        if (!lit || !(ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))) return;
        const start = lit.getStart(sf) + 1;
        const end = lit.end - 1;
        out.push({ start, end, spec: text.slice(start, end) });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            take(node.moduleSpecifier);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            take(node.moduleReference.expression);
        } else if (ts.isImportTypeNode(node)) {
            if (ts.isLiteralTypeNode(node.argument)) take(node.argument.literal);
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (callee.kind === ts.SyntaxKind.ImportKeyword) {
                take(node.arguments[0]);
            } else if (ts.isIdentifier(callee) && callee.text === 'require') {
                take(node.arguments[0]);
            } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
                const obj = callee.expression.text;
                const method = callee.name.text;
                if ((MOCK_OBJECTS.has(obj) && MOCK_METHODS.has(method)) || (obj === 'require' && method === 'resolve')) take(node.arguments[0]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** The `@/…` spelling of a deep relative specifier written in `fromRel` (a path under src), or null. */
export function aliasFor(spec, fromRel) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script over import specifiers of source files it reads itself; a fixed literal repeated, no nested quantifier: linear
    if (!DEEP_PREFIX.test(spec)) return null;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    if (target === '..' || target.startsWith('../') || target === '.' || target === './' || target === '') return null;
    return `@/${target}`;
}

/** The deep specifiers of one file that the alias can replace: [{ start, end, spec, to }]. */
export function deepSpecifiers(text, fromRel) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script over source files it reads itself; a fixed literal repeated, no nested quantifier: linear
    if (!DEEP_TEXT.test(text)) return [];
    const found = [];
    for (const s of findSpecifiers(text, fromRel)) {
        const to = aliasFor(s.spec, fromRel);
        if (to) found.push({ ...s, to });
    }
    return found;
}

/** Apply the rewrites from the back, so earlier offsets stay valid. */
export function applyRewrites(text, rewrites) {
    let out = text;
    for (const r of [...rewrites].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.to + out.slice(r.end);
    return out;
}

const norm = (p) => p.split(path.sep).join('/');

let excludedCache;
/** src-relative paths the alias must not reach (see the header). */
export function excludedFiles(root = ROOT) {
    if (excludedCache && root === ROOT) return excludedCache;
    const set = new Set();
    const manifestFile = path.join(root, 'scripts', 'shared-mirror.manifest.json');
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { entries: [] };
    const prefix = 'agent-hub/src/';
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return [];
        const st = fs.statSync(dir);
        if (st.isFile()) return [dir];
        return fs.readdirSync(dir).flatMap((n) => walk(path.join(dir, n)));
    };
    for (const e of manifest.entries) {
        for (const side of [e.source, e.target]) {
            if (!side.startsWith(prefix)) continue;
            for (const f of walk(path.join(root, side))) set.add(norm(path.relative(path.join(root, 'agent-hub', 'src'), f)));
        }
    }
    const extra = path.join(root, 'scripts', 'deep-imports.exclude.json');
    if (fs.existsSync(extra)) for (const f of JSON.parse(fs.readFileSync(extra, 'utf8')).files) set.add(f);
    if (root === ROOT) excludedCache = set;
    return set;
}

export const isExcluded = (srcRel, root = ROOT) => excludedFiles(root).has(srcRel);

function listFiles(dir, into = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'node_modules') listFiles(full, into);
        } else if (/\.[cm]?[jt]sx?$/.test(e.name)) into.push(full);
    }
    return into;
}

function main() {
    const argv = process.argv.slice(2);
    const dry = argv.includes('--dry');
    const given = argv.filter((a) => !a.startsWith('--'));
    const files = given.length
        ? given.map((f) => path.resolve(f))
        : listFiles(SRC);
    let changedFiles = 0;
    let changedSpecs = 0;
    let skippedExcluded = 0;
    for (const file of files) {
        const srcRel = norm(path.relative(SRC, file));
        if (srcRel.startsWith('..')) continue;
        const text = fs.readFileSync(file, 'utf8');
        const found = deepSpecifiers(text, srcRel);
        if (found.length === 0) continue;
        if (isExcluded(srcRel)) {
            skippedExcluded += found.length;
            continue;
        }
        changedFiles++;
        changedSpecs += found.length;
        if (dry) {
            for (const f of found) console.log(`${srcRel}: ${f.spec} -> ${f.to}`);
        } else {
            fs.writeFileSync(file, applyRewrites(text, found));
        }
    }
    console.log(`${dry ? 'would rewrite' : 'rewrote'} ${changedSpecs} specifiers in ${changedFiles} files; ${skippedExcluded} left alone in excluded files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
