import type {
    ActionEffect, AppAction, AppDefinition, AppNode, AppScreen, AppSection, FormFieldRef,
} from './appDefinition';
import { nodeLabelWithType } from './nodeLabel';
import { INPUT_TYPES } from './styleKnobMeta';
import { NODE_EVENTS, findNode } from '../state/definitionOps';

/** What findNode reports: the node, and whatever is holding it. */
interface FoundNode {
    node: AppNode;
    /** The enclosing node, or the section when the node sits at its top level. */
    parent: AppNode | AppSection;
    screen: AppScreen;
    section: AppSection;
    index: number;
}

// definitionOps.js is still JavaScript and annotates nothing. This states what
// its own header describes; it goes away when that module becomes TypeScript.
const findNodeIn = findNode as (
    def: AppDefinition | null | undefined,
    nodeId: string,
) => FoundNode | null;

/** One step of a sequence action, as stepCount has to walk it. */
interface SequenceStep {
    then?: unknown;
    else?: unknown;
    steps?: unknown;
    default?: unknown;
    cases?: Array<{ steps?: unknown } | null>;
}

/** One event slot still pointing at an action. */
export interface EventRef {
    nodeId: string;
    event: string;
    node: AppNode;
}

/**
 * What a definition SAYS about an action: how big it is, which form it can
 * draw fields from, and who else points at it. Pure reads of the definition
 * tree — no React, no editing. The inspector's warnings ("shared with two
 * other components") and its test payload are both built out of these.
 */
/** How many steps a sequence holds, counting the ones inside branches. */
export function stepCount(action: AppAction | null | undefined): number {
    if (!action || action.kind !== 'sequence') return action ? 1 : 0;
    const walk = (steps: unknown): number => (Array.isArray(steps) ? steps as unknown[] : []).reduce<number>((n, raw) => {
        if (!raw || typeof raw !== 'object') return n;
        const step = raw as SequenceStep;
        let total = n + 1;
        total += walk(step.then) + walk(step.else) + walk(step.steps) + walk(step.default);
        for (const c of Array.isArray(step.cases) ? step.cases : []) total += walk(c?.steps);
        return total;
    }, 0);
    return walk(action.steps);
}

/**
 * The step a single action becomes when it is turned into a flow.
 *
 * Every v1 action kind IS a step kind, so this is a straight carry-over — which
 * is the point: "make this several steps" must never lose the one step already
 * there.
 */
export function stepFromAction(action: AppAction | null | undefined): Record<string, unknown> | null {
    if (!action || action.kind === 'sequence') return null;
    // Effects are an ACTION-level shape; no step kind carries them, and
    // canonicalize drops the keys on the next save. Carrying them onto the step
    // therefore looked like nothing happened and then quietly lost the toast
    // and the redirect the author had set up. They become real steps instead
    // (see effectSteps) — everything that CAN survive the conversion does.
    const { onSuccess: _s, onError: _e, ...step } = action;
    return step;
}

/**
 * An action's bounded `onSuccess` effects ({ toast?, navigateTo? }) as the
 * steps that do the same thing, in the order the runtime fired them.
 */
export function effectSteps(effects: ActionEffect | null | undefined): Array<Record<string, unknown>> {
    const steps: Array<Record<string, unknown>> = [];
    if (!effects || typeof effects !== 'object') return steps;
    if (effects.toast && typeof effects.toast === 'object' && effects.toast.message) {
        steps.push({ kind: 'toast', message: effects.toast.message, tone: effects.toast.tone || 'info' });
    }
    if (typeof effects.navigateTo === 'string' && effects.navigateTo) {
        steps.push({ kind: 'navigate', screenId: effects.navigateTo });
    }
    return steps;
}

/**
 * The form `node` sits in (or `node` itself when it IS one), else null.
 *
 * Split out of getFormFields because two different questions need the same
 * walk: which fields does this action have to offer, and — for "test with
 * what's on screen" — under which NAME did that form publish its live values.
 */
export function enclosingForm(
    definition: AppDefinition | null | undefined,
    node: AppNode | null | undefined,
): AppNode | null {
    if (node?.type === 'form') return node;
    // Walk up the parent chain until we hit a form (or a section).
    let current: AppNode | AppSection | null | undefined = node;
    while (current?.id) {
        const found = findNodeIn(definition, current.id);
        const parent = found?.parent;
        if (!parent || !parent.type) return null; // reached the section
        if (parent.type === 'form') return parent as AppNode;
        current = parent;
    }
    return null;
}

/**
 * The key the enclosing form publishes its live values under, or null.
 *
 * Keep in LOCKSTEP with AppForm's own `formName` (runtime/components/
 * AppForm.jsx: `node.props?.name || node.id`) and with AppRenderer's form-
 * container child scope. A different fallback here would read an empty object
 * from a form that is publishing perfectly well, and the test would silently
 * send nothing.
 */
export function formNameOf(
    definition: AppDefinition | null | undefined,
    node: AppNode | null | undefined,
): string | null {
    const form = enclosingForm(definition, node);
    if (!form) return null;
    return form.props?.name || form.id || null;
}

/**
 * Input fields of the form enclosing `node` (or of the form itself), with
 * their component type — typed input mapping (app_trigger automations) needs to
 * offer only file inputs for `file` params.
 */
export function getFormFields(
    definition: AppDefinition | null | undefined,
    node: AppNode | null | undefined,
): FormFieldRef[] {
    const form = enclosingForm(definition, node);
    if (!form) return [];
    const fields: FormFieldRef[] = [];
    const walk = (children: AppNode[] | undefined) => {
        for (const child of children || []) {
            if (child.type && INPUT_TYPES.includes(child.type) && child.props?.name) {
                fields.push({ name: child.props.name, type: child.type, multiple: !!child.props?.multiple });
            }
            if (Array.isArray(child.children)) walk(child.children);
        }
    };
    walk(form.children);
    return fields;
}

/** Input-field names of the form enclosing `node` (or of the form itself). */
export function getFormFieldNames(
    definition: AppDefinition | null | undefined,
    node: AppNode | null | undefined,
): string[] {
    return getFormFields(definition, node).map((f) => f.name);
}

/**
 * Every { nodeId, event, node } slot still pointing at `actionId`. definitionOps'
 * removeAction only clears onClick/onSubmit, so a grid/kanban/calendar slot
 * would keep a reference to a deleted action — and validate.js rejects that
 * on every later save.
 */
export function eventRefsToAction(
    definition: AppDefinition | null | undefined,
    actionId: string | null,
): EventRef[] {
    const refs: EventRef[] = [];
    const walk = (nodes: AppNode[] | undefined) => {
        for (const n of nodes || []) {
            for (const event of NODE_EVENTS) {
                if (n?.[event] === actionId) refs.push({ nodeId: n.id, event, node: n });
            }
            if (Array.isArray(n?.children)) walk(n.children);
        }
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return refs;
}

/**
 * The id of the screen a component lives on, or null.
 *
 * Derived rather than taken from the editor's OPEN screen: those are the same
 * thing today (the inspector edits the selection, the selection is on the open
 * screen), and a back-pointer built on "today" is exactly the kind that starts
 * naming the wrong screen the day multi-screen selection lands.
 */
export function screenIdOfNode(
    definition: AppDefinition | null | undefined,
    nodeId: string | null | undefined,
): string | null {
    if (!nodeId) return null;
    const walk = (children: AppNode[] | undefined): boolean => (children || []).some((n) => n?.id === nodeId || walk(n?.children));
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) {
            if (walk(section.children)) return screen.id || null;
        }
    }
    return null;
}

/** Names of the components OTHER than `nodeId` whose events run `actionId`. */
export function otherComponentsRunning(
    definition: AppDefinition | null | undefined,
    actionId: string | null,
    nodeId: string | null | undefined,
): string[] {
    const byId = new Map<string, string>();
    for (const ref of eventRefsToAction(definition, actionId)) {
        if (ref.nodeId === nodeId || byId.has(ref.nodeId)) continue;
        byId.set(ref.nodeId, nodeLabelWithType(ref.node));
    }
    return [...byId.values()];
}

/**
 * Names of the components that SHOW this action's result — an actionResult
 * binding anywhere in their props. Deleting the action leaves them rendering
 * with nothing behind them, which no event-slot scan would reveal.
 */
export function componentsShowingResult(
    definition: AppDefinition | null | undefined,
    actionId: string | null,
): string[] {
    const names: string[] = [];
    const hasRef = (value: unknown, depth = 0): boolean => {
        if (!value || typeof value !== 'object' || depth > 6) return false;
        const rec = value as Record<string, unknown>;
        if (!Array.isArray(value) && rec.kind === 'actionResult' && rec.actionId === actionId) return true;
        return Object.values(rec).some((v) => hasRef(v, depth + 1));
    };
    const walk = (nodes: AppNode[] | undefined) => {
        for (const n of nodes || []) {
            if (hasRef(n?.props)) names.push(nodeLabelWithType(n));
            if (Array.isArray(n?.children)) walk(n.children);
        }
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return names;
}

/** "a, b and c" — warnings name what breaks rather than counting it. */
export function joinNames(names: string[], max = 3): string {
    const shown = names.slice(0, max);
    const rest = names.length - shown.length;
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] || '';
    return rest > 0 ? `${list} and ${rest} more` : list;
}
