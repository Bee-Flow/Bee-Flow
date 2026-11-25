/**
 * One reading of a plan's definition, shared by the modules that judge it (./outsideText.mts, ./planChecks.mts,
 * ./planView.mts, ./planPermissions.mts): its steps in the order a person reads them, and what each step refers to.
 *
 * The walk and the reference reader are the automation model's own (core/automationModel/automationGraph.js and
 * refPaths.js), so a plan is read the way the validator and the runner read it.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep } from './planTypes.mts';

const nodeRequire = createRequire(import.meta.url);

type Tokens = Array<{ type?: string; key?: unknown }>;
const { walkSteps } = nodeRequire('../../automationModel/automationGraph.js') as {
    walkSteps: (definition: unknown, fn: (step: DefStep, at: { parentId: string | null; layer: string | null }) => void) => void;
};
const { findRefPaths } = nodeRequire('../../automationModel/refPaths.js') as {
    findRefPaths: (text: string, roots?: Iterable<string>) => Tokens[];
};

export interface WalkedStep {
    step: DefStep;
    id: string;
    type: string;
    /** The enclosing loop, null at the top level. */
    parentId: string | null;
    depth: number;
}

/** Every step of the plan's own graph, parents before their children. A step without an id or type is left out. */
export function stepsOf(definition: Definition | null | undefined): WalkedStep[] {
    const out: WalkedStep[] = [];
    const depthOf = new Map<string, number>();
    walkSteps(definition, (step, at) => {
        // A plan has no layers (./planChecks.mts refuses them); a step inside one is not part of the plan's graph.
        if (at.layer !== null) return;
        const id = typeof step.id === 'string' ? step.id : '';
        const type = typeof step.type === 'string' ? step.type : '';
        if (!id || !type) return;
        const depth = at.parentId !== null ? (depthOf.get(at.parentId) ?? 0) + 1 : 0;
        depthOf.set(id, depth);
        out.push({ step, id, type, parentId: at.parentId, depth });
    });
    return out;
}

/** What a value refers to: the steps whose output it reads, the trigger's output, and the item of the enclosing loop. */
export interface Refs {
    steps: Set<string>;
    trigger: boolean;
    loop: boolean;
}

const ROOTS = ['steps', 'trigger', 'loop'];
/** The fields of a step that hold its children: read as steps of their own, never as this step's text. */
const CHILD_FIELDS: ReadonlySet<string> = new Set(['body', 'branches']);
const MAX_DEPTH = 12;

function addRefs(text: string, into: Refs): void {
    for (const tokens of findRefPaths(text, ROOTS)) {
        const root = tokens[0]?.key;
        if (root === 'trigger') into.trigger = true;
        else if (root === 'loop') into.loop = true;
        else if (root === 'steps' && typeof tokens[1]?.key === 'string') into.steps.add(tokens[1].key);
    }
}

function collect(value: unknown, into: Refs, depth: number): void {
    if (typeof value === 'string') { addRefs(value, into); return; }
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    for (const inner of Array.isArray(value) ? value : Object.values(value)) collect(inner, into, depth + 1);
}

/** Everything a value refers to, however deep it is nested. */
export function refsOfValue(value: unknown): Refs {
    const refs: Refs = { steps: new Set(), trigger: false, loop: false };
    collect(value, refs, 0);
    return refs;
}

/**
 * Everything a step refers to in its own fields. Its children are steps of their own: a LIST under `body` or
 * `branches` is skipped. The same name can hold text (a notification's `body` is its message), and text is read.
 */
export function refsOfStep(step: DefStep): Refs {
    const own: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) {
        if (CHILD_FIELDS.has(key) && Array.isArray(value)) continue;
        own[key] = value;
    }
    return refsOfValue(own);
}

/** A step's named inputs, or none. */
export function inputsOf(step: DefStep): Record<string, unknown> {
    const inputs = step.inputs;
    return inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? (inputs as Record<string, unknown>) : {};
}

/** The tool names an AI step is offered by name (its explicit allow-list), or none. */
export function aiToolsOf(step: DefStep): string[] {
    return Array.isArray(step.tools) ? step.tools.filter((t): t is string => typeof t === 'string' && t !== '') : [];
}
