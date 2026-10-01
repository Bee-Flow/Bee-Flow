/**
 * Upstream-variable discovery for the builder: the shared mapping core
 * (`@shared/mapping`, server/shared/mapping/upstream), bound once to the
 * builder's own modules.
 *
 * The describers used to live here as fifteen files; they moved to the core
 * so the builder, its auto-mapper and the phone describe a step the same way,
 * with one quoting rule for every path they offer. What stays in agent-hub is
 * what only the builder knows, handed in as the core's `env`:
 *
 *   - the Set step's column operations (flow/setOperations)
 *   - the Date & time step's list mode (flow/datetimeTarget)
 *   - the form-pick registry the server sends (flow/pickSourceCatalog)
 *   - the terminal step types (flow/terminalSteps)
 *   - the renamed step names (flow/stepDisplayName)
 *
 * Every export keeps the signature its importers have always called, and the
 * fields are SourceNodes: `{key, path, sample, children}` as before, plus the
 * Source, label parts, shape and preview the source panel reads.
 */
import {
    collectUpstream,
    computeUpstreamGroups as coreComputeUpstreamGroups,
    computeLoopBodyGroups as coreComputeLoopBodyGroups,
    computeRepeatItemGroup as coreComputeRepeatItemGroup,
    buildToolOutputMap,
    describeNode as coreDescribeNode,
    sampleToFields,
    resolveElementSample,
    elementFieldOptions,
    collectArrayPaths,
    overlayGroupWithReal,
    triggerMetaSample as coreTriggerMetaSample,
    describeTriggerMeta as coreDescribeTriggerMeta,
    inferLoopItemSample,
    suggestItemVar,
    resolveEnv,
    type SourceGroup,
    type ToolOutputMap,
    type UpstreamEnv,
} from '@shared/mapping/index.mjs';
import { datetimeTargetColumn, impliedListMode, isDateTimeListMode } from '../flow/datetimeTarget';
import { pickSourceById } from '../flow/pickSourceCatalog';
import { applyOpsToSampleRow } from '../flow/setOperations';
import { ROUTE_STEP_NAME, SET_STEP_NAME } from '../flow/stepDisplayName';
import { isTerminalStepType } from '../flow/terminalSteps';

const fill = (text: string, vars?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (m, k: string) => (vars && vars[k] !== undefined ? String(vars[k]) : m));

/** The builder's hooks into the core describers. */
export const BUILDER_ENV = resolveEnv({
    // Group names stay the English the builder has always shown; the two
    // renamed steps read their name from nodeDefs.
    label: (key, fallback, vars) => {
        if (key === 'set') return SET_STEP_NAME;
        if (key === 'route') return ROUTE_STEP_NAME;
        return fill(fallback, vars);
    },
    isTerminalStepType: (type) => isTerminalStepType(type),
    pickSourceById: (id) => pickSourceById(id),
    applyOpsToSampleRow: (row, ops) => applyOpsToSampleRow(row, ops),
    datetimeTargetColumn: (step) => datetimeTargetColumn(step),
    impliedListMode: (step) => impliedListMode(step),
    isDateTimeListMode: (step) => isDateTimeListMode(step),
} satisfies UpstreamEnv);

export function computeUpstreamGroups(
    definition: unknown,
    currentStepId: string | null | undefined,
    catalog: unknown,
    realOutputById: ReadonlyMap<string, unknown> | null = null,
): SourceGroup[] {
    return coreComputeUpstreamGroups(definition, currentStepId, catalog, realOutputById, BUILDER_ENV);
}

/**
 * The current item of a step that runs once per item (`step.repeat`), as
 * `take: 'each'` picks, for the source panel only (never a string picker).
 * `sampleRoot` is the drawer's preview root. Null when the step does not repeat.
 */
export function computeRepeatItemGroup(
    definition: unknown,
    currentStepId: string | null | undefined,
    catalog: unknown,
    sampleRoot: unknown = null,
): SourceGroup | null {
    return coreComputeRepeatItemGroup(definition, currentStepId, catalog, sampleRoot, BUILDER_ENV);
}

export function computeLoopBodyGroups(
    loopStep: unknown,
    bodyIndex: number,
    outerGroups: SourceGroup[] | null | undefined,
    previewSample: unknown,
    catalog: unknown,
    definition: unknown,
): SourceGroup[] {
    return coreComputeLoopBodyGroups(loopStep, bodyIndex, outerGroups, previewSample, catalog, definition, BUILDER_ENV);
}

export function describeNode(
    node: unknown,
    definition: unknown,
    toolToOutput: ToolOutputMap,
    triggerOutputs: Record<string, unknown>,
    sampleRoot: unknown = null,
    catalog: unknown = null,
): SourceGroup | null {
    return coreDescribeNode(node, definition, toolToOutput, triggerOutputs, sampleRoot, catalog, BUILDER_ENV);
}

export function triggerMetaSample(definition: unknown): Record<string, unknown> {
    return coreTriggerMetaSample(definition, BUILDER_ENV);
}

export function describeTriggerMeta(definition: unknown, catalog: unknown): SourceGroup | null {
    return coreDescribeTriggerMeta(definition, catalog, BUILDER_ENV);
}

export {
    collectUpstream,
    buildToolOutputMap,
    sampleToFields,
    resolveElementSample,
    elementFieldOptions,
    collectArrayPaths,
    overlayGroupWithReal,
    inferLoopItemSample,
    suggestItemVar,
};
export type { SourceGroup, ToolOutputMap };
