import type { AppScreen, AppNode, CommonNodeProps } from '../inspector/appDefinition';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { AutomationRow } from './automationTitles';
import type { SaveNotice } from './saveNotices';
import type { NodeEntry, RowCommon } from './logicRows.types';
import { type Emitter } from './logicRows.types2';

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
export function triggerWhen(t: TranslateFn, kind: string) {
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

export function nodesOfScreen(screen: AppScreen, screenIndex: number): NodeEntry[] {
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

/**
 * The six action surfaces alongside the events: four lists plus addRowActionId and columns[].actionId. This is
 * the list from collectReferencedActions (server/appStudio/validate/nodes.js); the role gate and the old view
 * knew only part of it.
 *
 * An empty actionId in a list is the inspector's own "not wired yet" state — validate/nodes.js allows it
 * explicitly — so it counts as unwired and not as broken.
 */
export function emitSurfaceRows(node: AppNode, common: RowCommon, emit: Emitter, t: TranslateFn) {
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

/** A Set of what comes in: a Set stays itself, a list becomes one. */
export function asSet(value: Set<string> | string[] | null | undefined): Set<string> {
    if (value instanceof Set) return value;
    return new Set(Array.isArray(value) ? value : []);
}

/** The trigger type of a routine, as AutomationPicker also reads it. */
export function triggerKindOf(row: AutomationRow) {
    return row?.definition?.trigger?.kind || row?.triggerType || 'manual';
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
export function matchNotice(row: { path: string; descriptive?: boolean }, notice: SaveNotice) {
    const rowPath = typeof row?.path === 'string' ? row.path : '';
    const path = typeof notice?.path === 'string' ? notice.path : '';
    if (!rowPath || !path) return null;
    if (path === rowPath) return { tier: 2, len: rowPath.length };
    if (row.descriptive) return null;
    if (path.startsWith(`${rowPath}.`)) return { tier: 1, len: rowPath.length };
    if (rowPath.startsWith(`${path}.`)) return { tier: 0, len: 0 };
    return null;
}
