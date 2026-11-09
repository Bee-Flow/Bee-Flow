/**
 * Fresh ids for the steps NESTED in a duplicated container.
 *
 * `applyDuplicateNode` (flow/nodeOps.ts) clones a step wholesale and mints a
 * new id for the clone itself. A loop's `body[]` and a parallel's
 * `branches[]` hold whole steps of their own, so the copy used to carry the
 * original's nested ids: two steps with one id in the same automation. The
 * validator reports that as `loop.body_item_id_duplicate` (every nested step
 * writes `runState.steps[<id>]`, so a collision overwrites real data) and the
 * automation can no longer be activated.
 *
 * So the nested steps of the copy get ids of their own, and the bindings
 * between them (`steps.<old>.output…` inside the copied body) follow, so the
 * copy keeps reading ITS steps instead of the original's.
 *
 * Pure: the definition it is given is never mutated.
 */
import type { FlowDefinition, FlowStep } from './types';

type Branch = FlowStep[] | { steps?: FlowStep[];[key: string]: unknown };

const isStep = (v: unknown): v is FlowStep => !!v && typeof v === 'object' && !Array.isArray(v);

/** The steps nested directly in `step`: a loop's body, a parallel's branches. */
function nestedLists(step: FlowStep): FlowStep[][] {
    const lists: FlowStep[][] = [];
    if (Array.isArray(step.body)) lists.push(step.body as FlowStep[]);
    if (Array.isArray(step.branches)) {
        for (const branch of step.branches as Branch[]) {
            if (Array.isArray(branch)) lists.push(branch);
            else if (branch && Array.isArray(branch.steps)) lists.push(branch.steps);
        }
    }
    return lists;
}

function collectIds(steps: unknown, into: Set<string>): void {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isStep(s)) continue;
        if (s.id) into.add(s.id);
        for (const list of nestedLists(s)) collectIds(list, into);
    }
}

/** Same prefixes as the canvas's own step ids (applyAddNode / nodeOps). */
function mintId(type: string | undefined, taken: Set<string>): string {
    const prefix = type === 'integration_action' ? 'act'
        : type === 'ai_step' ? 'ai'
        : type === 'data_extraction' ? 'ex'
        : type === 'condition' ? 'cond'
        : type === 'loop' ? 'loop'
        : type === 'notification' ? 'notif'
        : type === 'code' ? 'code'
        : 'step';
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID().split('-')[0]
            // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- fallback flow-node id for when crypto.randomUUID is absent; an id in the flow graph, not a secret or a token
            : Math.random().toString(36).slice(2, 10);
        const id = `${prefix}_${rand}`;
        if (!taken.has(id)) return id;
    }
    return `${prefix}_${taken.size}_${Date.now().toString(36)}`;
}

/** `steps.<old>` → `steps.<new>` in every string of a value, at any depth. */
function repoint<T>(value: T, renamed: Map<string, string>): T;
function repoint(value: unknown, renamed: Map<string, string>): unknown {
    if (typeof value === 'string') {
        if (!value.includes('steps.')) return value;
        return value.replace(/\bsteps\.([A-Za-z0-9_]+)/g, (whole, id: string) => (renamed.has(id) ? `steps.${renamed.get(id)}` : whole));
    }
    if (Array.isArray(value)) return value.map(v => repoint(v, renamed));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = repoint(v, renamed);
        return out;
    }
    return value;
}

/** Re-id every step of a nested list (and what it nests in turn), noting old → new. */
function reidList(list: FlowStep[], taken: Set<string>, renamed: Map<string, string>): FlowStep[] {
    return list.map((child) => {
        if (!isStep(child) || !child.id) return child;
        const id = mintId(child.type, taken);
        taken.add(id);
        renamed.set(child.id, id);
        return reidContainer({ ...child, id }, taken, renamed);
    });
}

function reidContainer(step: FlowStep, taken: Set<string>, renamed: Map<string, string>): FlowStep {
    let next = step;
    if (Array.isArray(step.body)) next = { ...next, body: reidList(step.body as FlowStep[], taken, renamed) };
    if (Array.isArray(step.branches)) {
        next = {
            ...next,
            branches: (step.branches as Branch[]).map((branch) => {
                if (Array.isArray(branch)) return reidList(branch, taken, renamed);
                if (branch && Array.isArray(branch.steps)) return { ...branch, steps: reidList(branch.steps, taken, renamed) };
                return branch;
            }),
        };
    }
    return next;
}

/**
 * Give the steps nested in step `stepId` (a fresh duplicate) ids no other step
 * of `definition` carries. Returns the same object when the step nests nothing.
 */
export function withFreshNestedIds<D extends FlowDefinition>(definition: D, stepId: string): D {
    const steps = definition?.steps;
    if (!Array.isArray(steps)) return definition;
    const index = steps.findIndex(s => s?.id === stepId);
    if (index === -1) return definition;
    const step = steps[index];
    if (!nestedLists(step).some(list => list.some(child => isStep(child) && child.id))) return definition;

    const taken = new Set<string>();
    if (definition.trigger?.id) taken.add(definition.trigger.id);
    collectIds(definition.triggers, taken);
    collectIds(steps, taken);

    const renamed = new Map<string, string>();
    const reided = reidContainer(step, taken, renamed);
    // Only what the copy nests is re-pointed: its own fields (the list it
    // loops over) read steps OUTSIDE it, which kept their ids.
    const fresh: FlowStep = { ...reided };
    if (Array.isArray(fresh.body)) fresh.body = repoint(fresh.body, renamed);
    if (Array.isArray(fresh.branches)) fresh.branches = repoint(fresh.branches, renamed);

    const nextSteps = steps.slice();
    nextSteps[index] = fresh;
    return { ...definition, steps: nextSteps };
}
