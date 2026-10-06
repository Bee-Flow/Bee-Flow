/**
 * The dispatch: one upstream node → the describer for its `type`.
 *
 * A type missing from this chain contributes NO group to the variable picker —
 * nothing downstream can bind to it, through any picker, drag or auto-map, and
 * nothing errors. That silence is why the chain lives alone in one file.
 */
import { isTerminalStepType } from '../../flow/terminalSteps';
import { ROUTE_STEP_NAME } from '../../flow/stepDisplayName';
import { describeTrigger } from './triggers';
import { describeFormPage } from './formAnswers';
import { describeAiStep, describeDataExtraction } from './aiSteps';
import {
    describeIntegration, describeHttpRequest, describeCode, describeNotification,
    describeGuard, describeTokenize, describeUntokenize,
} from './actionSteps';
import { describeLoop, describeLoopItem } from './loops';
import {
    describeCondition, describeSwitch, describeWait, describeApproval, describeCallLayer,
} from './controlFlowSteps';
import {
    describeGenerateDocument, describeFillDocument, describeSlide, describePresentation,
} from './documentSteps';
import {
    describeSet, describeParseJson, describeDateTime, describeCollectionItems,
    describeDedupe, describeAggregate, describeSummarize,
} from './collectionSteps';
import { describeDatatable, describeKnowledgeWrite } from './dataSteps';

/**
 * Translate one upstream node into the tree-display shape.
 */
export function describeNode(node, definition, toolToOutput, triggerOutputs, sampleRoot = null, catalog = null) {
    if (!node) return null;
    if (node.__isTrigger) {
        return describeTrigger(node, triggerOutputs);
    }
    if (node.type === 'integration_action') {
        const meta = toolToOutput.get(node.tool) || {};
        return describeIntegration(node, meta);
    }
    if (node.type === 'ai_step') {
        return describeAiStep(node);
    }
    if (node.type === 'data_extraction') return describeDataExtraction(node);
    if (node.type === 'loop') {
        return describeLoop(node, toolToOutput, definition, sampleRoot);
    }
    if (node.type === 'loop_item') {
        return describeLoopItem(node, definition, toolToOutput, sampleRoot);
    }
    if (node.type === 'condition') {
        return describeCondition(node);
    }
    // The privacy steps. Without these the picker offered NOTHING for them, so
    // a "Show real values again" placed straight after "Hide personal data"
    // could not be pointed at the very value it exists to restore.
    if (node.type === 'guard')      return describeGuard(node);
    if (node.type === 'tokenize')   return describeTokenize(node);
    if (node.type === 'untokenize') return describeUntokenize(node);
    if (node.type === 'code') {
        return describeCode(node);
    }
    if (node.type === 'notification') {
        return describeNotification(node);
    }
    if (node.type === 'http_request') {
        return describeHttpRequest(node);
    }
    if (node.type === 'generate_document') {
        return describeGenerateDocument(node);
    }
    if (node.type === 'fill_document') {
        return describeFillDocument(node);
    }
    if (node.type === 'slide') {
        return describeSlide(node);
    }
    if (node.type === 'presentation') {
        return describePresentation(node);
    }
    if (node.type === 'call_layer') {
        return describeCallLayer(node, definition);
    }
    // n8n-style utility nodes
    if (node.type === 'set')        return describeSet(node, sampleRoot);
    if (node.type === 'parse_json') return describeParseJson(node, sampleRoot);
    if (node.type === 'datetime')   return describeDateTime(node, sampleRoot);
    if (node.type === 'wait')       return describeWait(node);
    if (node.type === 'approval')   return describeApproval(node);
    if (node.type === 'form_page')  return describeFormPage(node);
    // Een TERMINALE stap heeft geen benedenstrooms: er is niets dat aan zijn
    // uitvoer zou kunnen binden, want er komt niets na. Gedreven door de ene
    // gedeelde lijst (flow/terminalSteps.js), niet door een type-literal —
    // anders krijgt de volgende eindstap wél een kaart en géén variabelengroep.
    if (isTerminalStepType(node.type)) return null;
    if (node.type === 'switch')     return describeSwitch(node, sampleRoot);
    if (node.type === 'filter')     return describeCollectionItems(node, ROUTE_STEP_NAME, sampleRoot);
    if (node.type === 'limit')      return describeCollectionItems(node, 'Limit', sampleRoot);
    if (node.type === 'dedupe')     return describeDedupe(node, sampleRoot);
    if (node.type === 'aggregate')  return describeAggregate(node, sampleRoot);
    if (node.type === 'summarize')  return describeSummarize(node);
    // A type missing from this chain contributes NO group to the variable
    // picker — nothing downstream can bind to it, through any picker, drag or
    // auto-map, and nothing errors.
    if (node.type === 'datatable')  return describeDatatable(node, catalog);
    if (node.type === 'knowledge_write') return describeKnowledgeWrite(node, catalog);
    return null;
}
