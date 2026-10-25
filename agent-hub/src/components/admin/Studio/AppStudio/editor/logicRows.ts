import { eventText } from './nodeLogicSummary';
import { nOf } from '../../KnowledgeStudio/plural';
import { TYPE_EVENT_LISTS } from '../inspector/styleKnobMeta';
import { NODE_EVENTS } from '../state/definitionOps';
import type { AppDefinition, AppScreen, AppNode } from '../inspector/appDefinition';
import type { TranslateFn, TranslateParams } from '../../../../../hooks/useTranslation';
import type { AutomationRow } from './automationTitles';
import type { SaveNotice } from './saveNotices';
import type { NodeEntry, RowCommon, LogicRow, LogicRowsOptions, DerivedAutomationRowsArgs } from './logicRows.types';
import { actionsOf, whatOf, baseRow, makeEmitter, type Emitter } from './logicRows.types2';
import { triggerWhen, nodesOfScreen, emitSurfaceRows, asSet, triggerKindOf, matchNotice } from './logicRows.helpers';
;

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

function emitEventRows(node: AppNode, common: RowCommon, emit: Emitter, t: TranslateFn) {
    for (const event of eventSlotsOf(node)) {
        const raw = node[event];
        const actionId = typeof raw === 'string' && raw ? raw : null;
        const row = { ...common, key: `${node.id}:${event}`, event, when: eventText(t, event) };
        if (actionId) emit.wired(row, actionId);
        else emit.plain(row);
    }
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
