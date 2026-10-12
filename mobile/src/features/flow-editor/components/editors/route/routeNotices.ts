/**
 * What the Condition editor's notices say, pure — the web's routeFollowNotes.ts
 * (staleSuccessorsOf, wholeRunNoticeOf). The detection is the shared modules'
 * (@/shared/expr routeFollow / wholeRun); this names the steps and lists.
 *   - W7: the next steps of a list Condition that still read the list it
 *     filters, so what it drops still reaches them;
 *   - F3/F4: a whole-run Condition that reads a list as a whole (it does not
 *     filter it), and the loops after it that still see every item.
 */

import type { TranslateFn } from '@/core/i18n';
import { listPathLabel } from '@/features/flow-editor/bindings/listPathLabel';
import { buildStepLabelMap, buildStepTypeMap, writeRoute, type FlowDefinition, type Route } from '@/features/flow-editor/model';
import { getList, isListRoute, isWholeRunRoute, loopsAfterWholeRun, staleSuccessors, wholeRunListReads } from '@/shared/expr';

/** listPathLabel's own translate type: the app's `t` with looser params. */
type ListLabelT = Parameters<typeof listPathLabel>[2];

export interface StaleStep {
    stepId: string;
    stepLabel: string;
    /** The list it still reads, named: "Read many ▸ Messages". */
    readsLabel: string;
}

export interface WholeRunReads {
    /** `convertible`: a rule reads the list's items (`[*]`), so "Check each item instead" can move it onto `item`. */
    lists: { path: string; label: string; convertible: boolean }[];
    loops: { stepId: string; stepLabel: string }[];
}

type StepLike = { id: string; type?: string; [key: string]: unknown };

/** The next steps of the saved list Condition `routeId` that read its list and none of its outputs. */
export function staleSteps(definition: FlowDefinition | null | undefined, routeId: string, t: TranslateFn): StaleStep[] {
    if (!definition) return [];
    const route = (definition.steps || []).find((s) => s?.id === routeId);
    if (!route || !isListRoute(route)) return [];
    const labels = buildStepLabelMap(definition);
    const stepTypeById = buildStepTypeMap(definition);
    return staleSuccessors(definition, routeId).map((s) => ({
        stepId: s.stepId,
        stepLabel: labels.get(s.stepId) || s.stepId,
        // The plain list label, as the canvas card names it: "(inside each row)" does not belong inside a sentence.
        readsLabel: listPathLabel(s.reads, labels, t as ListLabelT, { stepTypeById, compact: true }),
    }));
}

/**
 * The lists the route on screen (`route`, not yet saved) reads as a whole,
 * and the steps right after it that still loop over one of them. A path
 * counts as a list when it has a `[*]`, or when the sample reads it as one
 * the way the run would (a list of plain values read whole does not count).
 * Null when there is nothing to say.
 */
export function wholeRunReads(
    { step, route, definition, sampleRoot }: { step: StepLike; route: Route; definition: FlowDefinition | null | undefined; sampleRoot: unknown },
    t: TranslateFn,
): WholeRunReads | null {
    if (route.mode !== 'branch' || route.style === 'value') return null;
    const onScreen: StepLike = { ...step, ...writeRoute(route), id: step.id };
    if (!isWholeRunRoute(onScreen)) return null;
    // The list itself, not a yes/no: the shared module then skips a list of
    // plain values read whole (`contains(trigger.output.labels, "urgent")`), a
    // membership question about the run rather than a filter the author forgot.
    const isList = sampleRoot == null ? undefined : (path: string) => getList(sampleRoot, path);
    const reads = wholeRunListReads(onScreen, isList);
    if (!reads.length) return null;
    const labels = buildStepLabelMap(definition ?? null);
    const stepTypeById = buildStepTypeMap(definition ?? null);
    const paths = [...new Set(reads.map((r) => r.list))];
    const lists = paths.map((path) => ({
        path,
        label: listPathLabel(path, labels, t as ListLabelT, { stepTypeById }),
        convertible: reads.some((r) => r.list === path && r.path !== path),
    }));
    const others = (definition?.steps || []).filter((s) => s?.id !== step.id);
    const graph = { ...(definition || {}), steps: [...others, onScreen] };
    const loops = loopsAfterWholeRun(graph, step.id, isList)
        .filter((l) => paths.includes(l.reads))
        .map((l) => ({ stepId: l.stepId, stepLabel: labels.get(l.stepId) || l.stepId }));
    return { lists, loops };
}
