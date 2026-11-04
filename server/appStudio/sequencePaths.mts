/**
 * Walker paths and ordinals of an action (the path grammar in sequenceWalk.mts's
 * header): every path a walk can report, with its kind and its flattenSteps
 * ordinal, called actions included. Pure: reads a definition, runs nothing.
 */

import { createRequire } from 'node:module';
import { childStepSlots } from '../shared/appDefinition/stepFlow.mjs';
import type { Obj, StepPath } from './sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as { LIMITS: { MAX_ACTION_DEPTH: number; MAX_CALL_DEPTH: number } };

const MAX_WALK_DEPTH = LIMITS.MAX_ACTION_DEPTH + 1;
const MAX_CALL_DEPTH = LIMITS.MAX_CALL_DEPTH;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export function topOf(action: unknown): { list: unknown[]; base: string } {
    if (!isObject(action)) return { list: [], base: 'steps' };
    if (action.kind === 'sequence') return { list: Array.isArray(action.steps) ? action.steps : [], base: 'steps' };
    return { list: [action], base: 'action' };
}

/** A called action's top list: always a sequence (a bare callee is its own step 0). */
export function calleeTop(action: unknown, base: string): { list: unknown[]; base: string } {
    if (!isObject(action)) return { list: [], base };
    return { list: action.kind === 'sequence' ? (Array.isArray(action.steps) ? action.steps : []) : [action], base };
}

/** flattenSteps positions by object identity (the browser's stepIndex). */
export function ordinalMap(action: unknown): Map<object, number> {
    const seq = nodeRequire('./actionSequence.js') as { normalizeSequence: (a: unknown) => unknown[]; flattenSteps: (s: unknown[]) => unknown[] };
    const map = new Map<object, number>();
    seq.flattenSteps(seq.normalizeSequence(action)).forEach((step, i) => { if (isObject(step)) map.set(step, i); });
    return map;
}

type PathWalk = {
    ordinals: Map<object, number>; out: StepPath[]; chain: string[]; ownerActionId?: string;
    resolveCallee?: (id: string) => Obj | null;
};

function collectCallee(pw: PathWalk, step: Obj, path: string): void {
    const id = typeof step.actionId === 'string' ? step.actionId : '';
    if (!pw.resolveCallee || !id || pw.chain.includes(id) || pw.chain.length > MAX_CALL_DEPTH) return;
    const callee = pw.resolveCallee(id);
    if (!isObject(callee)) return;
    const { list, base } = calleeTop(callee, `${path}.call.steps`);
    collectPaths({ ...pw, ordinals: ordinalMap(callee), chain: [...pw.chain, id], ownerActionId: id }, list, base, 1);
}

function collectPaths(pw: PathWalk, list: unknown[], base: string, depth: number): void {
    list.forEach((step, i) => {
        if (!isObject(step)) return;
        const path = `${base}[${i}]`;
        pw.out.push({
            path, kind: typeof step.kind === 'string' ? step.kind : '(invalid)', ordinal: pw.ordinals.get(step) ?? null,
            ...(pw.ownerActionId ? { ownerActionId: pw.ownerActionId } : {}),
        });
        if (step.kind === 'call_action') collectCallee(pw, step, path);
        if (depth >= MAX_WALK_DEPTH) return;
        for (const slot of childStepSlots(step)) {
            if (slot.walked) collectPaths(pw, slot.steps, `${path}${slot.suffix}`, depth + 1);
        }
    });
}

/**
 * Every walker path of `action` with its kind and its flattenSteps ordinal, in pre-order.
 * With `opts.resolveCallee` the steps of called actions are listed too (`….call.steps[i]`,
 * ordinals relative to the callee, `ownerActionId` set), as far as the walk would go
 * (no cycle, at most MAX_CALL_DEPTH calls). `opts.rootId` names the action itself, so a
 * call back into it is not followed.
 */
export function stepPaths(action: unknown, opts: { resolveCallee?: (id: string) => Obj | null; rootId?: string } = {}): StepPath[] {
    const out: StepPath[] = [];
    const { list, base } = topOf(action);
    collectPaths({ ordinals: ordinalMap(action), out, chain: opts.rootId ? [opts.rootId] : [''], resolveCallee: opts.resolveCallee }, list, base, 1);
    return out;
}
