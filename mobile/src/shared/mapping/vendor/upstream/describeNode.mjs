/**
 * The dispatch: one upstream node → the describer for its `type`.
 *
 * A type missing from this table contributes NO group to the variable picker:
 * nothing downstream can bind to it, through any picker, drag or auto-map,
 * and nothing errors. That silence is why the table lives alone in one file.
 */
import { resolveEnv, groupLabel } from './env.mjs';
import { describeTrigger } from './triggers.mjs';
import { describeFormPage } from './formAnswers.mjs';
import { describeAiStep, describeDataExtraction } from './aiSteps.mjs';
import {
    describeIntegration, describeHttpRequest, describeCode, describeNotification,
    describeGuard, describeTokenize, describeUntokenize,
} from './actionSteps.mjs';
import { describeLoop, describeLoopItem, inferLoopItemSample, wrapGroupForEach } from './loops.mjs';
import {
    describeCondition, describeSwitch, describeWait, describeApproval, describeCallLayer,
} from './controlFlowSteps.mjs';
import {
    describeGenerateDocument, describeFillDocument, describeSlide, describePresentation,
} from './documentSteps.mjs';
import {
    describeSet, describeParseJson, describeDateTime, describeCollectionItems,
    describeDedupe, describeAggregate, describeSummarize,
} from './collectionSteps.mjs';
import { describeDatatable, describeKnowledgeWrite } from './dataSteps.mjs';
import { resolveElementSample } from './sampleFields.mjs';

/** Every step type with a describer, by the context it reads. */
const DESCRIBERS = {
    integration_action: (n, c) => describeIntegration(n, c.toolToOutput?.get?.(n.tool) || {}),
    ai_step: (n, c) => describeAiStep(n, c.catalog, c.env),
    data_extraction: (n, c) => describeDataExtraction(n, c.env),
    loop: (n, c) => describeLoop(n, c.toolToOutput, c.definition, c.sampleRoot, c.env, loopBodySample(n, c)),
    loop_item: (n, c) => describeLoopItem(n, c.definition, c.toolToOutput, c.sampleRoot, c.env),
    condition: (n, c) => describeCondition(n, c.env),
    // The privacy steps. Without these the picker offered NOTHING for them.
    guard: (n, c) => describeGuard(n, c.env),
    tokenize: (n, c) => describeTokenize(n, c.env),
    untokenize: (n, c) => describeUntokenize(n, c.env),
    code: (n, c) => describeCode(n, c.env),
    notification: (n, c) => describeNotification(n, c.env),
    http_request: (n, c) => describeHttpRequest(n, c.env),
    generate_document: (n, c) => describeGenerateDocument(n, c.env),
    fill_document: (n, c) => describeFillDocument(n, c.env),
    slide: (n, c) => describeSlide(n, c.env),
    presentation: (n, c) => describePresentation(n, c.env),
    call_layer: (n, c) => describeCallLayer(n, c.definition, c.env),
    set: (n, c) => describeSet(n, c.sampleRoot, c.env),
    parse_json: (n, c) => describeParseJson(n, c.sampleRoot, c.env),
    datetime: (n, c) => describeDateTime(n, c.sampleRoot, c.env),
    wait: (n, c) => describeWait(n, c.env),
    approval: (n, c) => describeApproval(n, c.env),
    form_page: (n, c) => describeFormPage(n, c.env),
    switch: (n, c) => describeSwitch(n, c.env),
    filter: (n, c) => describeCollectionItems(n, groupLabel(c.env, 'route', 'Condition'), c.sampleRoot),
    limit: (n, c) => describeCollectionItems(n, groupLabel(c.env, 'limit', 'Limit'), c.sampleRoot),
    dedupe: (n, c) => describeDedupe(n, c.sampleRoot, c.env),
    aggregate: (n, c) => describeAggregate(n, c.sampleRoot, c.env),
    summarize: (n, c) => describeSummarize(n, c.env),
    datatable: (n, c) => describeDatatable(n, c.catalog, c.env),
    knowledge_write: (n, c) => describeKnowledgeWrite(n, c.catalog, c.env),
};

/** The step types this table describes. */
export const DESCRIBED_TYPES = Object.freeze(Object.keys(DESCRIBERS));

/**
 * One node's group, from a context object:
 *   { definition, toolToOutput, triggerOutputs, sampleRoot, catalog, env }
 */
export function describeNodeIn(node, ctx) {
    if (!node) return null;
    const c = { ...ctx, env: resolveEnv(ctx?.env) };
    if (node.__isTrigger) return describeTrigger(node, c.triggerOutputs || {}, c.env);
    // A TERMINAL step has nothing downstream: nothing could bind to its
    // output, because nothing comes after it.
    if (c.env.isTerminalStepType(node.type)) return null;
    const describe = DESCRIBERS[node.type];
    return describe ? describe(node, c) : null;
}

/**
 * Translate one upstream node into the tree-display shape. The positional
 * signature the builder has always called.
 */
export function describeNode(node, definition, toolToOutput, triggerOutputs, sampleRoot = null, catalog = null, env = undefined) {
    return describeNodeIn(node, { definition, toolToOutput, triggerOutputs, sampleRoot, catalog, env });
}

/**
 * The groups of a loop body's steps, in order, each described against what
 * it can see at run time: the flow before the loop (`sampleRoot`), the
 * current item at `loop.<itemVar>`, and every earlier body step's output.
 * A body step that iterates (`step.forEach`) is dispatched through the same
 * per-item wrapper as a top-level one, so its group gets the same envelope.
 * Body steps are not recorded individually, so there is no real overlay.
 */
export function describeLoopBody(loopStep, ctx, upTo = Infinity) {
    return describeBodySteps(loopStep, ctx, upTo).map(d => d.group).filter(Boolean);
}

/** Each body step (up to `upTo`) beside its group, null for one with none. */
function describeBodySteps(loopStep, ctx, upTo) {
    const c = { ...ctx, env: resolveEnv(ctx?.env) };
    const itemVar = loopStep.itemVar || 'item';
    const batched = Math.max(1, Number(loopStep.batchSize) || 1) > 1;
    const base = c.sampleRoot && typeof c.sampleRoot === 'object' ? c.sampleRoot : {};
    const element = resolveElementSample(loopStep.overRef, c.sampleRoot)
        ?? inferLoopItemSample(loopStep.overRef, c.definition, c.toolToOutput, c.sampleRoot) ?? {};
    const root = {
        ...base,
        steps: { ...(base.steps || {}) },
        loop: { ...(base.loop || {}), [itemVar]: batched ? [element] : element },
    };
    const out = [];
    const body = Array.isArray(loopStep.body) ? loopStep.body.slice(0, upTo) : [];
    for (const s of body) {
        let g = describeNodeIn(s, { ...c, sampleRoot: root });
        if (g && s?.forEach?.overRef) g = wrapGroupForEach(g, s);
        if (g && s?.id) root.steps[s.id] = { output: g.sample ?? {} };
        out.push({ step: s, group: g });
    }
    return out;
}

/**
 * What one iteration's `output` holds: the runner's `lastOutput`
 * (runDag.js), the output of the last body step that is not a `wait` (a
 * Wait's `{ waitedSeconds }` is bookkeeping, never recorded as it) or a
 * `note` (never executed). Null when no such step exists, and undefined when
 * that step has no describer: its output is unknown, and the sample of an
 * EARLIER step would offer paths the run never fills.
 */
function loopBodySample(loopStep, ctx) {
    const steps = describeBodySteps(loopStep, ctx, Infinity);
    for (let i = steps.length - 1; i >= 0; i--) {
        const { step, group } = steps[i];
        if (!step || step.type === 'wait' || step.type === 'note') continue;
        return group ? group.sample : undefined;
    }
    return null;
}
