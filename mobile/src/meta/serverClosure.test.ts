/**
 * ci.yml's mobile job fires on the server files mobile reads, not on
 * server/**, and a job that does not fire produces no red.
 *
 * Mobile reaches into server/ three ways: two lockstep tests require() a
 * server module (and so load everything THAT module requires),
 * src/core/api/serverContract.test.ts reads route and store sources as text, and
 * src/core/i18n/dictionaryText.ts reads the English dictionary as text. The server
 * half of the mobile filter (the first `mobile:` block in ci.yml) lists that
 * set and nothing else, so a server PR that touches none of it skips the
 * mobile job.
 *
 * The require() half is the trap. One new require in componentSpecs.js puts a
 * file in the closure that the filter does not list; a later change to that
 * file breaks the lockstep test, and nothing goes red, because the job that
 * would have gone red no longer fires. (It happened once already: one lazy
 * require of mailboxConnector.js pulled ~1,070 server files into the closure,
 * and the filter had to be server/** to stay honest.) So the set is
 * recomputed here on every run, and a file no pattern covers fails the build.
 * This suite runs whenever the set can change: every file in it is in the
 * filter by construction, and so are mobile/** and ci.yml.
 *
 * The other direction fails too: a server pattern that covers nothing mobile
 * reads is a stale entry that runs the job for nothing.
 *
 * What this cannot see: a path built at runtime (a template literal, a name
 * joined in a loop), or a file read by a child process. Keep server paths in
 * mobile code plain string literals, the way the three readers write them.
 *
 * If this goes red, add the named file to the filter, or drop the stale
 * pattern. Do not relax the check.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const MOBILE = path.join(REPO, 'mobile');
const SERVER = path.join(REPO, 'server');
const WORKFLOW = path.join(REPO, '.github/workflows/ci.yml');

/**
 * Mobile files that NAME server paths without reading them: ciTriggers.test.ts
 * assembles the manifest names to forbid them, and this file is the checker.
 */
const NAMES_ONLY = new Set(['src/meta/ciTriggers.test.ts', 'src/meta/serverClosure.test.ts']);

/** Directories under mobile/ that hold no source of ours. */
const SKIP_DIRS = new Set(['node_modules', 'android', 'ios', 'coverage', 'dist']);

/** Repo-relative with forward slashes: the form ci.yml's patterns match. */
const rel = (p: string): string => path.relative(REPO, p).split(path.sep).join('/');
const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** A file's source minus comment-only lines: a comment naming a require is not one. */
function codeOf(file: string): string {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n');
}

/** The specifier of every require(), import(), `import '…'` and `from '…'` with a literal argument. */
function specifiersOf(file: string): string[] {
    if (file.endsWith('.json')) return [];
    const re = /\b(?:require|requireActual|import)\s*\(\s*(['"])([^'"\n]+)\1|\b(?:from|import)\s+(['"])([^'"\n]+)\3/g;
    return [...codeOf(file).matchAll(re)].map((m) => m[2] ?? m[4] ?? '');
}

/** Node's resolution for a relative specifier: the file, an extension, then a directory. */
function resolveModule(fromFile: string, spec: string): string | null {
    const base = path.resolve(path.dirname(fromFile), spec);
    if (isFile(base)) return base;
    for (const ext of ['.js', '.cjs', '.mjs', '.json', '.jsx', '.ts', '.tsx']) {
        if (isFile(base + ext)) return base + ext;
    }
    if (isDir(base)) {
        const pkg = path.join(base, 'package.json');
        if (isFile(pkg)) {
            const main = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { main?: string }).main;
            const resolved = main ? resolveModule(pkg, `./${main}`) : null;
            if (resolved) return resolved;
        }
        for (const index of ['index.js', 'index.cjs', 'index.mjs', 'index.json', 'index.jsx', 'index.ts', 'index.tsx']) {
            if (isFile(path.join(base, index))) return path.join(base, index);
        }
    }
    return null;
}

function mobileSources(dir: string = MOBILE, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) mobileSources(full, out);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** Every file under a directory, for a reader that walks it. */
function filesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) filesUnder(full, out);
        else out.push(full);
    }
    return out;
}

/** file → why it is in the set (which reader, or which file requires it). */
type ReadSet = Map<string, string>;

/**
 * What mobile reads from outside mobile/, found in the source itself.
 *
 * - `required`: relative require()/import specifiers that leave mobile/.
 * - `text`: server paths named by a string literal, either relative to the
 *   file (`'../../../server/x.js'`) or to a handle the file holds on the repo
 *   root or on server/ (`path.join(REPO, 'server/i18n/…')`,
 *   `read('stores/x.js')` off `SERVER`). Relative to a handle, only
 *   path-shaped literals count (a slash, or a file extension), so a word
 *   like 'config' in an assertion does not read as the server's config/.
 */
function whatMobileReads(): { required: ReadSet; text: ReadSet; unresolved: string[] } {
    const required: ReadSet = new Map();
    const text: ReadSet = new Map();
    const unresolved: string[] = [];

    for (const file of mobileSources()) {
        const reader = path.relative(MOBILE, file).split(path.sep).join('/');
        if (NAMES_ONLY.has(reader)) continue;
        const dir = path.dirname(file);

        const specs = new Set<string>();
        for (const spec of specifiersOf(file)) {
            if (!spec.startsWith('.') || inside(path.resolve(dir, spec), MOBILE)) continue;
            specs.add(spec);
            const target = resolveModule(file, spec);
            if (target) required.set(target, `required by mobile/${reader}`);
            else unresolved.push(`mobile/${reader} requires ${spec}`);
        }

        const literals = [...codeOf(file).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)]
            .map((m) => m[2] ?? '')
            .filter((s) => s && !s.includes('${') && !/\s/.test(s) && !path.isAbsolute(s) && !specs.has(s));
        const handles = new Set<string>();
        for (const s of literals) {
            const target = path.resolve(dir, s);
            if (target === REPO || target === SERVER) handles.add(target);
        }
        if (handles.has(REPO) && literals.some((s) => path.resolve(REPO, s) === SERVER)) handles.add(SERVER);

        const named = (target: string) => {
            if (target === SERVER || !inside(target, SERVER) || !fs.existsSync(target)) return;
            const why = `read as text by mobile/${reader}`;
            for (const f of isDir(target) ? filesUnder(target) : [target]) {
                if (!text.has(f)) text.set(f, why);
            }
        };
        for (const s of literals) {
            if (s.startsWith('.')) named(path.resolve(dir, s));
            if (!/\/|\.[a-z]+$/i.test(s)) continue;
            for (const handle of handles) named(path.resolve(handle, s));
        }
    }
    return { required, text, unresolved };
}

/** The static require closure of the seeds, with the file that pulled each one in. */
function requireClosure(seeds: ReadSet): { files: ReadSet; unresolved: string[] } {
    const files: ReadSet = new Map(seeds);
    const unresolved: string[] = [];
    const queue = [...seeds.keys()];
    while (queue.length > 0) {
        const file = queue.pop() as string;
        for (const spec of specifiersOf(file)) {
            if (!spec.startsWith('.')) continue;
            const target = resolveModule(file, spec);
            if (!target) {
                unresolved.push(`${rel(file)} requires ${spec}`);
            } else if (!files.has(target)) {
                files.set(target, `required by ${rel(file)}`);
                queue.push(target);
            }
        }
    }
    return { files, unresolved };
}

/** Every pattern under a `mobile:` key of a paths-filter in ci.yml. */
function mobilePatterns(): string[] {
    const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
    const out: string[] = [];
    lines.forEach((line, at) => {
        if (!/^ {10,}mobile:\s*$/.test(line)) return;
        const indent = line.search(/\S/);
        for (let i = at + 1; i < lines.length; i += 1) {
            const entry = lines[i] ?? '';
            if (entry.trim() === '') continue;
            if (entry.search(/\S/) <= indent) break;
            const m = /^-\s+(['"]?)(.+?)\1\s*$/.exec(entry.trim());
            if (m?.[2]) out.push(m[2]);
        }
    });
    return out;
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d`; nested braces included. */
function expandBraces(pattern: string): string[] {
    const open = pattern.indexOf('{');
    if (open === -1) return [pattern];
    let depth = 0;
    for (let i = open; i < pattern.length; i += 1) {
        if (pattern[i] === '{') depth += 1;
        if (pattern[i] !== '}' || (depth -= 1) > 0) continue;
        const body = pattern.slice(open + 1, i);
        const parts: string[] = [];
        let start = 0;
        let inner = 0;
        for (let j = 0; j < body.length; j += 1) {
            if (body[j] === '{') inner += 1;
            else if (body[j] === '}') inner -= 1;
            else if (body[j] === ',' && inner === 0) {
                parts.push(body.slice(start, j));
                start = j + 1;
            }
        }
        parts.push(body.slice(start));
        return parts.flatMap((part) => expandBraces(pattern.slice(0, open) + part + pattern.slice(i + 1)));
    }
    return [pattern];
}

const matches = (file: string, pattern: string): boolean => path.posix.matchesGlob(file, pattern);

describe("ci.yml's mobile filter covers everything mobile reads from server/", () => {
    const reads = whatMobileReads();
    const closure = requireClosure(reads.required);
    const patterns = mobilePatterns();
    const positive = patterns.filter((p) => !p.startsWith('!'));
    const negated = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
    // Conservative on negations whatever the step's predicate-quantifier: a
    // file a negation names never counts as covered.
    const covered = (file: string) =>
        positive.some((p) => matches(file, p)) && !negated.some((p) => matches(file, p));

    it('finds the readers and parses the filter', () => {
        expect(reads.required.size).toBeGreaterThan(0);
        expect(reads.text.size).toBeGreaterThan(0);
        expect(patterns.length).toBeGreaterThan(0);
    });

    it('resolves every require on the way', () => {
        // An unresolved specifier is a file the closure below cannot see.
        expect([...reads.unresolved, ...closure.unresolved]).toEqual([]);
    });

    it('lists every file in the require closure', () => {
        const uncovered = [...closure.files]
            .filter(([file]) => !inside(file, MOBILE) && !covered(rel(file)))
            .map(([file, why]) => `${rel(file)} (${why}) matches no pattern under \`mobile:\` in ci.yml`);
        // Named, not counted: the fix is a pattern in the filter (or dropping
        // the require), never a looser check.
        expect(uncovered).toEqual([]);
    });

    it('lists every server file read as text', () => {
        const uncovered = [...reads.text]
            .filter(([file]) => !covered(rel(file)))
            .map(([file, why]) => `${rel(file)} (${why}) matches no pattern under \`mobile:\` in ci.yml`);
        expect(uncovered).toEqual([]);
    });

    it('has no server pattern that covers nothing mobile reads', () => {
        const readFiles = [...closure.files.keys(), ...reads.text.keys()].map(rel);
        const stale = positive
            .filter((p) => p.startsWith('server/'))
            .flatMap(expandBraces)
            .filter((p) => !readFiles.some((file) => matches(file, p)))
            .map((p) => `${p} covers no server file mobile reads; drop it from the mobile filter`);
        expect(stale).toEqual([]);
    });
});
