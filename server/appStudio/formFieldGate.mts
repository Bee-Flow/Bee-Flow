/**
 * Submitted form values, checked against the form's role gates. Pure.
 *
 * A run or step request carries the values of the form that started it. The renderer leaves a
 * field out for a role that `visibleToRoles` (on the field, or on a container around it inside
 * the form) does not name, so such a viewer never submits a value for it. This module applies
 * the same rule to the request: a value whose field the viewer's role does not see is left out
 * before the bag reaches a step or an automation. Left out, not refused: the rest of the form
 * still runs.
 *
 * Which form: the request names the action, not the form. So every form that runs the action
 * (the form itself or a component inside it wires it, or wires an action that calls it through
 * call_action) is read, and a name is left out only when it is a gated field in one of them and
 * a visible field in none. Two variants of one field, one per role, therefore keep their value
 * for both roles.
 *
 * Only actions that forms alone start are read. When a component outside the forms also starts
 * the action (a grid, list or kanban sends a row; a field outside a form sends its own value;
 * also through call_action), that bag may hold a key with the name of a gated field, and the
 * request does not say which component sent it, so the values pass as they are.
 *
 * Only gates INSIDE the form count. A form on a screen the viewer cannot open is the action
 * gate's concern (routes/studioAppRunGate.js).
 *
 * `visibleWhen` and `enabledWhen` are not read. They are formulas over the page's scope (other
 * forms, screen parameters, loaded data, action results), which a request does not carry, and
 * the runtime submits the value of a field that was filled before its condition hid it, and of
 * a disabled field, by design. The server has nothing to evaluate them against, so those values
 * pass as they are.
 *
 * A definition without a gated field in a form that runs the action gives the bag back
 * untouched (the same object).
 */

import { closeOverCalls } from './actionCalls.mts';
import { nodeActionRefs } from './nodeActionRefs.mts';

type Obj = Record<string, unknown>;

/** May this viewer see the node (its `visibleToRoles`)? The caller binds the role. */
export type Allows = (node: unknown) => boolean;

/** One form: its name, the actions wired on it or inside it, and its field names split by the role gate. */
type FormSeen = { name: string | null; runs: Set<string>; shown: Set<string>; gated: Set<string> };

/** The forms, plus the actions a component that is not a form starts with a bag of its own. */
type Seen = { forms: FormSeen[]; others: Set<string> };

/** A button sends an empty bag (AppButton), so it never carries a field value of its own. */
const EMPTY_BAG_TYPES = new Set(['button']);

function isObject(v: unknown): v is Obj {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fieldNameOf(node: Obj): string | null {
    const props = isObject(node.props) ? node.props : null;
    const name = props ? props.name : null;
    return typeof name === 'string' && name ? name : null;
}

/** The name a form's values are published under (`forms.<name>`): props.name, else the node id, as AppForm does. */
function formNameOf(node: Obj): string | null {
    const name = fieldNameOf(node) ?? node.id;
    return typeof name === 'string' && name ? name : null;
}

/**
 * Where an action a node starts goes. To its form: the form's own events, the onChange of a named
 * field in it (useInputChange sends the form's values) and a button in it. Nowhere: a button
 * outside a form (an empty bag). To `others`: everything else (a grid, list or kanban sends a
 * row, a field outside a form sends its own value).
 */
function addRefs(node: Obj, within: FormSeen | null, seen: Seen): void {
    const emptyBag = EMPTY_BAG_TYPES.has(String(node.type));
    const field = fieldNameOf(node) !== null;
    for (const ref of nodeActionRefs(node)) {
        const formValues = node.type === 'form' || emptyBag || (field && ref.via === 'onChange');
        if (within && formValues) within.runs.add(ref.actionId);
        else if (!emptyBag) seen.others.add(ref.actionId);
    }
}

/** Every form of the definition. A form starts its own count: the gates around it are not field gates. */
function readForms(def: unknown, allows: Allows): Seen {
    const seen: Seen = { forms: [], others: new Set() };
    const walk = (nodes: unknown, visible: boolean, form: FormSeen | null): void => {
        for (const node of (Array.isArray(nodes) ? nodes : [])) {
            if (!isObject(node)) continue;
            let within = form;
            let nodeVisible = true;
            if (node.type === 'form') {
                within = { name: formNameOf(node), runs: new Set(), shown: new Set(), gated: new Set() };
                seen.forms.push(within);
            } else if (within) {
                nodeVisible = visible && allows(node);
                const name = fieldNameOf(node);
                if (name) (nodeVisible ? within.shown : within.gated).add(name);
            }
            addRefs(node, within, seen);
            walk(node.children, nodeVisible, within);
        }
    };
    const screens = isObject(def) && Array.isArray(def.screens) ? def.screens : [];
    for (const screen of screens) {
        const sections = isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [];
        for (const section of sections) walk(isObject(section) ? section.children : null, true, null);
    }
    return seen;
}

/** Does the form run `actionId`: wired there, or called (call_action, any depth) by an action wired there? */
function formRuns(form: FormSeen, actions: unknown, actionId: string): boolean {
    if (form.runs.has(actionId)) return true;
    return closeOverCalls(actions, form.runs).has(actionId);
}

/**
 * The field names whose values this viewer may not submit with `actionId`: gated in a form
 * that runs the action, visible in none of them.
 */
export function gatedFormFieldNames(def: unknown, actionId: string, allows: Allows): Set<string> {
    const out = new Set<string>();
    const { forms, others } = readForms(def, allows);
    // No gated field in any form: nothing to read further (every definition before this rule mattered).
    if (!forms.some((f) => f.gated.size > 0)) return out;
    const actions = isObject(def) ? def.actions : null;
    // A component outside the forms also starts the action with a bag of its own (a row, a
    // single value): its keys may share a name with a gated field, so the bag is left as it is.
    if (others.size > 0 && closeOverCalls(actions, others).has(actionId)) return out;
    const running = forms.filter((f) => formRuns(f, actions, actionId));
    for (const form of running) for (const name of form.gated) out.add(name);
    for (const form of running) for (const name of form.shown) out.delete(name);
    return out;
}

/**
 * `values` without the gated names. The same object when nothing is left out (and anything
 * that is not a plain object comes back as it is).
 */
export function withoutGatedFormFields<T>(values: T, def: unknown, actionId: string, allows: Allows): T {
    if (!isObject(values)) return values;
    const gated = gatedFormFieldNames(def, actionId, allows);
    if (gated.size === 0) return values;
    const keys = Object.keys(values);
    if (!keys.some((k) => gated.has(k))) return values;
    // fromEntries defines own properties, so a key such as "__proto__" stays the plain key it was.
    return Object.fromEntries(keys.filter((k) => !gated.has(k)).map((k) => [k, values[k]])) as T;
}

/** Per form name: the field names gated in a form of that name and visible in none of that name. */
function gatedFieldsByForm(def: unknown, allows: Allows): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const { forms } = readForms(def, allows);
    for (const form of forms) {
        if (form.name === null || form.gated.size === 0) continue;
        const names = out.get(form.name) ?? new Set<string>();
        for (const name of form.gated) names.add(name);
        out.set(form.name, names);
    }
    for (const form of forms) {
        const names = form.name === null ? undefined : out.get(form.name);
        if (names) for (const name of form.shown) names.delete(name);
    }
    return out;
}

/**
 * The values of the other forms a request carries (`forms.<form name>.<field>`, the wide server
 * scope) under the same rule as the submitted form: a field the viewer's role does not see in
 * the form of that name is left out. Each form is named here, so every form is read on its own;
 * a key that names no form of the definition passes as it is. The same object when nothing is
 * left out.
 */
export function withoutGatedFormsFields<T>(forms: T, def: unknown, allows: Allows): T {
    if (!isObject(forms)) return forms;
    const gatedByForm = gatedFieldsByForm(def, allows);
    if (gatedByForm.size === 0) return forms;
    let changed = false;
    // No prototype, as the bag came in (wideScope.mts): only own keys are values.
    const out: Obj = Object.create(null);
    for (const [formName, values] of Object.entries(forms)) {
        const gated = gatedByForm.get(formName);
        if (!gated || gated.size === 0 || !isObject(values) || !Object.keys(values).some((k) => gated.has(k))) {
            out[formName] = values;
            continue;
        }
        const kept: Obj = Object.create(null);
        for (const [k, v] of Object.entries(values)) if (!gated.has(k)) kept[k] = v;
        out[formName] = kept;
        changed = true;
    }
    return (changed ? out : forms) as T;
}
