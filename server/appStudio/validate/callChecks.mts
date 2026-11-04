/**
 * App Studio validator — call_action: one action running another as a subroutine.
 *
 *   checkCallAction  per step (and per bare call_action action): the target exists.
 *   validateCallParams  the `params` map: names, count, each value a binding.
 *   checkCallGraph   once per definition: no cycle (an action may not call itself,
 *                    directly or through others), at most LIMITS.MAX_CALL_DEPTH calls
 *                    deep, and a warning for a `params.<name>` the callee reads but a
 *                    call does not pass.
 *
 * The graph reads come from ../actionCalls.mts; this file never imports validate.js.
 */

import { createRequire } from 'node:module';
import type * as ActionCalls from '../actionCalls.mts';

const nodeRequire = createRequire(import.meta.url);
// Required, not imported: agent-hub's typecheck reaches this file through validate.js,
// and its tsconfig refuses a `.mts` import path (the other validate/*.mts do the same).
const { callTargets, closeOverCalls, findCallCycles, longestCallChain, ownAction, paramNamesRead } = nodeRequire('../actionCalls.mts') as typeof ActionCalls;
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as { LIMITS: { MAX_CALL_DEPTH: number; MAX_CALL_PARAMS: number } };
const { pickClosestId } = nodeRequire('./shared.js') as { pickClosestId: (v: unknown, ids: string[]) => string | null };
const { validateBinding } = nodeRequire('./bindings.js') as { validateBinding: (field: string, value: unknown, path: string, ctx: Ctx) => void };

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; actionIds: Set<string>; actions?: Obj | null };

/** A params name: what `params.<name>` can read. */
export const CALL_PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The `params` field of a call_action: { <name>: binding }, at most MAX_CALL_PARAMS. */
export function validateCallParams(field: string, value: unknown, path: string, ctx: Ctx): void {
    if (!isObject(value)) {
        ctx.pushE({ code: 'action.call_param_invalid', severity: 'error', path, message: `\`${field}\` must be an object map of { name: binding }.`, hint: 'Use { "quick": {"kind":"formula","expr":"form.size < 10"} }; the called action reads params.quick.' });
        return;
    }
    const names = Object.keys(value);
    if (names.length > LIMITS.MAX_CALL_PARAMS) {
        ctx.pushE({ code: 'action.call_param_invalid', severity: 'error', path, message: `\`${field}\` has ${names.length} entries — the maximum is ${LIMITS.MAX_CALL_PARAMS}.`, hint: 'Pass fewer values, or one object value with the rest inside it.' });
        return;
    }
    for (const name of names) {
        if (!CALL_PARAM_NAME_RE.test(name)) {
            ctx.pushE({ code: 'action.call_param_invalid', severity: 'error', path: `${path}.${name}`, message: `Param name ${JSON.stringify(name.slice(0, 60))} cannot be read as params.<name>.`, hint: 'Use a single word: a letter or _ first, then letters, digits or _.' });
            continue;
        }
        validateBinding(name, value[name], `${path}.${name}`, ctx);
    }
}

/** A call_action step or bare action: the action it names must exist. */
export function checkCallAction(step: unknown, path: string, ctx: Ctx): void {
    if (!isObject(step)) return;
    const target = step.actionId;
    if (typeof target !== 'string' || !target) return; // the required-field check names it
    if (ctx.actionIds.has(target)) return;
    const suggestion = pickClosestId(target, [...ctx.actionIds]);
    ctx.pushE({
        code: 'action.call_target_unknown', severity: 'error', path: `${path}.actionId`,
        message: `call_action runs unknown action "${target.slice(0, 80)}".`,
        hint: suggestion ? `Did you mean "${suggestion}"?` : 'Use the id of one of definition.actions.',
    });
}

function chainText(chain: string[]): string {
    return chain.join(' → ');
}

/** Actions no other action calls: where a chain of calls starts. */
function chainHeads(actions: Obj): string[] {
    const called = new Set<string>();
    for (const id of Object.keys(actions)) {
        for (const t of callTargets(ownAction(actions, id))) if (t.actionId) called.add(t.actionId);
    }
    return Object.keys(actions).filter((id) => !called.has(id) && ownAction(actions, id)).sort();
}

function checkCycles(actions: Obj, ctx: Ctx): Set<string> {
    const inCycle = new Set<string>();
    for (const cycle of findCallCycles(actions)) {
        for (const id of cycle) inCycle.add(id);
        ctx.pushE({
            code: 'action.call_cycle', severity: 'error', path: `actions.${cycle[0]}`,
            message: `${chainText(cycle)}: an action may not call itself, directly or through others.`,
            hint: 'Move the shared steps into an action that none of them calls back.',
        });
    }
    return inCycle;
}

function checkDepth(actions: Obj, ctx: Ctx): void {
    for (const head of chainHeads(actions)) {
        const chain = longestCallChain(actions, head);
        if (chain.length - 1 <= LIMITS.MAX_CALL_DEPTH) continue;
        ctx.pushE({
            code: 'action.call_too_deep', severity: 'error', path: `actions.${head}`,
            message: `${chainText(chain)}${chain.length - 1 > LIMITS.MAX_CALL_DEPTH + 1 ? ' → …' : ''} is ${chain.length - 1} calls deep; the maximum is ${LIMITS.MAX_CALL_DEPTH}.`,
            hint: 'Let an action higher up call the deepest one directly, or merge two levels.',
        });
    }
}

function checkMissingParams(actions: Obj, ctx: Ctx): void {
    const reads = new Map<string, Set<string>>();
    for (const id of Object.keys(actions).sort()) {
        for (const t of callTargets(ownAction(actions, id))) {
            const callee = ownAction(actions, t.actionId);
            if (!callee) continue;
            if (!reads.has(t.actionId)) reads.set(t.actionId, paramNamesRead(callee));
            const step = stepAt(actions[id], t.path);
            const passed = isObject(step) && isObject(step.params) ? new Set(Object.keys(step.params)) : new Set<string>();
            const missing = [...(reads.get(t.actionId) ?? [])].filter((n) => !passed.has(n));
            if (!missing.length) continue;
            ctx.pushW({
                code: 'action.call_param_missing', severity: 'warning', path: `actions.${id}.${t.path === 'action[0]' ? 'params' : `${t.path}.params`}`,
                message: `"${t.actionId}" reads ${missing.slice(0, 5).map((n) => `params.${n}`).join(', ')}, which this call does not pass.`,
                hint: `Add ${missing.length === 1 ? 'it' : 'them'} to params; a param that is not passed reads as empty.`,
            });
        }
    }
}

const SEGMENT_RE = /\.?([A-Za-z]+)\[(\d+)\]/g;

/** The step at a callTargets path (`steps[1].then[0]`, `steps[0].cases[2].steps[1]`). */
function stepAt(action: unknown, path: string): unknown {
    let at: unknown = action;
    for (const m of path.matchAll(SEGMENT_RE)) {
        const [, key, idx] = m;
        if (key === 'action') return at;
        const list = isObject(at) ? at[key] : undefined;
        at = Array.isArray(list) ? list[Number(idx)] : undefined;
    }
    return at;
}

/**
 * The call graph of the whole definition, once, after the per-action checks:
 * cycles, depth, params a callee reads but a call omits. Returns `roots` plus
 * every action they call (what a reachable action calls is reachable; what an
 * unreachable one calls is not), for the unreachable-action warning.
 */
export function checkCallGraph(actions: unknown, ctx: Ctx, roots: Iterable<string> = []): Set<string> {
    if (!isObject(actions)) return new Set(roots);
    let any = false;
    for (const id of Object.keys(actions)) if (callTargets(ownAction(actions, id)).length) { any = true; break; }
    if (!any) return new Set(roots);
    checkCycles(actions, ctx);
    checkDepth(actions, ctx);
    checkMissingParams(actions, ctx);
    return closeOverCalls(actions, roots);
}
