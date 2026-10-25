import { eventText } from './nodeLogicSummary';
import { nOf } from '../../KnowledgeStudio/plural';
import { describeAction } from '../inspector/actionLabels';
import { TYPE_EVENT_LISTS } from '../inspector/styleKnobMeta';
import { NODE_EVENTS } from '../state/definitionOps';
import type { AppAction, AppDefinition, AppScreen, AppNode, CommonNodeProps } from '../inspector/appDefinition';
import type { TranslateFn, TranslateParams } from '../../../../../hooks/useTranslation';
import type { AutomationRow } from './automationTitles';
import type { SaveNotice } from './saveNotices';
import type { NodeEntry, RowCommon, LogicRow, RowExtra, MakeEmitterArgs, LogicRowsOptions, DerivedAutomationRowsArgs } from './logicRows.types';
export type { LogicRow } from './logicRows.types';

/**
 * The rows of the Logic tab: one table across ALL screens of "when" × "what then happens".
 *
 * The old Logic view (collectLogicMarks in nodeLogicSummary.js) ran only over NODE_EVENTS and skipped every
 * slot with a falsy action. As a result it showed precisely the half that was already fine, and concealed the
 * half that a builder looks for:
 *
 *   • an event that a component CAN carry but that is attached to nothing (data_grid onRowClick, kanban
 *     onCardMove, every input onChange, approval_list onDecided) — no row, no warning, nothing;
 *   • the four other action surfaces that the server DOES count as reachable (validate/nodes.js
 *     collectReferencedActions): rowActions, itemActions, bulkActions, toolbarActions, props.addRowActionId
 *     and props.columns[].actionId;
 *   • an action in `definition.actions` that nothing points to — server-side an `action.unreachable` warning,
 *     previously invisible here.
 *
 * Silently leaving things out is the failure this screen must solve, so EVERYTHING goes into the table, and
 * each row carries itself whether it is wired (`wired`). The tab draws an unwired row dotted and attaches the
 * save notice that the server sent about that component.
 *
 * → [{ key, kind, wired, when, what, ... }] in reading order: per screen, first the descriptive "screen opens"
 * row, then the components in canvas order.
 */

/** Zelfde stand-in voor t() als nodeLogicSummary/dryRunIssues — zie daar. */
const EN_ONLY = (key: string | undefined, en: string, params?: TranslateParams): string => (params && typeof params === 'object'
    ? Object.entries(params).reduce(
        (out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
        String(en),
    )
    : en);

/**
 * The four list surfaces plus the two loose ones, in the words in which they happen. This is the same
 * collection that collectReferencedActions (server/appStudio/validate/nodes.js) counts as "reachable" — the
 * role gate (studioAppRunGate.js) and the old Logic view knew only part of it, and that difference is
 * precisely where an action became invisible.
 */
const SURFACE_LISTS = ['rowActions', 'itemActions', 'bulkActions', 'toolbarActions'];

function surfaceWhen(t: TranslateFn, surface: string) {
    switch (surface) {
        case 'rowActions': return t('app_studio.logic.when_row_action', 'When a row action is used');
        case 'itemActions': return t('app_studio.logic.when_item_action', 'When an item action is used');
        case 'bulkActions': return t('app_studio.logic.when_bulk_action', 'When a bulk action is used');
        case 'toolbarActions': return t('app_studio.logic.when_toolbar_action', 'When a toolbar button is used');
        case 'addRowActionId': return t('app_studio.logic.when_add_row', 'When a new row is added');
        case 'columnAction': return t('app_studio.logic.when_cell_action', 'When a cell action is used');
        default: return surface;
    }
}

/** De triggersoort van een automatisering, in een zin. */
function triggerWhen(t: TranslateFn, kind: string) {
    switch (kind) {
        case 'schedule': return t('app_studio.logic.when_schedule', 'On a schedule');
        case 'webhook': return t('app_studio.logic.when_webhook', 'When a webhook arrives');
        case 'app_event': return t('app_studio.logic.when_app_event', 'When data in the app changes');
        case 'app_trigger': return t('app_studio.logic.when_app_trigger', 'When this app calls it');
        case 'agent_call': return t('app_studio.logic.when_agent_call', 'When an agent calls it');
        case 'manual': return t('app_studio.logic.when_manual', 'When someone runs it by hand');
        default: return t('app_studio.logic.when_other_trigger', 'When its own trigger fires');
    }
}

/** Which events this component TYPE may carry — empty for a type without events. */
export function eventsForType(type: string|number) {
    const list = TYPE_EVENT_LISTS[type];
    return Array.isArray(list) ? list : [];
}

/**
 * The event slots of THIS component: what the type may carry, PLUS every slot that is actually in it.
 *
 * The type list alone is not enough, and that is the reason this function exists. The server walks by NAME
 * over every node (validate/nodes.js, EVENT_NAMES + collectReferencedActions) and the canvas badge does too
 * (nodeLogicSummary walks NODE_EVENTS). A wired slot outside the type list — a type that loses an event from
 * its spec while stored definitions keep the slot, or an install/import that did not go through
 * PUT /:id/definition — dropped out of this tab and made its action an "orphan": of the three readers, the
 * screen that was built because nothing may silently disappear hid the wiring, together with the reverse claim
 * ("Nothing starts this yet").
 *
 * The order stays that of the type; whatever is extra comes after it.
 */
function eventSlotsOf(node: AppNode | null | undefined) {
    const slots = eventsForType(node?.type ?? '').slice();
    for (const event of NODE_EVENTS) {
        if (slots.includes(event)) continue;
        if (typeof node?.[event] === 'string' && node[event]) slots.push(event);
    }
    return slots;
}

/**
 * Every `tableId` that is bound anywhere in the props of this screen or app.
 *
 * Walked deeply instead of read out per binding kind: the kind list (componentSpecs/bindings.js
 * BINDING_KINDS) is closed but lives on the server, and a binding sometimes sits two levels deep (column
 * filters, nested aggregations). An object with a string `tableId` IS a table binding, whichever kind it
 * sits in — that stays true when a kind is added.
 */
export function collectBoundTableIds(root: unknown) {
    const ids = new Set<string>();
    const seen = new Set<unknown>();
    const walk = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) walk(item);
            return;
        }
        const obj = value as Record<string, unknown>;
        if (typeof obj.tableId === 'string' && obj.tableId) ids.add(obj.tableId);
        for (const key of Object.keys(obj)) {
            if (key === 'tableId') continue;
            walk(obj[key]);
        }
    };
    walk(root);
    return ids;
}

function nodesOfScreen(screen: AppScreen, screenIndex: number): NodeEntry[] {
    const out: NodeEntry[] = [];
    const walk = (node: AppNode<CommonNodeProps>, path: string) => {
        if (!node || typeof node !== 'object') return;
        out.push({ node, path });
        const children = Array.isArray(node.children) ? node.children : [];
        children.forEach((child, i) => walk(child, `${path}.children[${i}]`));
    };
    (Array.isArray(screen?.sections) ? screen.sections : []).forEach((section, s) => {
        (Array.isArray(section?.children) ? section.children : []).forEach((child, c) => {
            walk(child, `screens[${screenIndex}].sections[${s}].children[${c}]`);
        });
    });
    return out;
}

function actionsOf(definition: AppDefinition | null): Record<string, AppAction> {
    return definition?.actions && typeof definition.actions === 'object' ? definition.actions : {};
}

/**
 * What sits behind an action id, in the language of the author — or, if the action is not there, says so.
 * `describeAction` names; that there is NOTHING to name is a different message and must not pass as a name.
 */
function whatOf(t: TranslateFn, actionId: string, definition: AppDefinition | null, titleFor: ((automationId?: string | null) => string | null) | null) {
    const action = actionsOf(definition)[actionId];
    if (!action) return t('app_studio.canvas.mark_missing_action', 'points at an action that no longer exists');
    return describeAction(actionId, action, definition, titleFor);
}

function baseRow(extra: RowExtra & Pick<LogicRow, 'what'>): LogicRow {
    return {
        kind: 'event',
        wired: true,
        screenId: null,
        screenName: '',
        nodeId: null,
        nodeType: null,
        event: null,
        surface: null,
        surfaceLabel: null,
        actionId: null,
        actionKind: null,
        automationId: null,
        path: '',
        descriptive: false,
        ...extra,
    };
}

/**
 * The descriptive row "Screen is opened".
 *
 * DEVIATION FROM THE ARTBOARD, deliberate. The artboard draws this row among the others, as if an
 * `onScreenOpen` event existed. It does not: EVENT_NAMES (server/appStudio/componentSpecs/screenSpec.js)
 * knows seven events and none of them hangs on a screen, and the runtime loads data because a component has
 * a BINDING, not because someone wired something. Inventing a new event would yield a slot that the server
 * refuses (`event.not_supported`), and the AI builder could "wire" it without anything ever firing. So:
 * derived from the data bindings, marked as `descriptive`, and the tab draws it without a wiring affordance —
 * you cannot click it to attach an action, because there is nothing to attach to.
 *
 * No bindings on the screen → no row. Then nothing actually happens on opening, and "nothing happens" as a row
 * is noise, not information.
 */

function screenOpenRow(t: TranslateFn, screen: AppScreen, screenIndex: number, nodes: NodeEntry[]) {
    const loaders = nodes.filter(({ node }) => collectBoundTableIds(node.props).size > 0);
    if (!loaders.length) return null;
    const tables = new Set<string>();
    for (const { node } of loaders) for (const id of collectBoundTableIds(node.props)) tables.add(id);
    return baseRow({
        key: `screen:${screen.id}`,
        kind: 'screen_open',
        descriptive: true,
        screenId: screen.id,
        screenName: screen.name || '',
        path: `screens[${screenIndex}]`,
        when: t('app_studio.logic.when_screen_opens', 'When the screen is opened'),
        // No table NAMES: those sit behind a fetch, not in the definition (the same reason as for actionLabels'
        // create_record). The number of components is what the definition does know, and it is no less true.
        what: nOf(
            t, 'app_studio.logic.screen_loads', loaders.length,
            '{count} component loads its data', '{count} components load their data',
        ),
        loaderCount: loaders.length,
        tableIds: [...tables],
    });
}

function makeEmitter({ rows, definition, titleFor, t, referenced }: MakeEmitterArgs) {
    const actions = actionsOf(definition);
    return {
        plain(row: RowExtra) {
            rows.push(baseRow({ ...row, wired: false, what: t('app_studio.logic.no_action_yet', 'No action yet') }));
        },
        wired(row: RowExtra, actionId: string) {
            const action = actions[actionId];
            referenced.add(actionId);
            rows.push(baseRow({
                ...row,
                wired: true,
                actionId,
                actionKind: action?.kind || null,
                automationId: action?.kind === 'run_automation' ? (action.automationId || null) : null,
                what: whatOf(t, actionId, definition, titleFor),
            }));
        },
    };
}

/**
 * Every event slot that this component type MAY carry, wired or not.
 *
 * The unwired half is the core of this screen. Today such a slot disappears without a trace: the canvas badge
 * skips a falsy actionId (nodeLogicSummary.js), "Logic n" does not count it, and the validator is silent about
 * it except on a button and a form. So it stays here.
 */
type Emitter = ReturnType<typeof makeEmitter>;

function emitEventRows(node: AppNode, common: RowCommon, emit: Emitter, t: TranslateFn) {
    for (const event of eventSlotsOf(node)) {
        const raw = node[event];
        const actionId = typeof raw === 'string' && raw ? raw : null;
        const row = { ...common, key: `${node.id}:${event}`, event, when: eventText(t, event) };
        if (actionId) emit.wired(row, actionId);
        else emit.plain(row);
    }
}

/**
 * The six action surfaces alongside the events: four lists plus addRowActionId and columns[].actionId. This is
 * the list from collectReferencedActions (server/appStudio/validate/nodes.js); the role gate and the old view
 * knew only part of it.
 *
 * An empty actionId in a list is the inspector's own "not wired yet" state — validate/nodes.js allows it
 * explicitly — so it counts as unwired and not as broken.
 */
function emitSurfaceRows(node: AppNode, common: RowCommon, emit: Emitter, t: TranslateFn) {
    const props = (node.props && typeof node.props === 'object') ? node.props : {};
    const { path } = common;
    for (const listKey of SURFACE_LISTS) {
        (Array.isArray(props[listKey]) ? props[listKey] : []).forEach((entry, i) => {
            if (!entry || typeof entry !== 'object') return;
            const row = {
                ...common,
                key: `${node.id}:${listKey}[${i}]`,
                surface: listKey,
                surfaceLabel: labelOf(entry),
                path: `${path}.props.${listKey}[${i}].actionId`,
                when: surfaceWhen(t, listKey),
            };
            if (typeof entry.actionId === 'string' && entry.actionId) emit.wired(row, entry.actionId);
            else emit.plain(row);
        });
    }
    if (typeof props.addRowActionId === 'string' && props.addRowActionId) {
        emit.wired({
            ...common,
            key: `${node.id}:addRowActionId`,
            surface: 'addRowActionId',
            path: `${path}.props.addRowActionId`,
            when: surfaceWhen(t, 'addRowActionId'),
        }, props.addRowActionId);
    }
    (Array.isArray(props.columns) ? props.columns : []).forEach((col: { actionId?: unknown; label?: unknown } | null, i: number) => {
        if (!col || typeof col !== 'object') return;
        if (typeof col.actionId !== 'string' || !col.actionId) return;
        emit.wired({
            ...common,
            key: `${node.id}:columns[${i}]`,
            surface: 'columnAction',
            surfaceLabel: labelOf(col),
            path: `${path}.props.columns[${i}].actionId`,
            when: surfaceWhen(t, 'columnAction'),
        }, col.actionId);
    });
}

/** The own label of a row or column action, or nothing if there is none. */
function labelOf(entry: { label?: unknown } | null | undefined) {
    return typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
}

export default function logicRows(definition: AppDefinition | null, { titleFor = null, t = EN_ONLY }: LogicRowsOptions = {}) {
    const rows: LogicRow[] = [];
    /** Elke actie waar iets naar wijst — de reached-set van validate.js. */
    const referenced = new Set<string>();
    const emit = makeEmitter({ rows, definition, titleFor, t, referenced });

    (Array.isArray(definition?.screens) ? definition.screens : []).forEach((screen, screenIndex) => {
        const nodes = nodesOfScreen(screen, screenIndex);
        const opener = screenOpenRow(t, screen, screenIndex, nodes);
        if (opener) rows.push(opener);
        for (const { node, path } of nodes) {
            const common: RowCommon = {
                screenId: screen.id,
                screenName: screen.name || '',
                nodeId: node.id || null,
                nodeType: node.type || null,
                path,
            };
            emitEventRows(node, common, emit, t);
            emitSurfaceRows(node, common, emit, t);
        }
    });

    // Actions that nothing points to. The server issues an `action.unreachable` warning about these (validate.js)
    // and the old view left them out — so an automation you had just chosen was nowhere to be seen, and you
    // added it a second time.
    for (const [actionId, action] of Object.entries(actionsOf(definition))) {
        if (referenced.has(actionId)) continue;
        rows.push(baseRow({
            key: `orphan:${actionId}`,
            kind: 'orphan_action',
            wired: false,
            actionId,
            actionKind: action?.kind || null,
            automationId: action?.kind === 'run_automation' ? (action.automationId || null) : null,
            path: `actions.${actionId}`,
            when: t('app_studio.logic.when_nothing', 'Nothing starts this yet'),
            what: whatOf(t, actionId, definition, titleFor),
        }));
    }

    return rows;
}

/**
 * Does this automation belong to this app? Three conditions, all three narrowing: it is in the same solution,
 * it is not yet attached to a button (then it already stands above), and it touches a table to which the app
 * is bound.
 */
function belongsToApp(row: AutomationRow, { projectId, tables, wired }: { projectId: string; tables: Set<string>; wired: Set<string> }) {
    if (!row?.id || row.projectId !== projectId) return false;
    if (wired.has(row.id)) return false;
    return automationTouchesTables(row, tables);
}

/** A Set of what comes in: a Set stays itself, a list becomes one. */
function asSet(value: Set<string> | string[] | null | undefined): Set<string> {
    if (value instanceof Set) return value;
    return new Set(Array.isArray(value) ? value : []);
}

/** The trigger type of a routine, as AutomationPicker also reads it. */
function triggerKindOf(row: AutomationRow) {
    return row?.definition?.trigger?.kind || row?.triggerType || 'manual';
}

/**
 * Does this automation touch one of these tables?
 *
 * A `datatable` step carries `datatableId` (or `datatableKey`); a table trigger carries its table in
 * `trigger.filter.tableId`. Steps can be nested (loop body, if/else, switch cases), so the walk goes through
 * them — an automation that writes to the table only inside a loop touches it just as well.
 */
export function automationTouchesTables(row: Pick<AutomationRow, 'definition'>, tableIds: Set<string>) {
    if (!(tableIds instanceof Set) || tableIds.size === 0) return false;
    const hit = (v: unknown) => typeof v === 'string' && v && tableIds.has(v);
    if (hit(row?.definition?.trigger?.filter?.tableId)) return true;
    let found = false;
    const walk = (steps: unknown) => {
        for (const step of Array.isArray(steps) ? steps : []) {
            if (found) return;
            if (!step || typeof step !== 'object') continue;
            if (hit(step.datatableId) || hit(step.datatableKey) || hit(step.tableId)) { found = true; return; }
            walk(step.then); walk(step.else); walk(step.steps); walk(step.default);
            for (const c of Array.isArray(step.cases) ? step.cases : []) walk(c?.steps);
        }
    };
    walk(row?.definition?.steps);
    return found;
}

export function derivedAutomationRows({ app, automationRows, boundTableIds, wiredAutomationIds = null, t = EN_ONLY }: DerivedAutomationRowsArgs = {}) {
    const projectId = app?.projectId || null;
    if (!projectId) return [];
    const tables = asSet(boundTableIds);
    if (!tables.size) return [];
    const wired = asSet(wiredAutomationIds);
    const rows: LogicRow[] = [];
    for (const row of Object.values(automationRows || {})) {
        if (!belongsToApp(row, { projectId, tables, wired })) continue;
        rows.push(baseRow({
            key: `automation:${row.id}`,
            kind: 'automation',
            wired: true,
            automationId: row.id,
            actionKind: 'run_automation',
            when: triggerWhen(t, triggerKindOf(row)),
            what: row.title || t('app_studio.inspector.tile_unnamed', 'This automation'),
        }));
    }
    return rows;
}

/**
 * The save notices that concern THIS row.
 *
 * Matched on the definition path that the server sends along, not on the text: the sentence may be rewritten,
 * the path is the identity. A notice on the component itself (`screens[0]…children[2]`) belongs to every row of
 * that component; a notice on a deeper path (`…props.rowActions[1].actionId`) only to the row that is about
 * exactly that.
 */
export function noticesForRow(notices: SaveNotice[], row: { path: string }) {
    if (!Array.isArray(notices) || !row?.path) return [];
    return notices.filter((n) => matchNotice(row, n) !== null);
}

/**
 * How well does this notice belong to this row? → `null` if it does not belong to it at all.
 *
 * Three kinds of match, and the ranking afterwards is not the same:
 *   2 — the path is IDENTICAL. Always the best.
 *   1 — the notice sits DEEPER than the row (`…rowActions[1].actionId` under a component). The most SPECIFIC
 *       row wins: the longest path.
 *   0 — the notice sits HIGHER than the row (a notice about the component; the row is one of its surfaces).
 *       Then the FIRST row of that component wins, as the doc below promises — not the deepest, which happens
 *       to have the longest path.
 *
 * A DESCRIPTIVE ROW CATCHES ONLY ITSELF. "Screen is opened" carries the path of the SCREEN (`screens[0]`), and
 * that is an ancestor of every component on it. Without this exception a notice about a component that yields no
 * logic row at all (an input_text, a heading, an image) landed on that one row: the builder read "input_text
 * sits outside a form" under "When the screen is opened / 2 components load their data" and went looking for
 * the wrong component. Such notices belong to no row and stay in the save pill — exactly what the header of
 * assignNotices already claimed.
 */
function matchNotice(row: { path: string; descriptive?: boolean }, notice: SaveNotice) {
    const rowPath = typeof row?.path === 'string' ? row.path : '';
    const path = typeof notice?.path === 'string' ? notice.path : '';
    if (!rowPath || !path) return null;
    if (path === rowPath) return { tier: 2, len: rowPath.length };
    if (row.descriptive) return null;
    if (path.startsWith(`${rowPath}.`)) return { tier: 1, len: rowPath.length };
    if (rowPath.startsWith(`${path}.`)) return { tier: 0, len: 0 };
    return null;
}

/**
 * Every notice goes to EXACTLY ONE row, the most specific one.
 *
 * A component with two event slots and three row actions yields five rows, and `component.control_inert`
 * matches all five. Five times the same sentence under each other is not emphasis but noise, and it makes the
 * row that the notice really means unfindable. The longest matching path wins: a notice about
 * `…props.rowActions[1].actionId` belongs to that one row action, a notice about the component itself to its
 * first row.
 *
 * → Map from row key to notices. A notice that belongs to no row at all (app-wide paths such as `meta.name`)
 * drops out here and stays in the save pill, where it belongs.
 */
export function assignNotices(rows: { key: string; path: string; descriptive?: boolean }[], notices: SaveNotice[]) {
    const byRow = new Map<string, SaveNotice[]>();
    for (const notice of Array.isArray(notices) ? notices : []) {
        let best = null;
        let bestScore: { tier: number; len: number; } | null = null;
        for (const row of Array.isArray(rows) ? rows : []) {
            const score = matchNotice(row, notice);
            if (!score) continue;
            // Strikt groter: bij gelijke score wint de EERSTE rij in
            // leesvolgorde, en dat is wat tier 0 nodig heeft.
            if (!bestScore || score.tier > bestScore.tier
                || (score.tier === bestScore.tier && score.len > bestScore.len)) {
                best = row; bestScore = score;
            }
        }
        if (!best) continue;
        const list = byRow.get(best.key) || [];
        list.push(notice);
        byRow.set(best.key, list);
    }
    return byRow;
}

/**
 * How much WIRED logic this app carries — the number in the "Logic n" segment of the header (EditorHeader).
 *
 * It lives here and not in nodeLogicSummary, because the header and the tab would otherwise count different
 * things. That was so too: `countLogicMarks` counted only wired NODE_EVENTS, while this table has six action
 * surfaces besides. A data_grid whose logic all sits in `rowActions` + `toolbarActions` gave 0 — the segment
 * left the number out, the signal "nothing to see here", above a table with four rows. One source, and
 * `logicRows` is that source.
 *
 * What is NOT counted: the descriptive "screen opens" row (that is derived, not wired) and any unwired slot or
 * orphan (those stand in the table precisely because nothing is happening yet — they are not logic that someone
 * switched on).
 */
export function countWiredLogic(definition: AppDefinition | null) {
    return logicRows(definition).filter((row) => row.wired && !row.descriptive).length;
}
