/**
 * App Studio validator — the browser steps that name a component on screen (componentSpecs/steps:
 * focus, scroll_to, set_ui, set_form_field). The node walk (nodes.js) notes every node's type and
 * every form's name on the context with noteUiTarget; the step checks below read that.
 *
 * A name that matches nothing is a WARNING: the runtime skips such a step without an error, and
 * a node may be added after the action. set_ui on a component that does not keep the named
 * state is an ERROR: it can never do anything. When the context has no node index (an action
 * validated on its own) nothing is checked.
 */

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type UiNode = { type: string; selectable: unknown };
type Ctx = {
    pushE: (f: Finding) => void;
    pushW: (f: Finding) => void;
    inputNamesByForm: Map<string, Set<string>>;
    uiNodes?: Map<string, UiNode>;
    uiForms?: Map<string, string>;
};
type Step = Record<string, unknown>;

/** The component type that keeps each set_ui state. */
export const UI_STATE_TYPES: Readonly<Record<string, string>> = Object.freeze({ activeTab: 'tabs', open: 'modal', selection: 'data_grid' });

/** Called by the node walk for every node: its type by id, and a form by its name (props.name, else its id). */
export function noteUiTarget(node: Record<string, unknown>, props: Record<string, unknown>, ctx: Ctx): void {
    if (typeof node.id !== 'string' || typeof node.type !== 'string') return;
    if (!ctx.uiNodes) ctx.uiNodes = new Map();
    ctx.uiNodes.set(node.id, { type: node.type, selectable: props.selectable });
    if (node.type !== 'form') return;
    if (!ctx.uiForms) ctx.uiForms = new Map();
    ctx.uiForms.set(typeof props.name === 'string' && props.name ? props.name : node.id, node.id);
}

/** The node a step names, or null; a warning when an index exists and the id is not in it. */
function namedNode(step: Step, path: string, ctx: Ctx): UiNode | null {
    const id = step.nodeId;
    if (typeof id !== 'string' || !id || !ctx.uiNodes) return null;
    const node = ctx.uiNodes.get(id);
    if (node) return node;
    ctx.pushW({
        code: 'action.step_node_unresolved', severity: 'warning', path: `${path}.nodeId`,
        message: `Step "${String(step.kind)}" names component ${JSON.stringify(id)}, which is not in this app.`,
        hint: 'Use the id of a component on one of the screens (app_find_nodes lists them).',
    });
    return null;
}

function checkNodeStep(step: Step, path: string, ctx: Ctx): void {
    if (step.kind === 'scroll_to' && step.nodeId === 'top') return;
    namedNode(step, path, ctx);
}

function checkSetUi(step: Step, path: string, ctx: Ctx): void {
    const node = namedNode(step, path, ctx);
    const state = typeof step.state === 'string' ? step.state : '';
    const want = Object.hasOwn(UI_STATE_TYPES, state) ? UI_STATE_TYPES[state] : null;
    if (!node || !want) return;
    if (node.type !== want) {
        ctx.pushE({
            code: 'action.set_ui_state_mismatch', severity: 'error', path: `${path}.state`,
            message: `set_ui state "${state}" belongs to a ${want} component; ${JSON.stringify(step.nodeId)} is a ${node.type}.`,
            hint: 'activeTab goes with tabs, open with modal, selection with data_grid.',
        });
    } else if (state === 'selection' && node.selectable !== 'single' && node.selectable !== 'multi') {
        ctx.pushW({
            code: 'action.set_ui_grid_not_selectable', severity: 'warning', path: `${path}.nodeId`,
            message: `Data grid ${JSON.stringify(step.nodeId)} has no row selection, so nothing can be selected in it.`,
            hint: 'Set its selectable prop to "single" or "multi".',
        });
    }
}

function checkSetFormField(step: Step, path: string, ctx: Ctx): void {
    const form = step.form;
    if (typeof form !== 'string' || !form || !ctx.uiForms) return;
    const formId = ctx.uiForms.get(form);
    if (!formId) {
        ctx.pushW({
            code: 'action.set_form_field_unknown_form', severity: 'warning', path: `${path}.form`,
            message: `Step "set_form_field" names form ${JSON.stringify(form)}, which is not in this app.`,
            hint: `Use a form's props.name (or its id when it has none). Forms: ${[...ctx.uiForms.keys()].slice(0, 20).join(', ') || '(none)'}.`,
        });
        return;
    }
    const names = ctx.inputNamesByForm.get(formId);
    if (typeof step.field === 'string' && step.field && !names?.has(step.field)) {
        ctx.pushW({
            code: 'action.set_form_field_unknown_field', severity: 'warning', path: `${path}.field`,
            message: `Form ${JSON.stringify(form)} has no input named ${JSON.stringify(step.field)}.`,
            hint: `Use an input's props.name. Inputs: ${names ? [...names].slice(0, 30).join(', ') : '(none)'}.`,
        });
    }
}

/** kind → check, joined into stepKindChecks.KIND_CHECKS. */
export const UI_STEP_CHECKS: Readonly<Record<string, (step: Step, path: string, ctx: Ctx) => void>> = Object.freeze({
    focus: checkNodeStep,
    scroll_to: checkNodeStep,
    set_ui: checkSetUi,
    set_form_field: checkSetFormField,
});
