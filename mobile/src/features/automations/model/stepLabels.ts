/**
 * What a step of a RUN is called: its label from the routine's definition,
 * never its id.
 *
 * A run step carries only an id (`act_4d4307a`, and `call_1/act_9f2c` for a
 * step inside a flowlet) and an engine type. The live card printed
 * "Step act_4d4307a", and the timeline fell back to `gmail_send`, `ai_step` —
 * tokens nobody named. The definition the run was made from knows the names.
 *
 * `friendlyStepName`, `buildNameMap` and `nameFor` are the web builder's
 * (DryRunPanel.jsx), ported and pinned there by flow-editor's
 * run.lockstep.test.ts; the flow editor's test-run sheet reads them from here,
 * because this feature may not import the flow editor. `runStepNames` and
 * `runStepTitle` are the Automations screens' reading of the same: loop bodies
 * and secondary triggers named too, and a step without a label called by its
 * kind in the web's words ("AI step", not "ai step").
 */

import { humanizeToolName } from '@/shared/lib/humanizeKey';

import { STEP_TYPE_NAMES } from './stepNames';

export type NameTranslate = (key: string, fallback: string) => string;

/** The fields of a node that name it. The trigger, a step and a flowlet's steps all fit. */
export interface NamedStep {
    id?: string;
    type?: string;
    label?: string | null;
    tool?: unknown;
    layerKey?: unknown;
}

/** The parts of a definition that hold nodes. */
export interface NamedDefinition {
    trigger?: NamedStep | null;
    triggers?: unknown;
    steps?: readonly NamedStep[] | null;
    layers?: unknown;
}

export type NamedDefinitionInput = NamedDefinition | null | undefined;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** The web's last resort: the type with its underscores as spaces. */
const typeWords = (type: string | undefined) => (type || 'step').replace(/_/g, ' ');

/** The web builder's own word for a type, else the web's last resort. */
function kindName(type: string | null | undefined): string {
    if (type && Object.prototype.hasOwnProperty.call(STEP_TYPE_NAMES, type)) return STEP_TYPE_NAMES[type] as string;
    return typeWords(type ?? undefined);
}

/** The title of the flowlet a call_layer step calls, when it has one. */
function flowletTitle(step: NamedStep, definition: NamedDefinitionInput): string {
    const layers = isObj(definition?.layers) ? definition.layers : null;
    const layer = typeof step.layerKey === 'string' ? layers?.[step.layerKey] : undefined;
    return isObj(layer) && typeof layer.title === 'string' ? layer.title : '';
}

type Kind = (type: string | undefined) => string;

function nameStep(step: NamedStep | null | undefined, definition: NamedDefinitionInput, t: NameTranslate, kind: Kind): string | null {
    if (!step) return null;
    if (step.type === 'trigger') return step.label || t('routines.node.trigger.defaultLabel', 'Trigger');
    if (step.type === 'call_layer') return step.label || flowletTitle(step, definition) || t('routines.node.call_layer.typeLabel', 'Flowlet');
    if (step.label && step.label.trim()) return step.label;
    if (step.type === 'integration_action' && step.tool) return humanizeToolName(step.tool);
    if (step.type === 'layer_output') return t('routines.node.layer_output.defaultLabel', 'Return');
    return kind(step.type);
}

/** A step's name for the dry-run sheet: its label, else a sensible word for its type. */
export function friendlyStepName(step: NamedStep | null | undefined, definition: NamedDefinitionInput, t: NameTranslate): string | null {
    return nameStep(step, definition, t, typeWords);
}

/** stepId → name, over the trigger, the steps and every flowlet's steps. */
export function buildNameMap(definition: NamedDefinitionInput, t: NameTranslate): Map<string, string> {
    const map = new Map<string, string>();
    if (!definition || typeof definition !== 'object') return map;
    const add = (step: NamedStep | null | undefined) => {
        const name = friendlyStepName(step, definition, t);
        if (step?.id && name !== null) map.set(step.id, name);
    };
    if (definition.trigger) add(definition.trigger);
    for (const s of definition.steps || []) add(s);
    const layers = isObj(definition.layers) ? definition.layers : {};
    for (const layer of Object.values(layers) as (NamedDefinition | null | undefined)[]) {
        if (layer?.trigger) add(layer.trigger);
        for (const s of layer?.steps || []) add(s);
    }
    return map;
}

/** A flowlet's inner row `<callId>/<innerId>` is found by its bare suffix. */
function known(stepId: string, names: ReadonlyMap<string, string>): string | undefined {
    const bare = stepId.includes('/') ? (stepId.split('/').pop() as string) : stepId;
    return names.get(stepId) || names.get(bare);
}

export function nameFor(stepId: string | null | undefined, names: ReadonlyMap<string, string>, t: NameTranslate): string {
    if (!stepId) return t('routines.builder.node_generic', 'Step');
    return known(stepId, names) || stepId;
}

/**
 * stepId → name for a run read on the Automations screens: every node the
 * definition holds, the steps inside a loop's body, a parallel step's
 * branches and the secondary triggers included.
 */
export function runStepNames(definition: NamedDefinitionInput, t: NameTranslate): Map<string, string> {
    const map = new Map<string, string>();
    if (!definition || typeof definition !== 'object') return map;
    const add = (node: unknown, type?: string) => {
        if (!isObj(node) || typeof node.id !== 'string' || map.has(node.id)) return;
        const step = (type && !node.type ? { ...node, type } : node) as NamedStep;
        const name = nameStep(step, definition, t, kindName);
        if (name) map.set(node.id, name);
    };
    const walk = (nodes: unknown) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            add(node);
            if (!isObj(node)) continue;
            walk(node.body);
            if (Array.isArray(node.branches)) node.branches.forEach(walk);
        }
    };
    add(definition.trigger, 'trigger');
    if (Array.isArray(definition.triggers)) definition.triggers.forEach((trigger) => add(trigger, 'trigger'));
    walk(definition.steps);
    for (const layer of Object.values(isObj(definition.layers) ? definition.layers : {})) {
        if (!isObj(layer)) continue;
        add(layer.trigger, 'trigger');
        walk(layer.steps);
    }
    return map;
}

/**
 * The title of one step of a run: its name from `runStepNames`, else what
 * kind of step it was. Never the id — the id is what nobody recognises.
 */
export function runStepTitle(
    step: { stepId?: string | null; stepType?: string | null },
    names: ReadonlyMap<string, string>,
    t: NameTranslate,
): string {
    const name = step.stepId ? known(step.stepId, names) : undefined;
    if (name) return name;
    return step.stepType ? kindName(step.stepType) : t('routines.builder.node_generic', 'Step');
}
