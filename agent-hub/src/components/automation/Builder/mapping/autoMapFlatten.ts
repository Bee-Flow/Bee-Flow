/**
 * Auto-map for a freshly dropped "Flatten a list" (spec F45): nothing to map
 * in Simple mode. While its source is blank or the palette scaffold, it takes
 * the upstream lists nearest first (ranked like nearestArrayRef), keeps the
 * first one whose items each hold a list of records (`messages` →
 * `attachments`, via the shared routeLevels), and writes the route, the
 * column plan (flattenPlan, `auto: true`) and the label "One row per
 * attachment". When no list qualifies the step stays blank, and the editor
 * says why.
 */
import { parsePath } from '@shared/expr/path.mjs';
import { routeLevels } from '@shared/expr/nested.mjs';
import { flattenPlan, flattenSentenceParts } from '@shared/expr/flatten.mjs';
import { firstKeyIsDiagnostic } from './autoMapIteration';
import { groupListSources, isRecord, type ListSource, type UpstreamGroup } from './deepFields';
import { isDiagnosticOutputKey } from '../flow/stepPayload';

type Step = Record<string, unknown>;
type Tok = { type: string; key?: unknown };

/** The palette's own label for a new flatten: relabelled by auto-map. */
const DEFAULT_LABELS = new Set(['', 'Flatten a list']);

/** A route from a list of records (`depth 1`, `records`): what Simple mode offers (D11). */
export interface FlattenRoute { route: string; root: unknown }

/** The group's sample filed under its base path, so its list paths resolve against it. */
function sampleRootOf(group: UpstreamGroup): unknown {
    const tokens = (parsePath(group.basePath || '') || []) as Tok[];
    if (!tokens.length || group.sample === undefined) return null;
    let root: unknown = group.sample;
    for (let i = tokens.length - 1; i >= 0; i--) root = { [String(tokens[i].key)]: root };
    return root;
}

/** Plain lists before lists inside lists, records before scalars, shallow before deep. */
function rankSources(sources: ListSource[]): ListSource[] {
    const rank = (s: ListSource) => [s.chain.length, isRecord(s.element) ? 0 : 1, s.weight, s.depth];
    return sources
        .map((s, i) => ({ s, r: [...rank(s), i] }))
        .sort((a, b) => {
            for (let k = 0; k < a.r.length; k++) if (a.r[k] !== b.r[k]) return a.r[k] - b.r[k];
            return 0;
        })
        .map(x => x.s);
}

/** The first inner list of records under one of a group's lists, or null. */
function routeInGroup(group: UpstreamGroup): FlattenRoute | null {
    const root = sampleRootOf(group);
    if (!root) return null;
    const sources = groupListSources(group).filter(s => !firstKeyIsDiagnostic(group, s.path, isDiagnosticOutputKey));
    for (const source of rankSources(sources)) {
        const level = routeLevels(source.path, root).find(l => l.depth === 1 && l.records);
        if (level) return { route: level.path, root };
    }
    return null;
}

/** The nearest upstream route a flatten can make rows from (F45), or null. */
export function nearestFlattenRoute(groups: readonly UpstreamGroup[] | null | undefined): FlattenRoute | null {
    const list = groups || [];
    for (let gi = list.length - 1; gi >= 0; gi--) {
        if (list[gi].ownItem) continue;
        const found = routeInGroup(list[gi]);
        if (found) return found;
    }
    return null;
}

const isScaffold = (ref: unknown) => !ref || ref === 'trigger.output.items';

/** "One row per attachment": the label auto-map gives a step it maps. */
export function flattenLabel(route: string, labelFor?: (child: string) => string): string {
    const child = flattenSentenceParts({}, { arrayRef: route }).child;
    return labelFor ? labelFor(child) : `One row per ${child}`;
}

/**
 * Auto-map one flatten step against its upstream groups: the step with
 * `arrayRef`, `parents` and (while it is still the default) its label, and
 * the keys it set; the step unchanged with no keys when it already has a
 * source or nothing upstream qualifies.
 */
export function autoMapFlatten(
    step: Step,
    groups: readonly UpstreamGroup[] | null | undefined,
    labelFor?: (child: string) => string,
): { step: Step; mappedKeys: string[] } {
    if (!isScaffold(step.arrayRef)) return { step, mappedKeys: [] };
    const found = nearestFlattenRoute(groups);
    if (!found) return { step, mappedKeys: [] };
    const plan = flattenPlan(found.root, found.route);
    const parents = plan.parents.map(p => ({ ...p, auto: true }));
    const label = typeof step.label === 'string' ? step.label.trim() : '';
    const next: Step = { ...step, arrayRef: found.route, parents };
    if (DEFAULT_LABELS.has(label)) next.label = flattenLabel(found.route, labelFor);
    return { step: next, mappedKeys: ['arrayRef'] };
}
