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
 * Only gates INSIDE the form count. A form on a screen the viewer cannot open is the action
 * gate's concern (routes/studioAppRunGate.js); reading it here would also strip the same names
 * from another component that runs the same action with a row.
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

/** One form: the actions wired on it or inside it, and its field names split by the role gate. */
type FormSeen = { runs: Set<string>; shown: Set<string>; gated: Set<string> };

function isObject(v: unknown): v is Obj {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fieldNameOf(node: Obj): string | null {
    const props = isObject(node.props) ? node.props : null;
    const name = props ? props.name : null;
    return typeof name === 'string' && name ? name : null;
}

/** Every form of the definition. A form starts its own count: the gates around it are not field gates. */
function readForms(def: unknown, allows: Allows): FormSeen[] {
    const forms: FormSeen[] = [];
    const walk = (nodes: unknown, visible: boolean, form: FormSeen | null): void => {
        for (const node of (Array.isArray(nodes) ? nodes : [])) {
            if (!isObject(node)) continue;
            let within = form;
            let nodeVisible = true;
            if (node.type === 'form') {
                within = { runs: new Set(), shown: new Set(), gated: new Set() };
                forms.push(within);
            } else if (within) {
                nodeVisible = visible && allows(node);
                const name = fieldNameOf(node);
                if (name) (nodeVisible ? within.shown : within.gated).add(name);
            }
            if (within) for (const ref of nodeActionRefs(node)) within.runs.add(ref.actionId);
            walk(node.children, nodeVisible, within);
        }
    };
    const screens = isObject(def) && Array.isArray(def.screens) ? def.screens : [];
    for (const screen of screens) {
        const sections = isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [];
        for (const section of sections) walk(isObject(section) ? section.children : null, true, null);
    }
    return forms;
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
    const forms = readForms(def, allows);
    // No gated field in any form: nothing to read further (every definition before this rule mattered).
    if (!forms.some((f) => f.gated.size > 0)) return out;
    const actions = isObject(def) ? def.actions : null;
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
