/**
 * Steps held inside other steps — a loop's `body` and a parallel step's
 * `branches` — addressed by the path of ids down to them. Those lists carry no
 * edges (the engine chains them in order: automationRunner/engine.js
 * buildLinearEdges), so editing them is list surgery, not graph surgery.
 *
 * The separator is the web's INLINE_SEP (flow/inlineFlowlets.js), the same
 * `<container>/<child>` an expanded loop's children wear on the canvas.
 */

import type { AnyNode, DefinitionInput, FlowDefinition, FlowStep } from '..';

export const ADDRESS_SEP = '/';

export function childAddress(container: string | null, id: string): string {
    return container ? `${container}${ADDRESS_SEP}${id}` : id;
}

export function splitAddress(address: string): string[] {
    return String(address || '').split(ADDRESS_SEP).filter(Boolean);
}

/** Held by another step? */
export function isNestedAddress(address: string): boolean {
    return splitAddress(address).length > 1;
}

/** The address's last id: the step itself. */
export function leafId(address: string): string {
    const parts = splitAddress(address);
    return parts[parts.length - 1] ?? '';
}

/** A loop's body as steps (anything that is not a step object is skipped). */
export function bodyOf(step: FlowStep | null | undefined): FlowStep[] {
    return (Array.isArray(step?.body) ? step.body : []).filter(
        (s): s is FlowStep => !!s && typeof s === 'object' && typeof (s as FlowStep).id === 'string',
    );
}

/** A parallel step's branches, each as steps; never null. */
export function branchesOf(step: FlowStep | null | undefined): FlowStep[][] {
    return (Array.isArray(step?.branches) ? step.branches : []).map((b) =>
        (Array.isArray(b) ? b : []).filter((s): s is FlowStep => !!s && typeof s === 'object' && typeof s.id === 'string'),
    );
}

/** Does this step hold other steps? */
export function isContainer(step: FlowStep | null | undefined): boolean {
    return step?.type === 'loop' || step?.type === 'parallel';
}

/** The inline list a container holds: its body (`branch` null) or one branch. */
export function inlineList(step: FlowStep | null | undefined, branch: number | null): FlowStep[] {
    return branch === null ? bodyOf(step) : (branchesOf(step)[branch] ?? []);
}

function childOf(step: FlowStep, id: string): FlowStep | null {
    return [...bodyOf(step), ...branchesOf(step).flat()].find((s) => s.id === id) ?? null;
}

/** The step at an address, top level or held. */
export function findAtAddress(def: FlowDefinition | null | undefined, address: string): FlowStep | null {
    const [top, ...rest] = splitAddress(address);
    let cur = (def?.steps || []).find((s) => s?.id === top) ?? null;
    for (const id of rest) {
        if (!cur) return null;
        cur = childOf(cur, id);
    }
    return cur;
}

/**
 * THE node lookup: the primary trigger, a secondary trigger or a step by its
 * id, or a held step by its address (`loop_1/ai_2`). Every surface that finds
 * a node from an id or an address — a card, the step editor, a finding, a
 * connection — asks this.
 */
export function findNode(def: DefinitionInput | null | undefined, idOrAddress: string | null | undefined): AnyNode | null {
    if (!def || !idOrAddress) return null;
    if (isNestedAddress(idOrAddress)) return findAtAddress(def as FlowDefinition, idOrAddress);
    if (def.trigger?.id === idOrAddress) return def.trigger;
    const secondary = (def.triggers || []).find((t) => t?.id === idOrAddress);
    if (secondary) return secondary;
    return (def.steps || []).find((s) => s?.id === idOrAddress) ?? null;
}

type StepFn = (step: FlowStep) => FlowStep;

function mapBody(step: FlowStep, head: string, rest: string[], fn: StepFn): FlowStep | null {
    if (!Array.isArray(step.body)) return null;
    const body = step.body as FlowStep[];
    const i = body.findIndex((s) => s?.id === head);
    if (i < 0) return null;
    const next = mapPath(body[i] as FlowStep, rest, fn);
    if (next === body[i]) return step;
    const copy = body.slice();
    copy[i] = next;
    return { ...step, body: copy };
}

function mapBranches(step: FlowStep, head: string, rest: string[], fn: StepFn): FlowStep | null {
    if (!Array.isArray(step.branches)) return null;
    for (let b = 0; b < step.branches.length; b += 1) {
        const branch = step.branches[b];
        const i = Array.isArray(branch) ? branch.findIndex((s) => s?.id === head) : -1;
        if (i < 0) continue;
        const next = mapPath((branch as FlowStep[])[i] as FlowStep, rest, fn);
        if (next === (branch as FlowStep[])[i]) return step;
        const branches = step.branches.slice();
        const copy = (branch as FlowStep[]).slice();
        copy[i] = next;
        branches[b] = copy;
        return { ...step, branches };
    }
    return null;
}

function mapPath(step: FlowStep, path: string[], fn: StepFn): FlowStep {
    const [head, ...rest] = path;
    if (head === undefined) return fn(step);
    return mapBody(step, head, rest, fn) ?? mapBranches(step, head, rest, fn) ?? step;
}

/**
 * The definition with the step at `address` replaced by `fn(step)`. The SAME
 * definition when the address resolves to nothing or `fn` changes nothing.
 */
export function updateAtAddress(def: FlowDefinition, address: string, fn: StepFn): FlowDefinition {
    const [top, ...rest] = splitAddress(address);
    const idx = def.steps.findIndex((s) => s?.id === top);
    if (idx < 0) return def;
    const current = def.steps[idx] as FlowStep;
    const next = mapPath(current, rest, fn);
    if (next === current) return def;
    const steps = def.steps.slice();
    steps[idx] = next;
    return { ...def, steps };
}

/** A container with one of its inline lists replaced. */
export function withInlineList(step: FlowStep, branch: number | null, list: FlowStep[]): FlowStep {
    if (branch === null) return { ...step, body: list };
    const branches = branchesOf(step).map((b) => b.slice());
    while (branches.length <= branch) branches.push([]);
    branches[branch] = list;
    return { ...step, branches };
}

/** Where a held step sits: its container, which list, and its index there. */
export interface InlineSpot {
    container: string;
    branch: number | null;
    index: number;
    length: number;
}

export function inlineSpot(def: FlowDefinition, address: string): InlineSpot | null {
    const parts = splitAddress(address);
    if (parts.length < 2) return null;
    const id = parts[parts.length - 1] as string;
    const container = parts.slice(0, -1).join(ADDRESS_SEP);
    const parent = findAtAddress(def, container);
    if (!parent) return null;
    const body = bodyOf(parent);
    const inBody = body.findIndex((s) => s.id === id);
    if (inBody >= 0 && Array.isArray(parent.body)) return { container, branch: null, index: inBody, length: body.length };
    const branches = branchesOf(parent);
    for (let b = 0; b < branches.length; b += 1) {
        const index = (branches[b] as FlowStep[]).findIndex((s) => s.id === id);
        if (index >= 0) return { container, branch: b, index, length: (branches[b] as FlowStep[]).length };
    }
    return null;
}

/** Every id anywhere in the graph, held steps included — for a fresh id that clashes with none. */
export function allIds(def: FlowDefinition): Set<string> {
    const ids = new Set<string>();
    const visit = (s: FlowStep) => {
        ids.add(s.id);
        for (const c of [...bodyOf(s), ...branchesOf(s).flat()]) visit(c);
    };
    if (def.trigger?.id) ids.add(def.trigger.id);
    for (const t of def.triggers || []) if (t?.id) ids.add(t.id);
    for (const s of def.steps) if (s?.id) visit(s);
    return ids;
}
