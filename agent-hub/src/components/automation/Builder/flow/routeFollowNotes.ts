/**
 * The words around "follow the route" (shared/expr/routeFollow.mjs): the
 * toast after a step was re-pointed at what a Condition keeps, the Condition
 * editor's list of next steps that still read the original list, and its
 * note when a whole-run Condition reads a list as a whole (BFSF-485,
 * shared/expr/wholeRun.mjs). The rewrites and the detection are the shared
 * modules'; this only names things.
 */
import { getList, parsePath } from '@shared/expr/path.mjs';
import { followRouteAround, isListRoute, staleSuccessors } from '@shared/expr/routeFollow.mjs';
import { isWholeRunRoute, loopsAfterWholeRun, wholeRunListReads } from '@shared/expr/wholeRun.mjs';
import { listPathLabel } from '../mapping/listPathLabel';
import { nodeDefaultLabel as nodeDefaultLabelJs } from './nodeDefs';
import { buildStepLabelMap } from './runStepLabels';
import type { FlowDefinition, FlowStep } from './types';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** Which steps are Conditions, so a path into what one keeps reads as its name (listPathLabel). */
function stepTypesOf(definition: FlowDefinition | null | undefined): Map<string, string> {
    const types = new Map<string, string>();
    for (const s of definition?.steps || []) if (s?.id && s.type) types.set(s.id, s.type);
    return types;
}

/** One rewrite the shared module made: in `stepId`, `from…` now reads `to…`. */
export interface Rebound {
    stepId: string;
    from: string;
    to: string;
}

/** A next step that still reads the Condition's source list (RouteFields' `routeFollow.stale`). */
export interface StaleSuccessor {
    stepId: string;
    stepLabel: string;
    readsLabel: string;
}

const nodeDefaultLabel = nodeDefaultLabelJs as (type: unknown) => string | undefined;

/** A step's name as the canvas card shows it: its label, else its kind's default name. */
function stepName(definition: FlowDefinition | null | undefined, id: string): string {
    const step = (definition?.steps || []).find((s: FlowStep) => s?.id === id);
    return step?.label || (step?.type ? nodeDefaultLabel(step.type) : '') || id;
}

/** The Condition a rewritten path now reads from: the step after `steps`. */
function routeIdOf(path: string): string | null {
    const tokens = parsePath(path) as Array<{ key?: unknown }> | null;
    const id = tokens?.[0]?.key === 'steps' ? tokens[1]?.key : null;
    return typeof id === 'string' ? id : null;
}

/**
 * One sentence per re-pointed step: "“Read attachment” now works through what
 * “Condition” keeps." A step rewritten in several places is named once.
 */
export function followedMessages(rebound: Rebound[] | null | undefined, definition: FlowDefinition | null | undefined, t: Translate): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rebound || []) {
        const routeId = routeIdOf(r.to);
        const key = `${r.stepId}|${routeId}`;
        if (!routeId || seen.has(key)) continue;
        seen.add(key);
        out.push(t('condition_node.followed_toast', '“{step}” now works through what “{condition}” keeps.', {
            step: stepName(definition, r.stepId),
            condition: stepName(definition, routeId),
        }));
    }
    return out;
}

/** The next steps of a list Condition that read its source list and none of its outputs. */
export function staleSuccessorsOf(definition: FlowDefinition | null | undefined, routeId: string | null | undefined, stepLabelById: Pick<Map<string, string>, 'get'> | null, t: Translate | null): StaleSuccessor[] {
    if (!definition || !routeId) return [];
    const stale = staleSuccessors(definition, routeId) as Array<{ stepId: string; reads: string }>;
    const stepTypeById = stepTypesOf(definition);
    return stale.map((s) => ({
        stepId: s.stepId,
        stepLabel: stepName(definition, s.stepId),
        // The plain list label ("Read many ▸ Attachments"), as the canvas card names
        // it: the bracketed "(inside each row)" note does not belong inside a sentence.
        readsLabel: listPathLabel(s.reads, stepLabelById, t, { stepTypeById, compact: true }),
    }));
}

/** A list Condition's next steps that still read its source list, and the fix (RouteFields' `routeFollow`). */
export interface RouteFollow {
    stale: StaleSuccessor[];
    follow: (stepIds: string[]) => void;
}

/** RouteFields' `wholeRun`: the lists a whole-run Condition reads as a whole, and the loops after it. */
export interface WholeRunNotice {
    /** `convertible`: some rule reads an item of it (`[*]`), so "Check each item instead" can work through it. */
    lists: Array<{ path: string; label: string; convertible: boolean }>;
    loops: Array<{ stepId: string; stepLabel: string }>;
}

/**
 * `routeFollow` for the step editor: null unless the step is a Condition
 * working through a list and the shell can re-point steps (`onFollowRoute`).
 */
export function routeFollowOf(
    step: FlowStep | null | undefined,
    definition: FlowDefinition | null | undefined,
    onFollowRoute: ((routeId: string, stepIds: string[]) => void) | null | undefined,
    t: Translate | null,
): RouteFollow | null {
    if (!step || !onFollowRoute || !isListRoute(step)) return null;
    const stale = staleSuccessorsOf(definition, step.id, buildStepLabelMap(definition), t);
    return { stale, follow: (stepIds: string[]) => onFollowRoute(step.id, stepIds) };
}

/** Is `path` in the sample a list of plain values (`["urgent", "x"]`), not of records? */
function isPlainValueList(sampleRoot: unknown, path: string): boolean {
    const list = sampleRoot ? getList(sampleRoot, path) as unknown[] | null : null;
    return !!list?.length && list.every((v) => v === null || typeof v !== 'object');
}

/**
 * The reads worth a notice. A list of plain values read whole, without `[*]`
 * (`contains(trigger.output.labels, "urgent")`), is a membership question
 * about the run, not a filter the author forgot, so it is not one.
 */
function noticeReads(reads: Array<{ list: string; path: string }>, sampleRoot: unknown) {
    return reads.filter((r) => r.path !== r.list || !isPlainValueList(sampleRoot, r.path));
}

/**
 * `wholeRun` for the step editor: a Condition that decides once for the whole
 * run but reads a list (`contains(steps.sheets.output.results[*].name, …)`),
 * with the steps right after it that still run once per item of that list.
 * A path counts as a list when it has a `[*]`, or when the sample root reads
 * it as one the way the run would (`getList`). A list is `convertible` only
 * when a rule reads its items (`[*]`). Null when there is nothing to say.
 */
export function wholeRunNoticeOf(
    step: FlowStep | null | undefined,
    definition: FlowDefinition | null | undefined,
    sampleRoot: unknown,
    t: Translate | null,
): WholeRunNotice | null {
    if (!step || !isWholeRunRoute(step)) return null;
    const isList = sampleRoot ? (path: string) => getList(sampleRoot, path) !== null : undefined;
    const reads = noticeReads(wholeRunListReads(step, isList) as Array<{ list: string; path: string }>, sampleRoot);
    if (!reads.length) return null;
    const labels = buildStepLabelMap(definition);
    const stepTypeById = stepTypesOf(definition);
    const paths = [...new Set(reads.map((r) => r.list))];
    const lists = paths.map((path) => ({
        path,
        label: listPathLabel(path, labels, t, { stepTypeById }),
        convertible: reads.some((r) => r.list === path && r.path !== path),
    }));
    const graph = { ...(definition || {}), steps: [...(definition?.steps || []).filter((s) => s?.id !== step.id), step] };
    const loops = (loopsAfterWholeRun(graph, step.id, isList) as Array<{ stepId: string; reads: string }>)
        .filter((l) => paths.includes(l.reads))
        .map((l) => ({ stepId: l.stepId, stepLabel: stepName(definition, l.stepId) }));
    return { lists, loops };
}

/**
 * Follow the route after a step was added, inserted or wired next to a
 * Condition (W1/W2): the definition with the next step re-pointed at what the
 * Condition keeps, and one toast line per re-pointed step. One pure call, so
 * the canvas commits it together with the add (one Undo).
 */
export function followAfterAdd(
    definition: FlowDefinition,
    stepId: string,
    t: Translate,
): { definition: FlowDefinition; rebound: Rebound[]; messages: string[] } {
    const followed = followRouteAround(definition, stepId) as { definition: FlowDefinition; rebound: Rebound[] };
    return { ...followed, messages: followedMessages(followed.rebound, followed.definition, t) };
}
