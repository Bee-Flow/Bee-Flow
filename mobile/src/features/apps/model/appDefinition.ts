/**
 * Reading a Studio app definition on a phone.
 *
 * An app is a structured component tree, never code — the schema lives in
 * server/appStudio/componentSpecs.js, which calls itself the single source of
 * truth and is enforced on save and on publish. It runs to 52 component types,
 * including data grids, kanban boards, charts, pivot tables and a live browser
 * view. A phone is not going to render that faithfully, and pretending
 * otherwise (a WebView over the desktop renderer) would be a worse lie than
 * saying so. How much of it the phone draws is measured: see catalog.ts.
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

import { collectInputs, type AppInput } from './inputs';
import { bool, num, staticBinding, str } from './props';
import type { AppAction, AppDefinition, AppNode, AppScreen } from './types';

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

/** What a block builder may do: add blocks, name what it skipped, walk on. */
interface PlanContext {
    definition: AppDefinition;
    viewerRole: string | null | undefined;
    blocks: AppBlock[];
    noteUnsupported: (type: string) => void;
    walk: (nodes: AppNode[] | undefined) => void;
}

type BlockBuilder = (node: AppNode, props: Record<string, unknown>, ctx: PlanContext) => void;

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

const buildForm: BlockBuilder = (node, props, ctx) => {
    const inputs = collectInputs(node, ctx.noteUnsupported);
    const action = resolveAction(ctx.definition, node.onSubmit ?? null, 'Submit');
    ctx.blocks.push({
        kind: 'form',
        id: node.id,
        title: str(props.name) ?? null,
        description: null,
        submitLabel: str(props.submitLabel) ?? 'Submit',
        inputs,
        // showSubmit:false means the fields save on change, which is a
        // data-model behaviour the phone does not implement — so the form
        // renders read-to-fill with no button rather than one that does nothing.
        action: bool(props.showSubmit, true) ? action : null,
    });
};

const buildStat: BlockBuilder = (node, props, ctx) => {
    // Only a static binding can be resolved without the app's data layer;
    // anything computed is left out rather than shown as a zero that is not true.
    const value = staticBinding(props.value);
    if (value === null) {
        ctx.noteUnsupported(node.type);
        return;
    }
    ctx.blocks.push({ kind: 'stat', id: node.id, label: str(props.label) ?? '', value });
};

const buildButton: BlockBuilder = (node, props, ctx) => {
    // A submit button belongs to its form, which already draws one; only
    // free-standing buttons become their own block.
    if (str(props.role) === 'submit') return;
    const action = resolveAction(ctx.definition, node.onClick ?? null, str(props.label) ?? 'Run');
    if (action) ctx.blocks.push({ kind: 'button', id: node.id, action });
};

const buildPageHeader: BlockBuilder = (node, props, ctx) => {
    // The first node on nearly every real screen — 12 of the 12 shipped
    // templates use one, 81 times between them — and it was going into the
    // unsupported banner while `heading` (4 of 12) was drawn. Its children are
    // the action area, so they are walked: the buttons keep working.
    ctx.blocks.push({
        kind: 'page_header',
        id: node.id,
        title: str(props.title) ?? '',
        subtitle: str(props.subtitle) ?? null,
        divider: bool(props.showDivider, true),
    });
    ctx.walk(node.children);
};

/** Containers are walked THROUGH: their job is 12-column layout, and a phone is one column. */
const walkThrough: BlockBuilder = (node, _props, ctx) => ctx.walk(node.children);

/**
 * One builder per handled type — the list catalog.ts's HANDLED_TYPES mirrors.
 * A modal is NOT walked: its children are hidden until a trigger opens it, and
 * walking them put the bodies of 44 dialogs inline on the page, always
 * visible. Until the phone has a trigger to honour, saying "there is a dialog
 * here" is the only honest rendering.
 */
const BLOCK_BUILDERS: Readonly<Record<string, BlockBuilder>> = {
    form: buildForm,
    heading: (node, props, ctx) =>
        ctx.blocks.push({ kind: 'heading', id: node.id, text: str(props.text) ?? '', level: num(props.level) ?? 2 }),
    text: (node, props, ctx) =>
        ctx.blocks.push({ kind: 'text', id: node.id, text: str(props.text) ?? '', muted: bool(props.muted, false) }),
    callout: (node, props, ctx) =>
        ctx.blocks.push({
            kind: 'callout',
            id: node.id,
            title: str(props.title) ?? null,
            body: str(props.text) ?? '',
            tone: str(props.tone) ?? 'info',
        }),
    divider: (node, _props, ctx) => ctx.blocks.push({ kind: 'divider', id: node.id }),
    stat: buildStat,
    button: buildButton,
    page_header: buildPageHeader,
    spacer: (node, props, ctx) => ctx.blocks.push({ kind: 'spacer', id: node.id, steps: num(props.steps) ?? 1 }),
    card: walkThrough,
    container: walkThrough,
    modal: (node, _props, ctx) => ctx.noteUnsupported(node.type),
};

/**
 * Anything else. An input outside a form is legal in the schema; it just has
 * nowhere to submit to, so it is reported rather than drawn as a field that
 * goes nowhere.
 */
const buildUnknown: BlockBuilder = (node, _props, ctx) => {
    ctx.noteUnsupported(node.type);
    if (node.children?.length) ctx.walk(node.children);
};

/** Mirrors roleAllows() on the server: an absent or empty gate is open. */
function roleAllows(node: AppNode, viewerRole: string | null | undefined): boolean {
    const gate = node.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return typeof viewerRole === 'string' && gate.includes(viewerRole);
}

function planNode(node: AppNode, ctx: PlanContext): void {
    if (!node || typeof node !== 'object' || node.visible === false) return;
    // Hidden from this viewer. Not reported: naming it would tell them a thing
    // exists that they are not allowed to know about.
    if (!roleAllows(node, ctx.viewerRole)) return;
    // A formula gate the phone cannot evaluate. Rendering it anyway is a guess
    // in the wrong direction — the web treats visibleWhen as AUTHORITATIVE over
    // `visible`, so a node the owner conditioned off would appear here, and its
    // value would be submitted with the form. Reported rather than drawn.
    if (node.visibleWhen != null || node.enabledWhen != null) {
        ctx.noteUnsupported(node.type);
        return;
    }
    const build = Object.prototype.hasOwnProperty.call(BLOCK_BUILDERS, node.type)
        ? (BLOCK_BUILDERS[node.type] as BlockBuilder)
        : buildUnknown;
    build(node, node.props ?? {}, ctx);
}

/**
 * Flatten one screen into an ordered list of things the phone can draw.
 * Containers keep their children's order, which is the only part of the
 * layout that survives the narrowing to one column intact.
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

    const unsupported: string[] = [];
    const ctx: PlanContext = {
        definition,
        viewerRole,
        blocks: [],
        noteUnsupported: (type) => {
            if (!unsupported.includes(type)) unsupported.push(type);
        },
        walk: (nodes) => {
            for (const node of nodes ?? []) planNode(node, ctx);
        },
    };

    for (const section of screen.sections ?? []) ctx.walk(section.children);

    return { screen, blocks: ctx.blocks, unsupported };
}

/** Screens worth offering in a picker — the ones the app itself navigates to. */
export function navigableScreens(definition: AppDefinition): AppScreen[] {
    return (definition.screens ?? []).filter((s) => s.showInNav !== false);
}
