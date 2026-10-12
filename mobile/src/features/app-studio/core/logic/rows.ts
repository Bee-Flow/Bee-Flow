/**
 * The rows of the Logic tab: one table, across every screen, of "when" x
 * "what happens then". Port of the row-building half of agent-hub
 * AppStudio/editor/logicRows.js (pinned by logicRows.lockstep.test.ts).
 *
 * EVERYTHING goes in, and each row says whether it is wired: an event slot a
 * component may carry but that hangs on nothing, the six action surfaces
 * besides events (rowActions, itemActions, bulkActions, toolbarActions,
 * props.addRowActionId, props.columns[].actionId) and an action nothing
 * points at (server-side an `action.unreachable` warning). Silently leaving
 * one out is the failure this table exists to prevent.
 */

import { EN_ONLY, type Translate } from '../msg';
import { NODE_ACTION_LISTS } from '../ops';
import type { AppDefinition, AppNode, AppScreen } from '../types';
import { describeAction } from './describeAction';
import { eventSlotsOf, eventText, nOf } from './events';

export type TitleFor = ((automationId: unknown) => string | null | undefined) | null;

export interface LogicRow {
    key: string;
    kind: 'event' | 'screen_open' | 'orphan_action' | 'automation';
    wired: boolean;
    screenId: string | null;
    screenName: string;
    nodeId: string | null;
    nodeType: string | null;
    event: string | null;
    surface: string | null;
    surfaceLabel: string | null;
    actionId: string | null;
    actionKind: string | null;
    automationId: string | null;
    path: string;
    descriptive: boolean;
    when?: string;
    what?: string;
    loaderCount?: number;
    tableIds?: string[];
}

export function baseRow(extra: Partial<LogicRow> & { key: string }): LogicRow {
    return {
        kind: 'event', wired: true, screenId: null, screenName: '', nodeId: null, nodeType: null, event: null,
        surface: null, surfaceLabel: null, actionId: null, actionKind: null, automationId: null, path: '',
        descriptive: false, ...extra,
    };
}

function surfaceWhen(t: Translate, surface: string): string {
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

/** Every string `tableId` bound anywhere under `root`: an object with one IS a table binding. */
export function collectBoundTableIds(root: unknown): Set<string> {
    const ids = new Set<string>();
    const seen = new Set<unknown>();
    const walk = (value: unknown) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        const obj = value as Record<string, unknown>;
        if (typeof obj.tableId === 'string' && obj.tableId) ids.add(obj.tableId);
        for (const key of Object.keys(obj)) if (key !== 'tableId') walk(obj[key]);
    };
    walk(root);
    return ids;
}

interface PathedNode {
    node: AppNode;
    path: string;
}

/** A screen's components, flat, each with its definition path. */
function nodesOfScreen(screen: AppScreen, screenIndex: number): PathedNode[] {
    const out: PathedNode[] = [];
    const walk = (node: AppNode, path: string) => {
        if (!node || typeof node !== 'object') return;
        out.push({ node, path });
        (Array.isArray(node.children) ? node.children : []).forEach((child, i) => walk(child, `${path}.children[${i}]`));
    };
    (Array.isArray(screen?.sections) ? screen.sections : []).forEach((section, s) => {
        (Array.isArray(section?.children) ? section.children : []).forEach((child, c) => {
            walk(child, `screens[${screenIndex}].sections[${s}].children[${c}]`);
        });
    });
    return out;
}

export const actionsOf = (definition: AppDefinition | null | undefined) =>
    definition?.actions && typeof definition.actions === 'object' ? definition.actions : {};

interface Ctx {
    definition: AppDefinition | null | undefined;
    titleFor: TitleFor;
    t: Translate;
    rows: LogicRow[];
    referenced: Set<string>;
}

/** What is behind an action id, or that nothing is. */
export function whatOf(ctx: Pick<Ctx, 'definition' | 'titleFor' | 't'>, actionId: string): string {
    const action = actionsOf(ctx.definition)[actionId];
    if (!action) return ctx.t('app_studio.canvas.mark_missing_action', 'points at an action that no longer exists');
    return describeAction(actionId, action, ctx.definition, { titleFor: ctx.titleFor, t: ctx.t });
}

type RowSeed = Partial<LogicRow> & { key: string };

function emitPlain(ctx: Ctx, row: RowSeed): void {
    ctx.rows.push(baseRow({ ...row, wired: false, what: ctx.t('app_studio.logic.no_action_yet', 'No action yet') }));
}

function emitWired(ctx: Ctx, row: RowSeed, actionId: string): void {
    const action = actionsOf(ctx.definition)[actionId];
    ctx.referenced.add(actionId);
    ctx.rows.push(baseRow({
        ...row,
        wired: true,
        actionId,
        actionKind: action?.kind || null,
        automationId: action?.kind === 'run_automation' ? ((action.automationId as string) || null) : null,
        what: whatOf(ctx, actionId),
    }));
}

/** The descriptive "screen opens" row, derived from the data bindings (there is no such event). */
function screenOpenRow(t: Translate, screen: AppScreen, screenIndex: number, nodes: PathedNode[]): LogicRow | null {
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
        what: nOf(t, 'app_studio.logic.screen_loads', loaders.length, {
            one: '{count} component loads its data',
            many: '{count} components load their data',
        }),
        loaderCount: loaders.length,
        tableIds: [...tables],
    });
}

type Common = Pick<LogicRow, 'screenId' | 'screenName' | 'nodeId' | 'nodeType' | 'path'>;

function emitEventRows(ctx: Ctx, node: AppNode, common: Common): void {
    for (const event of eventSlotsOf(node)) {
        const wired = node[event];
        const row = { ...common, key: `${node.id}:${event}`, event, when: eventText(ctx.t, event) };
        if (typeof wired === 'string' && wired) emitWired(ctx, row, wired);
        else emitPlain(ctx, row);
    }
}

/** A row or column action's own label, or null. */
function labelOf(entry: { label?: unknown } | null | undefined): string | null {
    return typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
}

type Entry = { actionId?: unknown; label?: unknown };

function emitSurfaceRows(ctx: Ctx, node: AppNode, common: Common): void {
    const props = (node.props && typeof node.props === 'object' ? node.props : {}) as Record<string, unknown>;
    const { path } = common;
    for (const listKey of NODE_ACTION_LISTS) {
        (Array.isArray(props[listKey]) ? (props[listKey] as unknown[]) : []).forEach((raw, i) => {
            if (!raw || typeof raw !== 'object') return;
            const entry = raw as Entry;
            const row = {
                ...common,
                key: `${node.id}:${listKey}[${i}]`,
                surface: listKey,
                surfaceLabel: labelOf(entry),
                path: `${path}.props.${listKey}[${i}].actionId`,
                when: surfaceWhen(ctx.t, listKey),
            };
            if (typeof entry.actionId === 'string' && entry.actionId) emitWired(ctx, row, entry.actionId);
            else emitPlain(ctx, row);
        });
    }
    if (typeof props.addRowActionId === 'string' && props.addRowActionId) {
        emitWired(ctx, {
            ...common,
            key: `${node.id}:addRowActionId`,
            surface: 'addRowActionId',
            path: `${path}.props.addRowActionId`,
            when: surfaceWhen(ctx.t, 'addRowActionId'),
        }, props.addRowActionId);
    }
    (Array.isArray(props.columns) ? (props.columns as unknown[]) : []).forEach((raw, i) => {
        const col = raw as Entry | null;
        if (!col || typeof col !== 'object' || typeof col.actionId !== 'string' || !col.actionId) return;
        emitWired(ctx, {
            ...common,
            key: `${node.id}:columns[${i}]`,
            surface: 'columnAction',
            surfaceLabel: labelOf(col),
            path: `${path}.props.columns[${i}].actionId`,
            when: surfaceWhen(ctx.t, 'columnAction'),
        }, col.actionId);
    });
}

function emitOrphans(ctx: Ctx): void {
    for (const [actionId, action] of Object.entries(actionsOf(ctx.definition))) {
        if (ctx.referenced.has(actionId)) continue;
        ctx.rows.push(baseRow({
            key: `orphan:${actionId}`,
            kind: 'orphan_action',
            wired: false,
            actionId,
            actionKind: action?.kind || null,
            automationId: action?.kind === 'run_automation' ? ((action.automationId as string) || null) : null,
            path: `actions.${actionId}`,
            when: ctx.t('app_studio.logic.when_nothing', 'Nothing starts this yet'),
            what: whatOf(ctx, actionId),
        }));
    }
}

/** Every row for the table, in reading order: per screen, the opener, then components in canvas order. */
export function logicRows(
    definition: AppDefinition | null | undefined,
    { titleFor = null, t = EN_ONLY }: { titleFor?: TitleFor; t?: Translate } = {},
): LogicRow[] {
    const ctx: Ctx = { definition, titleFor, t, rows: [], referenced: new Set() };
    (Array.isArray(definition?.screens) ? definition.screens : []).forEach((screen, screenIndex) => {
        const nodes = nodesOfScreen(screen, screenIndex);
        const opener = screenOpenRow(t, screen, screenIndex, nodes);
        if (opener) ctx.rows.push(opener);
        for (const { node, path } of nodes) {
            const common: Common = {
                screenId: screen.id,
                screenName: screen.name || '',
                nodeId: node.id || null,
                nodeType: node.type || null,
                path,
            };
            emitEventRows(ctx, node, common);
            emitSurfaceRows(ctx, node, common);
        }
    });
    emitOrphans(ctx);
    return ctx.rows;
}

/** How much WIRED logic the app carries: the "Logic n" count (descriptive rows excluded). */
export function countWiredLogic(definition: AppDefinition | null | undefined): number {
    return logicRows(definition).filter((row) => row.wired && !row.descriptive).length;
}
