/**
 * Run a pure agent-hub module inside a mobile test, for a differential
 * lockstep test (ARCHITECTURE "Sharing logic with the web app").
 *
 * A plain `require` works only for a web file with no imports: Babel turns an
 * import into a call to an `@babel/runtime` helper resolved from agent-hub's
 * own node_modules, which the mobile job does not install. So the source is
 * read as text, its `import` lines are dropped, its `export` keywords are
 * stripped, and the named dependencies are handed in by the test — the web's
 * own implementation of each, loaded the same way, wherever that matters.
 *
 * Test-only; nothing in the app imports this.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** The repository root, resolved from mobile/src/shared/testing. */
const REPO = path.resolve(__dirname, '../../../..');

/** The web tree of the core root (agent-hub/src). A file may also sit in a module root: use webPath(). */
export const AGENT_HUB_SRC = `${REPO}/agent-hub/src`;

/**
 * The `src/` directory of every root of the web client, the core first: agent-hub/
 * and each modules/<id>/frontend/ (server/moduleRoots.cjs and scripts/lib/roots.mjs
 * keep the same order). A web file keeps its path under src/ (its tree path) when it
 * moves into a module, so a lockstep test names it that way and finds it here.
 */
export function webSrcRoots(): string[] {
    const roots = [AGENT_HUB_SRC];
    const modules = path.join(REPO, 'modules');
    if (fs.existsSync(modules)) {
        for (const id of fs.readdirSync(modules).sort()) {
            const src = path.join(modules, id, 'frontend', 'src');
            if (fs.existsSync(src)) roots.push(src);
        }
    }
    return roots;
}

/**
 * The absolute path of a web file (or directory) by its path under src/, in the
 * first root that has it; the core root's path when none has it (so a missing
 * file still fails where it is read, with its name).
 */
export function webPath(relative: string): string {
    const rel = relative.replace(/^\/+/, '');
    for (const root of webSrcRoots()) {
        const abs = path.join(root, rel);
        if (fs.existsSync(abs)) return abs;
    }
    return path.join(AGENT_HUB_SRC, rel);
}

/** The path under src/ of an absolute web file, whichever root holds it; null outside every root. */
export function webTreePath(abs: string): string | null {
    for (const root of webSrcRoots()) {
        if (abs.startsWith(`${root}${path.sep}`)) return path.relative(root, abs).split(path.sep).join('/');
    }
    return null;
}

/** The text of a web file by its path under src/ (any root). */
export const readWebFile = (relative: string): string => fs.readFileSync(webPath(relative), 'utf8');

/**
 * A golden of the web's GUI inventory (agent-hub `*.inventory.golden.json`, written
 * from the running web code by the `*.inventory.test.ts` beside it), by its path under
 * src/: the lists the web's surface is composed from, as data, so a lockstep test
 * compares with them instead of cutting the web's source text apart.
 */
export function webGolden<T>(relative: string): T {
    return JSON.parse(fs.readFileSync(webPath(relative), 'utf8')) as T;
}

export function webFileExists(relative: string): boolean {
    return fs.existsSync(webPath(relative));
}

/**
 * The text of a web source file for a TEXTUAL lockstep test, wherever the split
 * left it: the file itself, the pieces of a folder that replaced it
 * (`Foo.tsx` -> `Foo/`), and its siblings (`Foo.helpers.ts`, `Foo.constants.ts`).
 * A test asks for the module it always asked for and finds the sentence in
 * whichever piece carries it now.
 */
export function webSourceText(relative: string): string {
    const abs = resolveWeb(relative);
    const dir = path.dirname(abs);
    const stem = path.basename(abs).replace(/\.[cm]?[jt]sx?$/, '');
    const own = (name: string) => /\.[cm]?[jt]sx?$/.test(name) && !/\.(?:test|spec|d|harness)\.[cm]?[jt]sx?$/.test(name);
    const out: string[] = [];
    if (fs.existsSync(abs)) out.push(fs.readFileSync(abs, 'utf8'));
    const walk = (folder: string) => {
        for (const e of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(folder, e.name);
            if (e.isDirectory()) walk(full);
            else if (own(e.name)) out.push(fs.readFileSync(full, 'utf8'));
        }
    };
    if (fs.existsSync(`${dir}/${stem}`) && fs.statSync(`${dir}/${stem}`).isDirectory()) walk(`${dir}/${stem}`);
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
        if (name.startsWith(`${stem}.`) && own(name) && `${dir}/${name}` !== abs) out.push(fs.readFileSync(`${dir}/${name}`, 'utf8'));
    }
    if (out.length === 0) throw new Error(`web source ${relative} not found`);
    return out.join('\n');
}

/** The source text of one top-level `function name(…) {…}`, braces matched. */
export function functionSource(src: string, name: string): string {
    const start = src.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1).replace(/^export /, '');
    }
    throw new Error(`function ${name} is not closed`);
}

/**
 * Only some pure functions out of a web file that as a whole cannot run here
 * (one with JSX in it, say): each named function's own source, evaluated with
 * `deps` in scope.
 */
export function loadWebFunctions<T = Record<string, unknown>>(
    relative: string,
    names: readonly string[],
    deps: Record<string, unknown> = {},
): T {
    const src = stripTypes(relative, fs.readFileSync(resolveWeb(relative), 'utf8'));
    const body = `${names.map((n) => functionSource(src, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
    return new Function(...Object.keys(deps), body)(...Object.values(deps)) as T;
}

const IMPORT_RX = /^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*$/gm;
const DECLARED_EXPORT_RX = /^export\s+(?:default\s+)?((?:async\s+)?(?:function\*?|const|let|class))\s+([A-Za-z0-9_$]+)/gm;
// `export { a, b } from './x';` re-exports another module's names; like `export * from`, they are not this module's own.
const REEXPORT_RX = /^export\s*\{[^}]*\}\s*from\s+['"][^'"]+['"];?[ \t]*$/gm;
const LIST_EXPORT_RX = /^export\s*\{([^}]*)\};?[ \t]*$/gm;

/** A path under src/ (any root), or an absolute one (a caller that resolved it itself). */
const resolveWeb = (file: string) => (file.startsWith('/') ? file : webPath(file));

/** A `.ts`/`.tsx` web file loses its type annotations first; a `.js` one is used as it is. */
function stripTypes(file: string, src: string): string {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, bounded: linear; a test helper run over repository file names
    if (!/\.tsx?$/.test(file)) return src;
    return ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } }).outputText;
}

const IMPORT_FULL_RX = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const REEXPORT_NAMED_RX = /^export\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const REEXPORT_ALL_RX = /^export \* from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const WEB_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** A web file's relative (or `@/`) import, as an absolute file; null for a package or a missing file. */
function resolveSibling(fromFile: string, spec: string): string | null {
    // By tree path, so an import that crosses from one root into another (a module's
    // file importing a core one, or the other way) resolves as the web build does.
    const fromAbs = resolveWeb(fromFile);
    const fromTree = webTreePath(fromAbs);
    let base: string;
    if (spec.startsWith('@/')) base = spec.slice(2);
    else if (spec.startsWith('.') && fromTree !== null) base = path.posix.join(path.posix.dirname(fromTree), spec);
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
    else return null;
    for (const ext of WEB_EXTENSIONS) {
        const candidate = path.isAbsolute(base) ? `${base}${ext}` : webPath(`${base}${ext}`);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

/**
 * The names a web file imports from its own tree, with the web's implementation
 * of each. A web file split into siblings (helpers, types, a folder) keeps
 * working here without every test listing the pieces; a sibling that cannot run
 * outside the browser (JSX, a package) is left out, and `deps` always wins.
 */
function siblingBindings(file: string, src: string, depth: number): Record<string, unknown> {
    const bindings: Record<string, unknown> = {};
    if (depth > 6) return bindings;
    const take = (spec: string, pick: (mod: Record<string, unknown>) => void) => {
        const resolved = resolveSibling(file, spec);
        if (!resolved) return;
        try {
            pick(loadWebModuleAt(resolved, {}, depth + 1));
        } catch {
            /* a sibling that needs the browser: its names stay unbound */
        }
    };
    for (const m of src.matchAll(IMPORT_FULL_RX)) {
        const clause = m[1] as string;
        take(m[2] as string, (mod) => {
            const named = clause.match(/\{([^}]*)\}/);
            for (const part of (named?.[1] ?? '').split(',')) {
                const [from, to] = part.trim().split(/\s+as\s+/);
                if (from && from in mod) bindings[to ?? from] = mod[from];
            }
            const ns = clause.match(/\*\s+as\s+([\w$]+)/);
            if (ns) bindings[ns[1] as string] = mod;
        });
    }
    return bindings;
}

/** The names a file re-exports from siblings (`export * from`, `export { a } from`). */
function reexportedNames(file: string, src: string, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (depth > 6) return out;
    for (const m of src.matchAll(REEXPORT_ALL_RX)) {
        const resolved = resolveSibling(file, m[1] as string);
        if (resolved) {
            try { Object.assign(out, loadWebModuleAt(resolved, {}, depth + 1)); } catch { /* browser-only sibling */ }
        }
    }
    for (const m of src.matchAll(REEXPORT_NAMED_RX)) {
        const resolved = resolveSibling(file, m[2] as string);
        if (!resolved) continue;
        try {
            const mod = loadWebModuleAt(resolved, {}, depth + 1);
            for (const part of (m[1] as string).split(',')) {
                const [from, to] = part.trim().split(/\s+as\s+/);
                if (from && from in mod) out[to ?? from] = mod[from];
            }
        } catch { /* browser-only sibling */ }
    }
    return out;
}

/**
 * Evaluate a web module's source with `deps` in scope; answers its named
 * exports — declared ones (`export function x`, `export async function`,
 * `export const`, `export class`) and listed ones (`export { a, b as c }`).
 * A trailing `export default name;` is dropped: the name is declared anyway.
 * Imports from the web's own tree (relative or `@/`) are loaded the same way
 * and bound by name, and so are the re-exports, so a file split into siblings
 * answers the same names; `deps` wins over both.
 */
export function loadWebModule<T = Record<string, unknown>>(file: string, deps: Record<string, unknown> = {}): T {
    return loadWebModuleAt(file, deps, 0) as T;
}

function loadWebModuleAt(file: string, deps: Record<string, unknown>, depth: number): Record<string, unknown> {
    const names = new Set<string>();
    const declared = new Set<string>();
    const stripped = stripTypes(file, fs.readFileSync(resolveWeb(file), 'utf8'));
    const bound = { ...siblingBindings(file, stripped, depth), ...deps };
    const reexported = reexportedNames(file, stripped, depth);
    const body = stripped
        .replace(IMPORT_RX, '')
        .replace(/^export \* from .*$/gm, '')
        .replace(REEXPORT_RX, '')
        .replace(/^export default [A-Za-z0-9_$]+;?[ \t]*$/gm, '')
        .replace(DECLARED_EXPORT_RX, (_m, kind: string, name: string) => {
            names.add(name);
            declared.add(name);
            return `${kind} ${name}`;
        })
        .replace(LIST_EXPORT_RX, (_m, list: string) => {
            for (const part of list.split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop();
                if (name) names.add(name);
            }
            return '';
        });
    const depNames = Object.keys(bound).filter((n) => !declared.has(n));
    const factory = new Function(...depNames, `'use strict';\n${body}\nreturn { ${[...names].join(', ')} };`);
    return { ...reexported, ...(factory(...depNames.map((name) => bound[name])) as Record<string, unknown>) };
}
