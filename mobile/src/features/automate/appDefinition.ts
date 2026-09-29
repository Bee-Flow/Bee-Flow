/**
 * Reading a Studio app definition on a phone.
 *
 * An app is a structured component tree, never code — the schema lives in
 * server/appStudio/componentSpecs.js, which calls itself the single source of
 * truth and is enforced on save and on publish, so an unknown type can never
 * reach a published definition. It runs to 52 component types, including data
 * grids, kanban boards, charts, pivot tables and a live browser view. A phone
 * is not going to render that faithfully, and pretending otherwise (a WebView
 * over the desktop renderer) would be a worse lie than saying so.
 *
 * How much of it the phone draws is measured rather than assumed:
 * catalogLockstep.test.ts partitions that catalog into what this file handles,
 * what is deliberately left to the browser, and what is simply not built yet —
 * and fails when a new component belongs to none of the three.
 *
 * So this module reduces an app to the part that IS phone-shaped: a form, a
 * button, and a result. It walks the tree, keeps the components it can render
 * honestly, and reports by name every type it skipped so the screen can say
 * what is missing instead of quietly showing half an app.
 *
 * The runnable subset is pinned to what the server will actually accept:
 * POST /:id/actions/:actionId/run answers 404 for any action whose kind is not
 * `run_automation` (routes/studioAppsRun.js), so a button wired to a sequence,
 * a navigation or a toast is shown disabled rather than failing on tap.
 */

import type { AppAction, AppDefinition, AppFormValues, AppNode, AppScreen } from './types';

/** The input types this client knows how to draw, from FORM_SPECS. */
export const SUPPORTED_INPUTS = [
    'input_text',
    'input_textarea',
    'input_number',
    'input_select',
    'input_checkbox',
    'input_date',
] as const;

export type SupportedInput = (typeof SUPPORTED_INPUTS)[number];

/**
 * Every catalog type this file HANDLES — draws as a block, or walks through.
 *
 * Must match the switch in `planScreen`. It is a second list rather than the
 * switch itself because a switch is not enumerable, and the alternative to a
 * second list was what this codebase had: no list, and a coverage gap that
 * widened silently every time the server catalog grew. `appDefinition.test.ts`
 * partitions the real catalog against this and the two below, so adding a
 * component on the server fails a mobile test until someone decides what the
 * phone should do with it.
 */
export const HANDLED_TYPES = [
    'page_header',
    'spacer',
    'heading',
    'text',
    'callout',
    'stat',
    'divider',
    'form',
    'button',
    'card',
    'container',
    ...SUPPORTED_INPUTS,
] as const;

/**
 * Types deliberately left to the browser, with the reason. These are not a
 * to-do list: a fake kanban on a 390px screen is worse than an honest
 * "open this on a desktop".
 */
export const BROWSER_ONLY_TYPES: Readonly<Record<string, string>> = {
    kanban: 'Cross-column drag needs a canvas; the phone answer is a status picker on the record.',
    pivot: 'A cross-tab needs two axes and one of them does not fit.',
    browser_view: 'A desktop viewport streamed as JPEG and scaled to phone width is unreadable.',
    file_preview: 'Renders through a same-origin blob: URL in an iframe — neither exists in React Native.',
};


export interface SelectOption {
    value: string;
    label: string;
}

export interface AppInput {
    node: AppNode;
    type: SupportedInput;
    /** The key the value is submitted under — `props.name`, required by spec. */
    name: string;
    label: string;
    placeholder: string | null;
    required: boolean;
    options: SelectOption[];
    min: number | null;
    max: number | null;
    rows: number;
    inputType: 'text' | 'email' | 'url';
    initial: string | number | boolean | null;
}

export interface RunnableAction {
    actionId: string;
    action: AppAction;
    /** False when the action exists but the phone cannot run its kind. */
    runnable: boolean;
    label: string;
}

export type AppBlock =
    | { kind: 'page_header'; id: string; title: string; subtitle: string | null; divider: boolean }
    | { kind: 'spacer'; id: string; steps: number }
    | { kind: 'heading'; id: string; text: string; level: number }
    | { kind: 'text'; id: string; text: string; muted: boolean }
    | { kind: 'callout'; id: string; title: string | null; body: string; tone: string }
    | { kind: 'stat'; id: string; label: string; value: string }
    | { kind: 'divider'; id: string }
    | { kind: 'form'; id: string; title: string | null; description: string | null; submitLabel: string; inputs: AppInput[]; action: RunnableAction | null }
    | { kind: 'button'; id: string; action: RunnableAction };

export interface AppPlan {
    screen: AppScreen | null;
    blocks: AppBlock[];
    /** Distinct component types this client dropped, in first-seen order. */
    unsupported: string[];
}

/**
 * Flatten one screen into an ordered list of things the phone can draw.
 *
 * Containers (card, container, tabs, repeater, modal) are walked THROUGH
 * rather than drawn: their whole job is 12-column layout, and a phone is one
 * column. Their children keep their order, which is the only part of the
 * layout that survives the narrowing intact.
 */
export function planScreen(
    definition: AppDefinition,
    screenId?: string | null,
    /**
     * The viewer's role key, from the runtime payload. Null when the server
     * mapped them to no role — which, per roleAllows() in
     * server/routes/studioAppRunGate.js, clears OPEN gates only. Drawing a
     * role-gated button to someone the server will 403 is the worst of both:
     * it looks available and fails on tap.
     */
    viewerRole?: string | null,
): AppPlan {
    const screens = definition.screens ?? [];
    const screen =
        screens.find((s) => s.id === (screenId ?? definition.homeScreenId)) ?? screens[0] ?? null;
    if (!screen) return { screen: null, blocks: [], unsupported: [] };

    const blocks: AppBlock[] = [];
    const unsupported: string[] = [];
    const noteUnsupported = (type: string) => {
        if (!unsupported.includes(type)) unsupported.push(type);
    };

    /** Mirrors roleAllows() on the server: an absent or empty gate is open. */
    const roleAllows = (node: AppNode): boolean => {
        const gate = node.visibleToRoles;
        if (!Array.isArray(gate) || gate.length === 0) return true;
        return typeof viewerRole === 'string' && gate.includes(viewerRole);
    };

    const walk = (nodes: AppNode[] | undefined) => {
        for (const node of nodes ?? []) {
            if (!node || typeof node !== 'object' || node.visible === false) continue;
            // Hidden from this viewer. Not reported: naming it would tell them
            // a thing exists that they are not allowed to know about.
            if (!roleAllows(node)) continue;
            // A formula gate the phone cannot evaluate. Rendering it anyway is
            // a guess in the wrong direction — the web treats visibleWhen as
            // AUTHORITATIVE over `visible`, so a node the owner conditioned off
            // would appear here, and its value would be submitted with the
            // form. Reported rather than drawn.
            if (node.visibleWhen != null || node.enabledWhen != null) {
                noteUnsupported(node.type);
                continue;
            }
            const props = node.props ?? {};

            switch (node.type) {
                case 'form': {
                    const inputs = collectInputs(node, noteUnsupported);
                    const action = resolveAction(definition, node.onSubmit ?? null, 'Submit');
                    blocks.push({
                        kind: 'form',
                        id: node.id,
                        title: str(props.name) ?? null,
                        description: null,
                        submitLabel: str(props.submitLabel) ?? 'Submit',
                        inputs,
                        // showSubmit:false means the fields save on change,
                        // which is a data-model behaviour the phone does not
                        // implement — so the form renders read-to-fill with no
                        // button rather than a button that does nothing.
                        action: bool(props.showSubmit, true) ? action : null,
                    });
                    break;
                }
                case 'heading':
                    blocks.push({
                        kind: 'heading',
                        id: node.id,
                        text: str(props.text) ?? '',
                        level: num(props.level) ?? 2,
                    });
                    break;
                case 'text':
                    blocks.push({
                        kind: 'text',
                        id: node.id,
                        text: str(props.text) ?? '',
                        muted: bool(props.muted, false),
                    });
                    break;
                case 'callout':
                    blocks.push({
                        kind: 'callout',
                        id: node.id,
                        title: str(props.title) ?? null,
                        body: str(props.text) ?? '',
                        tone: str(props.tone) ?? 'info',
                    });
                    break;
                case 'divider':
                    blocks.push({ kind: 'divider', id: node.id });
                    break;
                case 'stat': {
                    // Only a static binding can be resolved without the app's
                    // data layer; anything computed is left out rather than
                    // shown as a zero that is not true.
                    const value = staticBinding(props.value);
                    if (value === null) {
                        noteUnsupported(node.type);
                        break;
                    }
                    blocks.push({
                        kind: 'stat',
                        id: node.id,
                        label: str(props.label) ?? '',
                        value,
                    });
                    break;
                }
                case 'button': {
                    // A submit button belongs to its form, which already draws
                    // one; only free-standing buttons become their own block.
                    if (str(props.role) === 'submit') break;
                    const action = resolveAction(
                        definition,
                        node.onClick ?? null,
                        str(props.label) ?? 'Run',
                    );
                    if (action) blocks.push({ kind: 'button', id: node.id, action });
                    break;
                }
                case 'page_header': {
                    // The first node on nearly every real screen — 12 of the 12
                    // shipped templates use one, 81 times between them — and it
                    // was going into the unsupported banner while `heading`
                    // (4 of 12) was drawn. Its children are the action area, so
                    // they are walked: the buttons keep working.
                    blocks.push({
                        kind: 'page_header',
                        id: node.id,
                        title: str(props.title) ?? '',
                        subtitle: str(props.subtitle) ?? null,
                        divider: bool(props.showDivider, true),
                    });
                    walk(node.children);
                    break;
                }
                case 'spacer':
                    blocks.push({ kind: 'spacer', id: node.id, steps: num(props.steps) ?? 1 });
                    break;
                case 'card':
                case 'container':
                    walk(node.children);
                    break;
                case 'modal':
                    // Do NOT walk into it. A modal's children are hidden until
                    // a trigger or an open_modal action opens it; walking them
                    // put the bodies of 44 dialogs across the shipped templates
                    // inline on the page, always visible. Until the phone has a
                    // trigger to honour, saying "there is a dialog here" is the
                    // only honest rendering.
                    noteUnsupported(node.type);
                    break;
                default:
                    // An input outside a form is legal in the schema; it just
                    // has nowhere to submit to, so it is reported rather than
                    // drawn as a field that goes nowhere.
                    noteUnsupported(node.type);
                    if (node.children?.length) walk(node.children);
                    break;
            }
        }
    };

    for (const section of screen.sections ?? []) walk(section.children);

    return { screen, blocks, unsupported };
}

/** Screens worth offering in a picker — the ones the app itself navigates to. */
export function navigableScreens(definition: AppDefinition): AppScreen[] {
    return (definition.screens ?? []).filter((s) => s.showInNav !== false);
}

function collectInputs(root: AppNode, noteUnsupported: (type: string) => void): AppInput[] {
    const out: AppInput[] = [];
    const walk = (nodes: AppNode[] | undefined) => {
        for (const node of nodes ?? []) {
            if (!node || node.visible === false) continue;
            if (isSupportedInput(node.type)) {
                const input = toInput(node, node.type);
                if (input) out.push(input);
                continue;
            }
            if (node.type.startsWith('input_')) {
                // A field the phone cannot draw must be named: a form silently
                // missing its file picker submits an incomplete payload and
                // the failure surfaces as a runtime error much later.
                noteUnsupported(node.type);
                continue;
            }
            // Anything else inside a form is content — a heading, a paragraph,
            // a callout. A form block holds inputs only, so this cannot be
            // drawn here, and it used to vanish without a word: not rendered,
            // not reported. With `form` in 12 of 12 shipped templates and
            // `text` appearing 464 times, that was the largest silent hole in
            // this renderer. Containers still recurse; leaves get named.
            if (!node.children?.length) {
                noteUnsupported(node.type);
                continue;
            }
            walk(node.children);
        }
    };
    walk(root.children);
    return out;
}

function isSupportedInput(type: string): type is SupportedInput {
    return (SUPPORTED_INPUTS as readonly string[]).includes(type);
}

function toInput(node: AppNode, type: SupportedInput): AppInput | null {
    const props = node.props ?? {};
    const name = str(props.name);
    if (!name) return null;

    const options = optionList(props.options);
    const initial =
        type === 'input_checkbox'
            ? bool(props.defaultChecked, false)
            : type === 'input_number'
              ? (num(props.defaultValue) ?? null)
              : type === 'input_date'
                ? defaultDate(str(props.defaultValue))
                : (str(props.defaultValue) ?? null);

    return {
        node,
        type,
        name,
        label: str(props.label) ?? name,
        placeholder: str(props.placeholder) ?? null,
        required: bool(props.required, false),
        options,
        min: num(props.min) ?? null,
        max: num(props.max) ?? null,
        rows: num(props.rows) ?? 4,
        inputType: (str(props.inputType) as AppInput['inputType']) ?? 'text',
        initial,
    };
}

export function initialValues(inputs: AppInput[]): AppFormValues {
    const values: AppFormValues = {};
    for (const input of inputs) values[input.name] = input.initial;
    return values;
}

/** Names of the required fields that are still empty. */
export function missingRequired(inputs: AppInput[], values: AppFormValues): string[] {
    return inputs
        .filter((input) => {
            if (!input.required) return false;
            const value = values[input.name];
            if (input.type === 'input_checkbox') return value !== true;
            return value === null || value === undefined || String(value).trim() === '';
        })
        .map((input) => input.label);
}

function resolveAction(
    definition: AppDefinition,
    actionId: string | null,
    fallbackLabel: string,
): RunnableAction | null {
    if (!actionId) return null;
    const actions = definition.actions ?? {};
    // Own-property lookup, matching the server's guard: an action id of
    // '__proto__' must not resolve to something inherited.
    if (!Object.prototype.hasOwnProperty.call(actions, actionId)) return null;
    const action = actions[actionId];
    if (!action) return null;
    return {
        actionId,
        action,
        runnable: action.kind === 'run_automation' && Boolean(action.automationId),
        label: fallbackLabel,
    };
}

// ── Prop readers ────────────────────────────────────────────────────
// The definition arrives as JSON with no schema at the type level, so each of
// these narrows one prop and returns undefined rather than throwing — a single
// malformed prop must not take the whole app off the screen.

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function optionList(value: unknown): SelectOption[] {
    if (!Array.isArray(value)) return [];
    const out: SelectOption[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const optionValue = str(record.value);
        if (!optionValue) continue;
        out.push({ value: optionValue, label: str(record.label) ?? optionValue });
    }
    return out;
}

/** `{ kind: 'static', value }` is the only binding resolvable client-side. */
function staticBinding(value: unknown): string | null {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.kind !== 'static') return null;
    const inner = record.value;
    if (inner === null || inner === undefined) return null;
    return typeof inner === 'object' ? null : String(inner);
}

/** input_date accepts `'today'` or a literal ISO date; both submit YYYY-MM-DD. */
function defaultDate(value: string | undefined): string | null {
    if (!value) return null;
    if (value === 'today') return new Date().toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
