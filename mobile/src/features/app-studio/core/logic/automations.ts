/**
 * "Your automations in this solution" and the save notices per row: the second
 * half of agent-hub AppStudio/editor/logicRows.js (pinned by
 * logicRows.lockstep.test.ts).
 *
 * The automation list is DERIVED from what is already true (the app's project
 * and the tables its definition binds), never stored: an automation belongs when
 * it is in the same solution, is not already wired to a control, and touches
 * a bound table. An app without a solution lists none.
 */

import { EN_ONLY, type Translate } from '../msg';
import { baseRow, type LogicRow } from './rows';

type Row = Record<string, unknown> & {
    id?: unknown;
    projectId?: unknown;
    title?: unknown;
    triggerType?: unknown;
    definition?: { trigger?: { kind?: unknown; filter?: { tableId?: unknown } }; steps?: unknown };
};

function triggerWhen(t: Translate, kind: unknown): string {
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

const asSet = (value: unknown): Set<unknown> => (value instanceof Set ? value : new Set(Array.isArray(value) ? value : []));
const triggerKindOf = (row: Row) => row?.definition?.trigger?.kind || row?.triggerType || 'manual';

/** Does this automation touch one of these tables (trigger filter, or any step at any depth)? */
export function automationTouchesTables(row: Row | null | undefined, tableIds: unknown): boolean {
    if (!(tableIds instanceof Set) || tableIds.size === 0) return false;
    const hit = (v: unknown) => typeof v === 'string' && !!v && tableIds.has(v);
    if (hit(row?.definition?.trigger?.filter?.tableId)) return true;
    const walk = (steps: unknown): boolean =>
        (Array.isArray(steps) ? steps : []).some((step) => {
            if (!step || typeof step !== 'object') return false;
            const s = step as Record<string, unknown>;
            if (hit(s.datatableId) || hit(s.datatableKey) || hit(s.tableId)) return true;
            if (walk(s.then) || walk(s.else) || walk(s.steps) || walk(s.default)) return true;
            return (Array.isArray(s.cases) ? s.cases : []).some((c) => walk((c as { steps?: unknown } | null)?.steps));
        });
    return walk(row?.definition?.steps);
}

export interface AutomationRowsArgs {
    app?: { projectId?: unknown } | null;
    automationRows?: Record<string, Row> | null;
    boundTableIds?: unknown;
    wiredAutomationIds?: unknown;
    t?: Translate;
}

/** The viewer's automations in the app's solution that touch its bound tables and are not wired yet. */
export function derivedAutomationRows({ app, automationRows, boundTableIds, wiredAutomationIds = null, t = EN_ONLY }: AutomationRowsArgs = {}): LogicRow[] {
    const projectId = app?.projectId || null;
    if (!projectId) return [];
    const tables = asSet(boundTableIds);
    if (!tables.size) return [];
    const wired = asSet(wiredAutomationIds);
    return Object.values(automationRows || {})
        .filter((row) => !!row?.id && row.projectId === projectId && !wired.has(row.id) && automationTouchesTables(row, tables))
        .map((row) => automationRow(row, t));
}

function automationRow(row: Row, t: Translate): LogicRow {
    return baseRow({
        key: `automation:${row.id}`,
        kind: 'automation',
        wired: true,
        automationId: row.id as string,
        actionKind: 'run_automation',
        when: triggerWhen(t, triggerKindOf(row)),
        what: (row.title as string) || t('app_studio.inspector.tile_unnamed', 'This automation'),
    });
}

export interface Notice {
    path?: unknown;
    [key: string]: unknown;
}

/**
 * How well a notice belongs to a row, or null: 2 the path is identical,
 * 1 the notice is deeper than the row (the longest row path wins), 0 the
 * notice is above the row (the first row of that component wins). A
 * descriptive row only catches its own path.
 */
function matchNotice(row: Pick<LogicRow, 'path' | 'descriptive'> | null | undefined, notice: Notice | null | undefined) {
    const rowPath = typeof row?.path === 'string' ? row.path : '';
    const path = typeof notice?.path === 'string' ? notice.path : '';
    if (!rowPath || !path) return null;
    if (path === rowPath) return { tier: 2, len: rowPath.length };
    if (row?.descriptive) return null;
    if (path.startsWith(`${rowPath}.`)) return { tier: 1, len: rowPath.length };
    if (rowPath.startsWith(`${path}.`)) return { tier: 0, len: 0 };
    return null;
}

/** The save notices about THIS row, matched by definition path. */
export function noticesForRow(notices: unknown, row: LogicRow | null | undefined): Notice[] {
    if (!Array.isArray(notices) || !row?.path) return [];
    return (notices as Notice[]).filter((n) => matchNotice(row, n) !== null);
}

/** Each notice to exactly ONE row, the most specific; a notice matching none stays out. */
export function assignNotices(rows: unknown, notices: unknown): Map<string, Notice[]> {
    const byRow = new Map<string, Notice[]>();
    for (const notice of Array.isArray(notices) ? (notices as Notice[]) : []) {
        let best: LogicRow | null = null;
        let bestScore: { tier: number; len: number } | null = null;
        for (const row of Array.isArray(rows) ? (rows as LogicRow[]) : []) {
            const score = matchNotice(row, notice);
            if (!score) continue;
            const better = !bestScore || score.tier > bestScore.tier || (score.tier === bestScore.tier && score.len > bestScore.len);
            if (better) {
                best = row;
                bestScore = score;
            }
        }
        if (!best) continue;
        byRow.set(best.key, [...(byRow.get(best.key) || []), notice]);
    }
    return byRow;
}
