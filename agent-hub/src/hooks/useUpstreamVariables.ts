import { useMemo } from 'react';
import type { CurrentItem } from '@shared/mapping/index.mjs';
import { computeUpstreamGroups } from '../components/automation/Builder/mapping/upstream';

/**
 * One bindable field inside a group, and its children: the parts of the
 * core's SourceNode (`@shared/mapping`) the builder's string-based editors
 * read. Group fields always carry a legacy path; only a value read from a
 * JSON string has none, and those are never in a group's field list.
 */
export interface UpstreamField {
    key: string;
    path: string;
    sample?: unknown;
    children?: UpstreamField[];
}

/** One upstream node's bindable output (core upstream/groups.mjs). */
export interface UpstreamGroup {
    id: string;
    label: string;
    kind: string;
    basePath: string;
    sample?: unknown;
    fields: UpstreamField[];
    /**
     * This group's sample was overlaid with a real run or pinned output
     * (core upstream/realOverlay.mjs). It is the EVIDENCE flag: a counted
     * claim about incoming data may only be made when it is set, because the
     * sample is otherwise the catalog's curated placeholder.
     */
    hasRealData?: boolean;
    /** The step's own current item (core CurrentItem): a forEach's `loop.<var>`, or a repeat's `each` picks. */
    currentItem?: CurrentItem;
}

/** Real run/pinned outputs per step id, from mapping/realOutputs.js. */
export type RealOutputMap = ReadonlyMap<string, unknown>;

// The core types a field's path as `string | null` (a value read from text has
// none); group fields always have one, which is the contract stated here.
const computeGroups = computeUpstreamGroups as unknown as (
    definition: unknown,
    currentStepId: string | null | undefined,
    catalog: unknown,
    realOutputById?: RealOutputMap | null,
) => UpstreamGroup[];

/**
 * React wrapper around `computeUpstreamGroups` (the pure discovery logic
 * lives in the shared mapping core, bound in Builder/mapping/upstream.ts, so
 * the auto-mapper can reuse the exact same candidate set the user sees in
 * the VariableTree).
 *
 * `realOutputById` (memoized by the caller) folds run/pinned outputs into the
 * groups so pickers show real values.
 *
 * Returns [] when definition / currentStepId is missing.
 */
export default function useUpstreamVariables(
    definition: unknown,
    currentStepId: string | null | undefined,
    catalog: unknown,
    realOutputById: RealOutputMap | null = null,
): UpstreamGroup[] {
    return useMemo(
        () => computeGroups(definition, currentStepId, catalog, realOutputById),
        [definition, currentStepId, catalog, realOutputById],
    );
}
