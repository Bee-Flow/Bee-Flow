/**
 * "Flatten a list": the step a route and a sample make. Shared by auto-map on
 * insert (bindings/autoMapStep.ts) and the editor (specs/flattenModel.ts), so
 * a dropped step and a re-picked level store the same plan. The plan itself is
 * the shared engine's `flattenPlan` (vendor/flatten.mjs), as on the server.
 */

import { childNounOf, flattenPlan, normalizeFlattenRoute, routeLevels, type RouteLevel } from '@/shared/expr';

import { humanizeFieldKey } from './displayHelpers';

export const FLATTEN_DEFAULT_LABEL = 'Flatten a list';
const ROW_PER = 'One row per ';

/** A data key in words, lower case ("attachments", "line items"). */
export const flattenNoun = (key: string): string => (key ? humanizeFieldKey(key).toLowerCase() : '');

/** A label nobody typed: the palette's, or one a level pick wrote. */
export function isFlattenDefaultLabel(label: unknown): boolean {
    return typeof label !== 'string' || !label || label === FLATTEN_DEFAULT_LABEL || label.startsWith(ROW_PER);
}

/** The inner lists of records one level down a source (F36, F45). */
export function flattenLevels(source: string, root: unknown): RouteLevel[] {
    if (!source) return [];
    return routeLevels(source, root).filter((l) => l.depth === 1 && l.records);
}

/**
 * The step's fields for `route`: the canonical route, a fresh plan
 * (`auto: true`) and, while the label is still a default, "One row per …".
 * Null when the route has no inner list.
 */
export function flattenRouteFields(
    step: { label?: unknown },
    route: string,
    root: unknown,
): { arrayRef: string; parents: ReturnType<typeof flattenPlan>['parents']; label: unknown } | null {
    const canonical = normalizeFlattenRoute(route);
    if (!canonical) return null;
    const label = isFlattenDefaultLabel(step.label) ? `${ROW_PER}${flattenNoun(childNounOf(canonical))}` : step.label;
    return { arrayRef: canonical, parents: flattenPlan(root, canonical).parents, label };
}
