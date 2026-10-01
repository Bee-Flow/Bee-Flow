/**
 * Upstream-variable discovery for the flow editor: the shared mapping core
 * (`@/shared/mapping`, the vendored server/shared/mapping/upstream), bound to
 * the phone's own modules, as agent-hub's Builder/mapping/upstream.ts binds
 * it on the web.
 *
 * The describers used to be ported here file by file and held to the web by
 * a differential test; they are one implementation now, so the phone offers
 * the same escaped paths, nested fields and list columns the web does. What
 * stays here is what only the phone knows, handed in as the core's `env`:
 * group names in the phone's language (`mobile.flow.group.*`, nodeDefs),
 * the Set step's operations, the Date & time list mode, the form-pick
 * registry and the terminal step types.
 *
 * The fields are SourceNodes: `{key, path, sample, children}` as before,
 * plus the Source, label parts, shape and preview.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';
import { ROUTE_STEP_NAME, SET_STEP_NAME } from '@/features/flow-editor/model/stepDisplayName';
import { isTerminalStepType } from '@/features/flow-editor/model/terminalSteps';
import {
    buildToolOutputMap,
    collectArrayPaths,
    collectUpstream as coreCollectUpstream,
    computeLoopBodyGroups as coreComputeLoopBodyGroups,
    computeUpstreamGroups as coreComputeUpstreamGroups,
    DESCRIBED_TYPES,
    describeNode as coreDescribeNode,
    describeTriggerMeta as coreDescribeTriggerMeta,
    elementFieldOptions,
    inferLoopItemSample as coreInferLoopItemSample,
    overlayGroupWithReal as coreOverlayGroupWithReal,
    resolveElementSample,
    resolveEnv,
    sampleToFields as coreSampleToFields,
    seg,
    suggestItemVar,
    triggerMetaSample,
} from '@/shared/mapping';

import { datetimeTargetColumn, isDateTimeListMode } from '../flowDeps/datetimeTarget';
import { pickSourceById } from '../flowDeps/pickSources';
import { applyOpsToSampleRow } from '../flowDeps/setOperations';
import type { Catalog, FlowDefinition, FlowNode, ToolOutputMap, TriggerOutputEntry, VariableField, VariableGroup } from '../types';

/** The phone's hooks into the core describers. */
export const PHONE_ENV = resolveEnv({
    label: (key, fallback, vars) => {
        if (key === 'set') return SET_STEP_NAME;
        if (key === 'route') return ROUTE_STEP_NAME;
        if (key === 'form_page') return t('routines.node.form_page.typeLabel', fallback);
        if (key.startsWith('node.')) return nodeDefaultLabel(key.slice(5), t) as string;
        return t(`mobile.flow.group.${key}`, fallback, vars as Record<string, string | number> | undefined);
    },
    isTerminalStepType: (type) => isTerminalStepType(type),
    pickSourceById: (id) => pickSourceById(id),
    applyOpsToSampleRow: (row, ops) => applyOpsToSampleRow(row, ops),
    datetimeTargetColumn: (step) => datetimeTargetColumn(step as Partial<FlowNode>),
    isDateTimeListMode: (step) => isDateTimeListMode(step as Partial<FlowNode>),
});

// The core's SourceNodes are the bindings layer's VariableFields with more
// on them; one cast here instead of one per caller.
const asGroups = (groups: unknown) => groups as VariableGroup[];

/** Where a loop body step sits: what is visible outside the loop, and the context. */
export interface LoopBodyScope {
    outerGroups?: VariableGroup[] | null;
    previewSample?: unknown;
    catalog?: Catalog | null;
    definition: FlowDefinition;
}

/** What describeNode reads besides the node. */
export interface DescribeContext {
    definition: FlowDefinition;
    toolToOutput: ToolOutputMap;
    triggerOutputs: Record<string, TriggerOutputEntry>;
    /** The accumulated sample root, so refs resolve through earlier nodes. */
    sampleRoot?: unknown;
    catalog?: Catalog | null;
}

export function collectUpstream(definition: FlowDefinition, currentStepId: string): FlowNode[] {
    return coreCollectUpstream(definition, currentStepId) as unknown as FlowNode[];
}

/** The variable groups visible to `currentStepId`, nearest last. */
export function computeUpstreamGroups(
    definition: FlowDefinition | null | undefined,
    currentStepId: string | null | undefined,
    catalog: Catalog | null | undefined,
    realOutputById: Map<string, unknown> | null = null,
): VariableGroup[] {
    return asGroups(coreComputeUpstreamGroups(definition, currentStepId, catalog, realOutputById, PHONE_ENV));
}

/** The groups ONE step inside a Loop's body sees. (The web takes the scope positionally.) */
export function computeLoopBodyGroups(loopStep: FlowNode, bodyIndex: number, scope: LoopBodyScope): VariableGroup[] {
    return asGroups(coreComputeLoopBodyGroups(
        loopStep, bodyIndex, scope.outerGroups as never, scope.previewSample, scope.catalog, scope.definition, PHONE_ENV,
    ));
}

/** One node's group. */
export function describeNode(node: FlowNode | null | undefined, ctx: DescribeContext): VariableGroup | null {
    return coreDescribeNode(
        node, ctx.definition, ctx.toolToOutput as never, ctx.triggerOutputs, ctx.sampleRoot ?? null, ctx.catalog ?? null, PHONE_ENV,
    ) as unknown as VariableGroup | null;
}

export function describeTriggerMeta(definition: FlowDefinition | null | undefined, catalog: Catalog | null | undefined): VariableGroup | null {
    return coreDescribeTriggerMeta(definition, catalog, PHONE_ENV) as unknown as VariableGroup | null;
}

export function sampleToFields(sample: unknown, basePath: string): VariableField[] {
    return coreSampleToFields(sample, basePath) as unknown as VariableField[];
}

export function overlayGroupWithReal(group: VariableGroup, realOutput: unknown): VariableGroup {
    return coreOverlayGroupWithReal(group as never, realOutput) as unknown as VariableGroup;
}

export function inferLoopItemSample(
    overRef: unknown, definition: FlowDefinition, toolToOutput: ToolOutputMap, sampleRoot: unknown = null,
): Record<string, unknown> | null {
    return coreInferLoopItemSample(overRef, definition, toolToOutput as never, sampleRoot);
}

export {
    buildToolOutputMap, collectArrayPaths, DESCRIBED_TYPES, elementFieldOptions, resolveElementSample, seg, suggestItemVar, triggerMetaSample,
};
