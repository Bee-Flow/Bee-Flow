/**
 * What changes between two versions of a plan, step by step, as its owner reads it: a step that is new, one that is
 * gone, and one whose work changed. Layout is not a change (./planPermissions.mts leaves it out of the fingerprint
 * too), and a loop is not changed because a step inside it changed: that step is listed itself.
 *
 * Also the one question the cheaper-with-age offer asks of a proposed plan (core/cowork/cheaper/stableSteps.mts): did
 * exactly one step change, and is it now a fixed step?
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, StepKind, ToolLookups } from './planTypes.mts';
import { kindOfStepType } from './coworkStepList.mts';
import { LAYOUT_EDGE_KEYS, LAYOUT_NODE_KEYS } from './planPermissions.mts';
import { planViewOf } from './planView.mts';
import { stepsOf } from './planWalk.mts';

const nodeRequire = createRequire(import.meta.url);
const { stableStringify } = nodeRequire('../../../utils/stableJson.js') as {
    stableStringify: (value: unknown, opts?: { undefined?: 'null' | 'drop' | 'raw' }) => string;
};

export type Change = 'added' | 'changed' | 'removed';
export interface StepChange { id: string; title: string; kind: StepKind; change: Change }

const LEFT_OUT: ReadonlySet<string> = new Set([...LAYOUT_NODE_KEYS, 'body', 'branches']);

/** A step's own work, without its layout and its children, in a fixed key order. */
function workOf(step: DefStep): string {
    const own: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step)) if (!LEFT_OUT.has(k)) own[k] = v;
    return stableStringify(own, { undefined: 'drop' });
}

function byId(definition: Definition | null | undefined): Map<string, { work: string; parentId: string | null }> {
    return new Map(stepsOf(definition).map((w) => [w.id, { work: workOf(w.step), parentId: w.parentId }]));
}

/** The steps that are new, gone or changed in `next` against `base`, in the order the owner reads them. */
export function changesOf(base: Definition | null | undefined, next: Definition | null | undefined, lookups: ToolLookups): StepChange[] {
    const before = byId(base);
    const after = byId(next);
    const out: StepChange[] = [];
    for (const step of planViewOf(next, lookups).steps) {
        const was = before.get(step.id);
        const now = after.get(step.id);
        if (!was) out.push({ id: step.id, title: step.title, kind: step.kind, change: 'added' });
        else if (now && (was.work !== now.work || was.parentId !== now.parentId)) out.push({ id: step.id, title: step.title, kind: step.kind, change: 'changed' });
    }
    for (const step of planViewOf(base, lookups).steps) {
        if (!after.has(step.id)) out.push({ id: step.id, title: step.title, kind: step.kind, change: 'removed' });
    }
    return out;
}

const edgesOf = (definition: Definition | null | undefined): string => stableStringify(
    (Array.isArray(definition?.edges) ? definition.edges : []).map((e: unknown) => {
        if (!e || typeof e !== 'object') return e;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(e)) if (!LAYOUT_EDGE_KEYS.includes(k)) out[k] = v;
        return out;
    }),
    { undefined: 'drop' },
);

/** Exactly `stepId` changed between `base` and `next` (same wiring, nothing added or gone), and it is now a fixed step. */
export function onlyStepMadeFixed(base: Definition | null | undefined, next: Definition | null | undefined, stepId: string, lookups: ToolLookups): boolean {
    const changes = changesOf(base, next, lookups);
    if (changes.length !== 1 || changes[0]?.id !== stepId || changes[0].change !== 'changed') return false;
    if (edgesOf(base) !== edgesOf(next) || stableStringify(base?.trigger ?? null) !== stableStringify(next?.trigger ?? null)) return false;
    const made = stepsOf(next).find((w) => w.id === stepId);
    return !!made && kindOfStepType(made.type) === 'fixed';
}
