/**
 * The call graph of an app's actions: which action runs which through a
 * `call_action` step (or a bare call_action action). Pure: reads a definition's
 * actions map, never runs anything.
 *
 * Every walk over child steps goes through stepFlow.childStepSlots, so a new
 * place that holds steps (a handler, a transaction body) is seen here without
 * touching this file. Lookups are own-property only (`__proto__` is never an
 * action), and every walk is bounded (nesting, call depth, a seen-set), so a
 * hand-written cyclic definition cannot make a reader loop.
 *
 * Readers: the validator (cycles, depth, reachability, send_email in a loop
 * through a call), the public surface (which callees ship with a public root),
 * find-nodes ("calls this action") and the server walker.
 */

import { createRequire } from 'node:module';
import { childStepSlots } from '../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as {
    LIMITS: { MAX_ACTION_DEPTH: number; MAX_CALL_DEPTH: number };
};

type Obj = Record<string, unknown>;

export type CallTarget = { actionId: string; path: string };

/** The deepest step nesting a walk follows (one past the validator's own ceiling). */
const MAX_NESTING = LIMITS.MAX_ACTION_DEPTH + 1;
/** Enough cycles to fix a definition; a pathological one is not enumerated in full. */
const MAX_CYCLES = 20;
/** DFS visits for the cycle search (200 actions, a few calls each, stays far below). */
const MAX_CYCLE_VISITS = 20_000;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The action `id` of `actions`, own property and an object, else null. */
export function ownAction(actions: unknown, id: unknown): Obj | null {
    if (!isObject(actions) || typeof id !== 'string' || !id) return null;
    if (!Object.hasOwn(actions, id)) return null;
    const a = actions[id];
    return isObject(a) ? a : null;
}

/** The top-level step list of an action and its path base (`steps` or `action` for a bare one). */
function topOf(action: unknown): { list: unknown[]; base: string } {
    if (!isObject(action)) return { list: [], base: 'steps' };
    if (action.kind === 'sequence') return { list: Array.isArray(action.steps) ? action.steps : [], base: 'steps' };
    return { list: [action], base: 'action' };
}

function visitSteps(list: unknown[], base: string, depth: number, visit: (step: Obj, path: string) => void): void {
    list.forEach((step, i) => {
        if (!isObject(step)) return;
        const path = `${base}[${i}]`;
        visit(step, path);
        if (depth >= MAX_NESTING) return;
        for (const slot of childStepSlots(step)) visitSteps(slot.steps, `${path}${slot.suffix}`, depth + 1, visit);
    });
}

/**
 * Every call_action in `action` (a sequence, or a bare call_action action), with its
 * walker path. Includes a call whose target is missing or not a string id (the
 * validator names those); `actionId` is then the raw value as text.
 */
export function callTargets(action: unknown): CallTarget[] {
    const out: CallTarget[] = [];
    const { list, base } = topOf(action);
    visitSteps(list, base, 1, (step, path) => {
        if (step.kind === 'call_action') out.push({ actionId: typeof step.actionId === 'string' ? step.actionId : '', path });
    });
    return out;
}

/** The ids `action` calls that exist in `actions`, deduplicated, in first-seen order. */
function calleesOf(actions: unknown, action: unknown): string[] {
    const seen = new Set<string>();
    for (const t of callTargets(action)) {
        if (t.actionId && !seen.has(t.actionId) && ownAction(actions, t.actionId)) seen.add(t.actionId);
    }
    return [...seen];
}

/**
 * The roots plus every action they reach through calls (breadth first, at most
 * `maxDepth` calls below a root). Roots that are not actions of the map are kept
 * as given (the caller decides what a dangling reference means).
 */
export function closeOverCalls(actions: unknown, roots: Iterable<string>, maxDepth = Number.POSITIVE_INFINITY): Set<string> {
    const out = new Set<string>();
    let frontier: string[] = [];
    for (const r of roots) {
        if (typeof r !== 'string' || out.has(r)) continue;
        out.add(r);
        frontier.push(r);
    }
    for (let depth = 0; frontier.length && depth < maxDepth; depth += 1) {
        const next: string[] = [];
        for (const id of frontier) {
            for (const callee of calleesOf(actions, ownAction(actions, id))) {
                if (out.has(callee)) continue;
                out.add(callee);
                next.push(callee);
            }
        }
        frontier = next;
    }
    return out;
}

/** id → the existing ids it calls, for every action of the map. */
function callGraph(actions: unknown): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    if (!isObject(actions)) return graph;
    for (const id of Object.keys(actions).sort()) {
        if (!ownAction(actions, id)) continue;
        graph.set(id, calleesOf(actions, actions[id]));
    }
    return graph;
}

/**
 * Every call cycle, each once, starting at its lowest id and closed on it
 * (`['act_a', 'act_b', 'act_a']`; a self-call is `['act_a', 'act_a']`). Bounded:
 * at most MAX_CYCLES cycles.
 */
export function findCallCycles(actions: unknown): string[][] {
    const graph = callGraph(actions);
    const cycles: string[][] = [];
    let visits = 0;
    for (const start of graph.keys()) {
        if (cycles.length >= MAX_CYCLES || visits > MAX_CYCLE_VISITS) break;
        const path = [start];
        const onPath = new Set(path);
        const dfs = (id: string): void => {
            for (const next of graph.get(id) ?? []) {
                if (cycles.length >= MAX_CYCLES || ++visits > MAX_CYCLE_VISITS) return;
                if (next === start) { cycles.push([...path, start]); continue; }
                // Only ids above the start: a cycle through a lower id was found from that id.
                if (next < start || onPath.has(next)) continue;
                path.push(next);
                onPath.add(next);
                dfs(next);
                path.pop();
                onPath.delete(next);
            }
        };
        dfs(start);
    }
    return cycles;
}

/**
 * The longest chain of calls starting at `fromId` (`[fromId, …]`), never
 * revisiting an action (edges inside a cycle are ignored; findCallCycles names
 * those). The search stops once the chain is `cap` calls long, so the answer is
 * exact up to the limit and "too deep" past it.
 */
export function longestCallChain(actions: unknown, fromId: string, cap = LIMITS.MAX_CALL_DEPTH + 1): string[] {
    const graph = callGraph(actions);
    if (!graph.has(fromId)) return [fromId];
    let best: string[] = [fromId];
    const path = [fromId];
    const onPath = new Set(path);
    const dfs = (id: string): boolean => {
        if (path.length > best.length) best = [...path];
        if (path.length - 1 >= cap) return true;
        for (const next of graph.get(id) ?? []) {
            if (onPath.has(next)) continue;
            path.push(next);
            onPath.add(next);
            const done = dfs(next);
            path.pop();
            onPath.delete(next);
            if (done) return true;
        }
        return false;
    };
    dfs(fromId);
    return best;
}

/**
 * True when a step of `steps` (at any nesting) satisfies `pred`, following
 * call_action into the called actions (a seen-set, at most `depth` calls deep).
 */
export function someStepThroughCalls(steps: unknown, actions: unknown, pred: (step: Obj) => boolean, depth = LIMITS.MAX_CALL_DEPTH): boolean {
    const seen = new Set<string>();
    const scan = (list: unknown, left: number): boolean => {
        let hit = false;
        visitSteps(Array.isArray(list) ? list : [], 'steps', 1, (step) => {
            if (hit) return;
            if (pred(step)) { hit = true; return; }
            if (step.kind !== 'call_action' || left <= 0 || typeof step.actionId !== 'string' || seen.has(step.actionId)) return;
            const callee = ownAction(actions, step.actionId);
            if (!callee) return;
            seen.add(step.actionId);
            if (scan(topOf(callee).list, left - 1)) hit = true;
        });
        return hit;
    };
    return scan(steps, depth);
}

const PARAM_READ_RE = /\bparams\s*\.\s*([A-Za-z_]\w*)/g;

/** The `params.<name>` names an action's formulas and templates read (a text scan of the action). */
export function paramNamesRead(action: unknown): Set<string> {
    const out = new Set<string>();
    if (!isObject(action)) return out;
    let text = '';
    try { text = JSON.stringify(action); } catch { return out; }
    for (const m of text.matchAll(PARAM_READ_RE)) out.add(m[1]);
    return out;
}
