/**
 * The dispatch: one upstream node → the describer for its `type`. A type
 * missing here contributes NO group — nothing downstream can bind to it,
 * through any picker or auto-map, and nothing errors. Port of agent-hub
 * `Builder/mapping/upstream/describeNode.js`.
 */

import { translate as t } from '@/core/i18n';
import { ROUTE_STEP_NAME } from '@/features/flow-editor/model/stepDisplayName';
import { isTerminalStepType } from '@/features/flow-editor/model/terminalSteps';

import type { Catalog, FlowDefinition, FlowNode, ToolOutputMap, TriggerOutputEntry, VariableGroup } from '../types';
import {
    describeCode, describeGuard, describeHttpRequest, describeIntegration, describeNotification,
    describeTokenize, describeUntokenize,
} from './actionSteps';
import { describeAiStep, describeDataExtraction } from './aiSteps';
import {
    describeAggregate, describeCollectionItems, describeDateTime, describeDedupe, describeParseJson, describeSet,
    describeSummarize,
} from './collectionSteps';
import { describeApproval, describeCallLayer, describeCondition, describeSwitch, describeWait } from './controlFlowSteps';
import { describeDatatable, describeKnowledgeWrite } from './dataSteps';
import { describeFillDocument, describeGenerateDocument, describePresentation, describeSlide } from './documentSteps';
import { describeFormPage } from './formAnswers';
import { describeLoop, describeLoopItem } from './loops';
import { describeTrigger } from './triggers';

export interface DescribeContext {
    definition: FlowDefinition;
    toolToOutput: ToolOutputMap;
    triggerOutputs: Record<string, TriggerOutputEntry>;
    /** The accumulated sample root, so refs resolve through earlier nodes. */
    sampleRoot?: unknown;
    catalog?: Catalog | null;
}

type Describer = (node: FlowNode, ctx: DescribeContext) => VariableGroup | null;

/** Every step type that offers variables, in the web chain's order. */
const DESCRIBERS: Record<string, Describer> = {
    integration_action: (n, c) => describeIntegration(n, c.toolToOutput.get(n.tool as string) || {}),
    ai_step: (n) => describeAiStep(n),
    data_extraction: (n) => describeDataExtraction(n),
    loop: (n, c) => describeLoop(n, c.toolToOutput, c.definition, c.sampleRoot ?? null),
    loop_item: (n, c) => describeLoopItem(n, c.definition, c.toolToOutput, c.sampleRoot ?? null),
    condition: (n) => describeCondition(n),
    guard: (n) => describeGuard(n),
    tokenize: (n) => describeTokenize(n),
    untokenize: (n) => describeUntokenize(n),
    code: (n) => describeCode(n),
    notification: (n) => describeNotification(n),
    http_request: (n) => describeHttpRequest(n),
    generate_document: (n) => describeGenerateDocument(n),
    fill_document: (n) => describeFillDocument(n),
    slide: (n) => describeSlide(n),
    presentation: (n) => describePresentation(n),
    call_layer: (n, c) => describeCallLayer(n, c.definition),
    set: (n, c) => describeSet(n, c.sampleRoot),
    parse_json: (n, c) => describeParseJson(n, c.sampleRoot),
    datetime: (n, c) => describeDateTime(n, c.sampleRoot),
    wait: (n) => describeWait(n),
    approval: (n) => describeApproval(n),
    form_page: (n) => describeFormPage(n),
    switch: (n) => describeSwitch(n),
    filter: (n, c) => describeCollectionItems(n, ROUTE_STEP_NAME, c.sampleRoot),
    limit: (n, c) => describeCollectionItems(n, t('mobile.flow.group.limit', 'Limit'), c.sampleRoot),
    dedupe: (n, c) => describeDedupe(n, c.sampleRoot),
    aggregate: (n, c) => describeAggregate(n, c.sampleRoot),
    summarize: (n) => describeSummarize(n),
    datatable: (n, c) => describeDatatable(n, c.catalog),
    knowledge_write: (n, c) => describeKnowledgeWrite(n, c.catalog),
};

/** The step types a describer exists for (the lockstep test holds this to the web chain). */
export const DESCRIBED_TYPES: readonly string[] = Object.keys(DESCRIBERS);

/**
 * One upstream node in the tree-display shape; null when it offers nothing.
 * (The web passes the context positionally: definition, toolToOutput,
 * triggerOutputs, sampleRoot, catalog.)
 */
export function describeNode(node: FlowNode | null | undefined, ctx: DescribeContext): VariableGroup | null {
    if (!node) return null;
    if (node.__isTrigger) return describeTrigger(node, ctx.triggerOutputs);
    // A TERMINAL step has nothing downstream to bind its output.
    if (isTerminalStepType(node.type)) return null;
    const type = String(node.type);
    const describe = Object.prototype.hasOwnProperty.call(DESCRIBERS, type) ? DESCRIBERS[type] : undefined;
    return describe ? describe(node, ctx) : null;
}
