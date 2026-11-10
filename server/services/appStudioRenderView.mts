/**
 * App Studio screenshot: the VIEW a render is asked for, beyond the screen itself
 * (app_screenshot's chrome, state, appearance, hostTheme and nodeId).
 *
 * resolveRenderView() checks the request against the definition and turns it into what the
 * two sides of the render need, so they cannot disagree:
 *   - the data pass (appStudioRender.js buildRenderScope) keys its rows with the same vars,
 *     forms and screen params the page will see, or a filter on `vars.x` misses its entry;
 *   - the page (agent-hub appRuntimeHeadless.tsx, `screenshot` payload) gets the same
 *     values plus `initialUi`: the modal that starts open, the tab a group starts on, the
 *     values a form starts with (agent-hub runtime/initialUi.ts reads them).
 * Every id must be a node of the rendered screen and every variable a declared one, so a
 * typo is an answer the caller can act on, never a screenshot of something else.
 *
 * Nothing here runs an action: state is a starting picture, not a sequence of clicks.
 */

import { coerceVariableDefault, MAX_VARIABLE_DEFAULT_BYTES } from '../shared/appDefinition/variables.mjs';

export const APPEARANCES = Object.freeze(['light', 'dark', 'auto']);
/** Host themes as the SPA sets them on <html data-theme>; the page default (no attribute) is dark. */
export const HOST_THEMES = Object.freeze(['light', 'dark', 'high-contrast']);
/** Bounds of one request: what fits a picture, not a data import. */
export const VIEW_LIMITS = Object.freeze({ MAX_STATE_BYTES: 20000, MAX_PARAMS: 20, MAX_KEY_LEN: 64, MAX_STRING: 500, MAX_LIST: 50, MAX_TABS: 10 });

type Bag = Record<string, unknown>;
interface ViewNode { id?: unknown; type?: unknown; props?: Bag | null; children?: ViewNode[] }
interface ViewScreen { id?: unknown; sections?: Array<{ children?: ViewNode[] }> }
interface ViewDefinition { variables?: Array<{ name?: unknown; type?: unknown }> | null }

export interface RenderView {
    chrome: boolean;
    vars: Bag | null;
    forms: Bag | null;
    screenParams: Bag | null;
    initialUi: Bag | null;
    openModal: string | null;
    appearance: string | null;
    hostTheme: string | null;
    nodeId: string | null;
}

/** What is wrong with a request, as one plain sentence for the caller. */
class ViewError extends Error {}
function fail(message: string): never {
    throw new ViewError(message);
}
export interface ViewResult { ok: boolean; value?: RenderView; error?: string }

function isBag(v: unknown): v is Bag {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function jsonBytes(v: unknown): number {
    try { return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8'); } catch { return Infinity; }
}

/** Every node of the screen with its parent, depth first (modal and tab contents included). */
export function screenNodes(screen: ViewScreen | null | undefined): Map<string, { node: ViewNode; parent: ViewNode | null }> {
    const out = new Map<string, { node: ViewNode; parent: ViewNode | null }>();
    const visit = (nodes: unknown, parent: ViewNode | null, depth: number): void => {
        if (!Array.isArray(nodes) || depth > 64) return;
        for (const node of nodes as ViewNode[]) {
            if (!node || typeof node.id !== 'string') continue;
            if (!out.has(node.id)) out.set(node.id, { node, parent });
            visit(node.children, node, depth + 1);
        }
    };
    for (const section of screen?.sections || []) visit(section?.children, null, 0);
    return out;
}

/** A value a field or screen parameter can hold: a short primitive or a short list of them. */
function plainValue(v: unknown, allowList: boolean): boolean {
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= VIEW_LIMITS.MAX_STRING;
    if (allowList && Array.isArray(v)) return v.length <= VIEW_LIMITS.MAX_LIST && v.every((x) => plainValue(x, false));
    return false;
}

function plainBag(raw: unknown, what: string, allowList: boolean): Bag {
    if (!isBag(raw)) return fail(`${what} must be an object`);
    const entries = Object.entries(raw);
    if (entries.length > VIEW_LIMITS.MAX_PARAMS) return fail(`${what} holds at most ${VIEW_LIMITS.MAX_PARAMS} keys`);
    for (const [key, value] of entries) {
        if (!key || key.length > VIEW_LIMITS.MAX_KEY_LEN) return fail(`${what}: a key is 1 to ${VIEW_LIMITS.MAX_KEY_LEN} characters`);
        if (!plainValue(value, allowList)) return fail(`${what}.${key} must be a short text, number, true/false or null${allowList ? ' (or a short list of them)' : ''}`);
    }
    return { ...raw };
}

/** state.vars: declared variables only, each coerced to its declared type like a default is. */
function resolveVars(raw: unknown, definition: ViewDefinition): Bag | null {
    if (raw === undefined || raw === null) return null;
    if (!isBag(raw)) return fail('state.vars must be an object of variable name to value');
    const declared = new Map<string, string>();
    for (const v of definition.variables || []) if (v && typeof v.name === 'string') declared.set(v.name, String(v.type));
    const out: Bag = {};
    for (const [name, value] of Object.entries(raw)) {
        const type = declared.get(name);
        if (!type) return fail(`state.vars.${name} is not a declared variable (declared: ${[...declared.keys()].join(', ') || 'none'})`);
        if (jsonBytes(value) > MAX_VARIABLE_DEFAULT_BYTES) return fail(`state.vars.${name} is larger than ${MAX_VARIABLE_DEFAULT_BYTES} bytes`);
        out[name] = coerceVariableDefault(type, value).value;
    }
    return out;
}

/** state.forms: { <form name>: { field: value } } for forms on this screen. */
function resolveForms(raw: unknown, nodes: ReturnType<typeof screenNodes>): { forms: Bag; ui: Bag } | null {
    if (raw === undefined || raw === null) return null;
    if (!isBag(raw)) return fail('state.forms must be an object of form name to field values');
    const byName = new Map<string, string>();
    for (const [id, { node }] of nodes) {
        if (node.type !== 'form') continue;
        const name = typeof node.props?.name === 'string' && node.props.name ? node.props.name : id;
        byName.set(name, id);
    }
    const forms: Bag = {};
    const ui: Bag = {};
    for (const [name, values] of Object.entries(raw)) {
        const id = byName.get(name);
        if (!id) return fail(`state.forms.${name} is not a form on this screen (forms: ${[...byName.keys()].join(', ') || 'none'})`);
        const checked = plainBag(values, `state.forms.${name}`, true);
        forms[name] = checked;
        ui[id] = { values: checked };
    }
    return { forms, ui };
}

function nodeOfType(nodes: ReturnType<typeof screenNodes>, id: unknown, type: string, what: string): { node: ViewNode; parent: ViewNode | null } {
    const hit = typeof id === 'string' ? nodes.get(id) : undefined;
    if (!hit || hit.node.type !== type) {
        const known = [...nodes.values()].filter((n) => n.node.type === type).map((n) => n.node.id);
        return fail(`${what} "${String(id)}" is not a ${type} on this screen (${type}s here: ${known.join(', ') || 'none'})`);
    }
    return hit;
}

/** state.openModal and state.activeTab → initialUi entries. */
function resolveUi(state: Bag, nodes: ReturnType<typeof screenNodes>): { ui: Bag; openModal: string | null } {
    const ui: Bag = {};
    let openModal: string | null = null;
    if (state.openModal !== undefined && state.openModal !== null) {
        const modal = nodeOfType(nodes, state.openModal, 'modal', 'state.openModal');
        openModal = String(modal.node.id);
        ui[openModal] = { open: true };
    }
    const tabs = state.activeTab === undefined || state.activeTab === null ? [] : [state.activeTab].flat();
    if (tabs.length > VIEW_LIMITS.MAX_TABS) return fail(`state.activeTab names at most ${VIEW_LIMITS.MAX_TABS} tabs`);
    for (const tabId of tabs) {
        const group = nodeOfType(nodes, tabId, 'tab', 'state.activeTab').parent;
        if (!group || group.type !== 'tabs' || typeof group.id !== 'string') return fail(`state.activeTab "${String(tabId)}" is not inside a tab group`);
        ui[group.id] = { activeTab: tabId };
    }
    return { ui, openModal };
}

function resolveState(raw: unknown, definition: ViewDefinition, nodes: ReturnType<typeof screenNodes>): Pick<RenderView, 'vars' | 'forms' | 'screenParams' | 'initialUi' | 'openModal'> {
    const empty = { vars: null, forms: null, screenParams: null, initialUi: null, openModal: null };
    if (raw === undefined || raw === null) return empty;
    if (!isBag(raw)) return fail('state must be an object');
    if (jsonBytes(raw) > VIEW_LIMITS.MAX_STATE_BYTES) return fail(`state is larger than ${VIEW_LIMITS.MAX_STATE_BYTES} bytes`);
    const vars = resolveVars(raw.vars, definition);
    const screenParams = raw.screenParams === undefined || raw.screenParams === null ? null : plainBag(raw.screenParams, 'state.screenParams', false);
    const forms = resolveForms(raw.forms, nodes);
    const ui = resolveUi(raw, nodes);
    const initialUi = { ...(forms?.ui || {}), ...ui.ui };
    return {
        vars, forms: forms?.forms || null, screenParams,
        initialUi: Object.keys(initialUi).length ? initialUi : null, openModal: ui.openModal,
    };
}

function enumOrNull(raw: unknown, values: readonly string[], what: string): string | null {
    if (raw === undefined || raw === null) return null;
    return typeof raw === 'string' && values.includes(raw) ? raw : fail(`${what} is one of ${values.join(', ')}`);
}

function resolveNodeId(raw: unknown, nodes: ReturnType<typeof screenNodes>): string | null {
    if (raw === undefined || raw === null) return null;
    return typeof raw === 'string' && nodes.has(raw) ? raw : fail(`nodeId "${String(raw)}" is not a component on this screen`);
}

/** The request → a RenderView, or a plain sentence saying what is wrong with it. */
export function resolveRenderView(raw: unknown, definition: ViewDefinition, screen: ViewScreen): ViewResult {
    const input: Bag = isBag(raw) ? raw : {};
    const nodes = screenNodes(screen);
    try {
        const state = resolveState(input.state, definition || {}, nodes);
        const appearance = enumOrNull(input.appearance, APPEARANCES, 'appearance');
        const hostTheme = enumOrNull(input.hostTheme, HOST_THEMES, 'hostTheme');
        const nodeId = resolveNodeId(input.nodeId, nodes);
        return { ok: true, value: { chrome: input.chrome === true, ...state, appearance, hostTheme, nodeId } };
    } catch (e) {
        if (e instanceof ViewError) return { ok: false, error: e.message };
        throw e;
    }
}

/** What the page's mount() receives as `screenshot` (agent-hub appRuntimeScreenshot.tsx ScreenshotView). */
export function screenshotPayload(view: RenderView): Bag {
    const out: Bag = {};
    if (view.chrome) out.chrome = true;
    if (view.initialUi) out.initialUi = view.initialUi;
    if (view.vars) out.vars = view.vars;
    if (view.forms) out.forms = view.forms;
    if (view.screenParams) out.screenParams = view.screenParams;
    return out;
}

/** The definition the page renders: motion off (a still), and the appearance the view asks for. */
export function viewDefinition<D extends { design?: unknown; theme?: unknown }>(definition: D, view: RenderView | null): D {
    const design = { ...(isBag(definition.design) ? definition.design : {}), motion: 'none' };
    if (!view || !view.appearance) return { ...definition, design };
    return { ...definition, design, theme: { ...(isBag(definition.theme) ? definition.theme : {}), appearance: view.appearance } };
}
