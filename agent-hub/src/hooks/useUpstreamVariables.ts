import { useMemo } from 'react';
import { computeUpstreamGroups } from '../components/automation/Builder/mapping/upstream';

/** One bindable field inside a group, and its children one level down. */
export interface UpstreamField {
    key: string;
    path: string;
    sample?: unknown;
    children?: UpstreamField[];
}

/** One upstream node's bindable output, as upstream/groups.js documents it. */
export interface UpstreamGroup {
    id: string;
    label: string;
    kind: string;
    basePath: string;
    sample?: unknown;
    fields: UpstreamField[];
    /**
     * This group's sample was overlaid with a real run or pinned output
     * (mapping/upstream/realOverlay.js). It is the EVIDENCE flag: a counted
     * claim about incoming data may only be made when it is set, because the
     * sample is otherwise the catalog's curated placeholder.
     */
    hasRealData?: boolean;
}

/** Real run/pinned outputs per step id, from mapping/realOutputs.js. */
export type RealOutputMap = ReadonlyMap<string, unknown>;

// groups.js is still JavaScript and annotates nothing, so TS reads the
// `realOutputById = null` default as that parameter's whole type and rejects
// the Map every caller passes. This states the contract its module header
// describes; it goes away when that module becomes TypeScript.
const computeGroups = computeUpstreamGroups as (
    definition: unknown,
    currentStepId: string | null | undefined,
    catalog: unknown,
    realOutputById?: RealOutputMap | null,
) => UpstreamGroup[];

/**
 * React wrapper around `computeUpstreamGroups` (the pure discovery logic
 * lives in Builder/mapping/upstream.js so the auto-mapper can reuse the
 * exact same candidate set the user sees in the VariableTree).
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
