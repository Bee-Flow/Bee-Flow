/**
 * The expectations of a saved action test, read against the outcome of a walk. Pure.
 *
 * A path reads one value of the run:
 *   ok                     the run ended without a failing step (and no budget stop)
 *   stopped                why it stopped ("steps[1] failed", a budget), or null
 *   vars, vars.<p>         the variables at the end of the run
 *   result, result.<p>     the result of the LAST server step that ran
 *   <step path>[.<field>]  one step's outcome, the longest known walker path first:
 *                          .status (ok | error | skipped | refused | not_run), .result…, .error,
 *                          .code, .prompt (an ai_generate step's filled-in prompt), .count
 *                          (how often it ran), .mocked, .ms, .note
 * The rest of a path after its root uses the shared path grammar (shared/expr/path.mjs).
 *
 * ops are the rule-row vocabulary of the expression engine (TEST_OF_OP: is, isNot, contains,
 * gt, isEmpty, ...), compared with the same element test (`elementPasses`). No regex.
 */

import { createRequire } from 'node:module';
import type { Outcome, OutcomeView } from '../sequenceWalk.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Rules = { TEST_OF_OP: Readonly<Record<string, string>>; UNARY_TESTS: readonly string[]; elementPasses: (el: unknown, test: string, value: unknown) => boolean };
type PathLib = { parsePath: (p: string) => unknown[] | null; getRelativePath: (v: unknown, p: string) => unknown };

const rules = (): Rules => nodeRequire('../../shared/expr/rules.mjs') as Rules;
const paths = (): PathLib => nodeRequire('../../shared/expr/path.mjs') as PathLib;

export type Expectation = { path: string; op: string; value?: unknown };
export type ExpectationResult = { path: string; op: string; expected?: unknown; actual: unknown; pass: boolean; reason?: string };

/** The outcome fields a step path may read after the step itself. */
export const OUTCOME_FIELDS: readonly string[] = Object.freeze(['status', 'result', 'error', 'code', 'prompt', 'count', 'mocked', 'ms', 'note']);
const RUN_ROOTS: readonly string[] = Object.freeze(['ok', 'stopped', 'vars', 'result']);

/** Every op an expectation may use. */
export function expectationOps(): string[] {
    return Object.keys(rules().TEST_OF_OP);
}

/** True when `op` takes no value (isEmpty, isNotEmpty). */
export function isUnaryOp(op: string): boolean {
    const { TEST_OF_OP, UNARY_TESTS } = rules();
    return Object.hasOwn(TEST_OF_OP, op) && UNARY_TESTS.includes(TEST_OF_OP[op]);
}

/** The longest known step path `path` starts with (`steps[1]` must not match `steps[10]`). */
function stepRootOf(path: string, known: Iterable<string>): string | null {
    let best: string | null = null;
    for (const p of known) {
        if (path !== p && !path.startsWith(`${p}.`)) continue;
        if (!best || p.length > best.length) best = p;
    }
    return best;
}

function runRootOf(path: string): string | null {
    for (const root of RUN_ROOTS) if (path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[`)) return root;
    return null;
}

/** null when `path` can be read against an action with these walker paths, else why not. */
export function pathProblem(path: unknown, known: Iterable<string>): string | null {
    if (typeof path !== 'string' || !path.trim()) return 'a path is required';
    const p = path.trim();
    if (!paths().parsePath(p)) return `"${p.slice(0, 80)}" is not a path`;
    const step = stepRootOf(p, known);
    if (step) {
        if (p === step) return null;
        const field = p.slice(step.length + 1).split(/[.[]/)[0];
        return OUTCOME_FIELDS.includes(field) ? null : `"${p.slice(0, 80)}": after a step path read one of ${OUTCOME_FIELDS.join(', ')}`;
    }
    if (runRootOf(p)) return null;
    return `"${p.slice(0, 80)}" starts with neither ok, stopped, vars, result nor a step path of this action`;
}

function rest(path: string, root: string): string {
    return path.slice(root.length).replace(/^\./, '');
}

function outcomeObject(o: Outcome): Obj {
    const { path: _p, kind: _k, ordinal: _o, ...fields } = o;
    return { ...fields, mocked: o.mocked === true };
}

/** The value `path` names in the run, undefined when absent. */
export function readPath(view: OutcomeView, path: string): unknown {
    const p = path.trim();
    const get = paths().getRelativePath;
    const step = stepRootOf(p, view.steps.keys());
    if (step) {
        const outcome = view.steps.get(step) as Outcome;
        return get(outcomeObject(outcome), rest(p, step));
    }
    const root = runRootOf(p);
    if (root === 'ok') return view.ok;
    if (root === 'stopped') return view.stopped;
    if (root === 'vars') return get(view.vars, rest(p, 'vars'));
    if (root === 'result') return get(view.result, rest(p, 'result'));
    return undefined;
}

function implicitStop(view: OutcomeView): ExpectationResult | null {
    if (view.ok) return null;
    const why = view.failed ? `${view.failed.path} failed: ${view.failed.error}` : (view.stopped ?? 'an error');
    return { path: 'ok', op: 'is', expected: true, actual: false, pass: false, reason: `the run stopped: ${why}` };
}

/**
 * Every expectation against the view, plus an implicit "the run did not stop on an error"
 * when no expectation reads ok or stopped. `trim` shapes `actual` for the report.
 */
export function evaluateTest(view: OutcomeView, expect: Expectation[], trim: (v: unknown) => unknown = (v) => v): { pass: boolean; results: ExpectationResult[] } {
    const { TEST_OF_OP, elementPasses } = rules();
    const results: ExpectationResult[] = expect.map((e) => {
        const actual = readPath(view, e.path);
        const unary = isUnaryOp(e.op);
        let pass = false;
        let reason: string | undefined;
        try {
            pass = Object.hasOwn(TEST_OF_OP, e.op) ? elementPasses(actual ?? null, TEST_OF_OP[e.op], e.value) : false;
            if (!Object.hasOwn(TEST_OF_OP, e.op)) reason = `unknown op "${e.op}"`;
        } catch {
            reason = `op "${e.op}" could not compare these values`;
        }
        return { path: e.path, op: e.op, ...(unary ? {} : { expected: e.value }), actual: trim(actual ?? null), pass, ...(reason ? { reason } : {}) };
    });
    const readsStop = expect.some((e) => runRootOf(e.path.trim()) === 'ok' || runRootOf(e.path.trim()) === 'stopped');
    const stop = readsStop ? null : implicitStop(view);
    if (stop) results.push(stop);
    return { pass: results.every((r) => r.pass), results };
}
