/**
 * Formula baseline: what the expression engine made of every text in the compat corpus and of
 * its own golden corpus BEFORE the collection functions, `??`, the list and object literals and
 * author functions were added (server/shared/expr). formulas.test.js holds today's engine to it.
 *
 * A candidate is every distinct string anywhere in a corpus file (a formula is not marked as one
 * in every place, so all of them are tried) plus every expression of the engine's own CASES.
 * For each candidate the OLD engine could parse, `formulaBaseline.json` keeps a fingerprint of
 * the parsed tree and of the value it gave against SCOPE below. The same fingerprint today means
 * the same tree and the same answer: the additions changed nothing that was valid.
 *
 * The file was written once, by the engine as it was at `about.base`:
 *
 *   git archive <base> server/shared/expr | tar -x -C <dir>
 *   node server/appStudio/compat/formulaBaseline.mts --write <dir>/server/shared/expr
 *
 * It is never regenerated with the engine it is meant to check. A new corpus file or a new
 * golden case is simply not in it.
 *
 * `formulaAdditions.json` is the other half, written by the same old engine:
 *
 *   node server/appStudio/compat/formulaBaseline.mts --additions <dir>/server/shared/expr --base <rev>
 *
 * For every text of ADDITIONS below (one or more per thing that was added) it keeps the error the
 * OLD parser gave. A text is only written when the old engine refused it, so the file is the
 * proof that each addition could not be written in a formula that was valid before.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = path.join(HERE, 'formulaBaseline.json');
export const ADDITIONS_FILE = path.join(HERE, 'formulaAdditions.json');
const CORPUS_DIR = path.join(HERE, 'corpus');

/** What the engine gained after the baseline: every function, literal form and operator, in use. */
export const ADDITIONS: readonly string[] = Object.freeze([
    'sort(a)', 'sort(a, "k", "desc")', 'reverse(a)', 'slice(a, 1)', 'slice(a, 1, 2)', 'groupBy(a, "k")',
    'reduce(a, acc + it, 0)', 'keys(a)', 'values(a)', 'merge(a, b)', 'range(3)', 'range(1, 9, 2)',
    '[1, 2]', '[]', '[a, [b]]', '[1, 2][0]', '{ a: 1 }', '{}', '{ "a b": 1 }.a', 'a ?? b', 'a ? [1] : b',
    'len([1])', 'map(a, { id: it.id })', 'sum(map(range(3), it))',
]);

/** The scope every candidate is evaluated against. Fixed: the fingerprints depend on it. */
export const SCOPE = Object.freeze({
    form: { amount: 120, name: 'Ada', email: 'a@b.com', qty: 0, status: 'open', tags: ['x', 'y'] },
    forms: {},
    vars: { rate: 1.21, filters: { status: 'open' }, selected: null, count: 3 },
    item: { id: 'r1', total: 50, name: 'Item', status: 'open', amount: 12.5, created_at: '2026-07-01T08:00:00Z' },
    index: 1,
    value: 'v',
    params: { id: 'r1' },
    currentUser: { id: 'u1', name: 'Tom', email: 't@example.com', roleKey: 'manager', isOwner: false, roles: ['manager'] },
    records: {},
    datasets: {},
    connectors: {},
    actions: {},
    screen: {},
    error: null,
    now: '2026-07-04T12:00:00Z',
    today: '2026-07-04',
});

const hash = (text: string, n: number): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, n);

/** A value as text, with the values JSON cannot write kept apart. */
function show(value: unknown): string {
    const mark = (v: unknown): unknown => {
        if (v === undefined) return '__undefined__';
        if (typeof v === 'number' && !Number.isFinite(v)) return `__${String(v)}__`;
        return v;
    };
    return JSON.stringify(mark(value), (_k, v) => mark(v));
}

/** Every distinct string in a JSON value. */
function collectStrings(v: unknown, out: Set<string>): Set<string> {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out);
    return out;
}

/** The candidates: every string of every corpus file, and the given golden expressions. */
export function candidates(goldenCases: ReadonlyArray<{ expr: string }>): string[] {
    const out = new Set<string>();
    for (const f of fs.readdirSync(CORPUS_DIR).filter((n) => n.endsWith('.json')).sort()) {
        collectStrings(JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8')), out);
    }
    for (const c of goldenCases) out.add(c.expr);
    return [...out].sort();
}

export const keyOf = (expr: string): string => hash(expr, 12);

export interface Engine {
    parseExpr: (src: string) => unknown;
    evaluate: (ast: unknown, scope: unknown) => unknown;
}

/** The fingerprint of one candidate under an engine, or null when that engine rejects it. */
export function fingerprint(engine: Engine, expr: string): string | null {
    let ast: unknown;
    try { ast = engine.parseExpr(expr); } catch { return null; }
    let value: string;
    try { value = show(engine.evaluate(ast, SCOPE)); } catch (e) { value = `ERR:${e instanceof Error ? e.name : 'Error'}`; }
    return hash(`${JSON.stringify(ast)}\n${value}`, 12);
}

async function write(engineDir: string, base: string): Promise<void> {
    const engine: Engine = await import(pathToFileURL(path.join(engineDir, 'index.mjs')).href);
    const { CASES }: { CASES: Array<{ expr: string }> } = await import(pathToFileURL(path.join(engineDir, 'corpus.mjs')).href);
    const all = candidates(CASES);
    const entries: Record<string, string> = {};
    for (const expr of all) {
        const fp = fingerprint(engine, expr);
        if (fp) entries[keyOf(expr)] = fp;
    }
    const about = { base, candidates: all.length, parsed: Object.keys(entries).length, note: 'Written by the engine at `base`; see formulaBaseline.mjs. Never regenerate with a later engine.' };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ about, entries }, null, 0).replaceAll('","', '",\n"')}\n`);
    process.stdout.write(`${about.parsed} of ${about.candidates} candidates parsed at ${base}\n`);
}

/** The error an engine's parser gives for a text, or null when it parses. */
export function parseError(engine: Engine, expr: string): string | null {
    try { engine.parseExpr(expr); return null; } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
}

async function writeAdditions(engineDir: string, base: string): Promise<void> {
    const engine: Engine & { EXPR_FUNCTION_NAMES: string[] } = await import(pathToFileURL(path.join(engineDir, 'index.mjs')).href);
    const rejected: Record<string, string> = {};
    for (const expr of ADDITIONS) {
        const error = parseError(engine, expr);
        if (error === null) throw new Error(`the engine at ${base} parses ${expr}: it is not an addition`);
        rejected[expr] = error;
    }
    const about = { base, note: 'The parse error of the engine at `base` for every text of ADDITIONS, and the functions it had; see formulaBaseline.mts. Never regenerate with a later engine.', functions: engine.EXPR_FUNCTION_NAMES };
    fs.writeFileSync(ADDITIONS_FILE, `${JSON.stringify({ about, rejected }, null, 2)}\n`);
    process.stdout.write(`${ADDITIONS.length} additions refused at ${base}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const additions = process.argv.indexOf('--additions');
    const at = additions > 0 ? additions : process.argv.indexOf('--write');
    const b = process.argv.indexOf('--base');
    if (at < 0 || !process.argv[at + 1]) {
        process.stderr.write('usage: formulaBaseline.mts --write|--additions <dir of the OLD server/shared/expr> [--base <rev>]\n');
        process.exitCode = 2;
    } else {
        // No top-level await: formulas.test.js loads this file with require().
        (additions > 0 ? writeAdditions : write)(path.resolve(process.argv[at + 1]), (b > 0 && process.argv[b + 1]) || 'unknown').catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
    }
}
