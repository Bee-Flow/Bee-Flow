/**
 * buildScope(input): the expression-scope ROOT every formula evaluates
 * against, identical in shape on the phone, in the browser and on the server:
 *   { actions, form, forms, screen, vars, item, index, value, currentUser,
 *     records, datasets, connectors, now, today }
 * Port of buildScope in agent-hub AppStudio/runtime/RuntimeContext.jsx,
 * pinned by scope.lockstep.test.ts.
 *
 * One screen can read the same table (or connector) through several queries,
 * but a formula names only the table: every entry is exposed under its exact
 * cache key, and the SHORT name is awarded by rank (a plain `records` list
 * beats a `record` lookup, an unfiltered query beats a filtered one, the first
 * entry seen wins a tie). An aggregate never claims a table's short name.
 */

import { dataCacheKey, type ActionState, type DataEntry, type DataState } from './resolveBinding';

/** First claim wins the short scope name; a strictly better rank takes it over. */
function claimShortName(claimed: Record<string, number>, name: string, rank: number): boolean {
    if (Object.prototype.hasOwnProperty.call(claimed, name) && (claimed[name] as number) >= rank) return false;
    claimed[name] = rank;
    return true;
}

/** How strong a dataState entry's claim on its short scope name is. */
function shortNameRank(cacheKey: string, entry: DataEntry): number {
    if (entry.connectorId != null) {
        return cacheKey === dataCacheKey({ kind: 'connector', connectorId: entry.connectorId }) ? 1 : 0;
    }
    if (String(cacheKey).startsWith('aggregate:')) return 0;
    const kind = String(cacheKey).startsWith('record:') ? 'record' : 'records';
    return (kind === 'records' ? 2 : 0) + (cacheKey === dataCacheKey({ kind, tableId: entry.tableId }) ? 1 : 0);
}

export interface ScopeInput {
    actionState?: ActionState;
    dataState?: DataState;
    form?: Record<string, unknown>;
    forms?: Record<string, unknown>;
    screen?: Record<string, unknown>;
    vars?: Record<string, unknown>;
    currentUser?: Record<string, unknown> | null;
    item?: unknown;
    index?: unknown;
    value?: unknown;
    now?: string;
    today?: string;
}

export interface ScopeRoot extends Record<string, unknown> {
    actions: ActionState;
    form: Record<string, unknown>;
    forms: Record<string, unknown>;
    screen: Record<string, unknown>;
    vars: Record<string, unknown>;
    item: unknown;
    index: unknown;
    value: unknown;
    currentUser: Record<string, unknown> | null;
    records: Record<string, unknown>;
    datasets: Record<string, unknown>;
    connectors: Record<string, unknown>;
    now: string;
    today: string;
}

function dataRoots(dataState: DataState | undefined) {
    const records: Record<string, unknown> = {};
    const datasets: Record<string, unknown> = {};
    const connectors: Record<string, unknown> = {};
    const claimed: Record<string, number> = {};
    for (const [cacheKey, entry] of Object.entries(dataState || {})) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.connectorId != null) {
            connectors[cacheKey] = entry.result;
            const rank = shortNameRank(cacheKey, entry);
            if (claimShortName(claimed, `connector:${entry.connectorId}`, rank)) connectors[entry.connectorId] = entry.result;
        } else if (entry.datasetId != null) {
            datasets[entry.datasetId] = entry.result;
        } else if (entry.tableId != null) {
            records[cacheKey] = entry.result;
            if (claimShortName(claimed, `table:${entry.tableId}`, shortNameRank(cacheKey, entry))) records[entry.tableId] = entry.result;
        }
    }
    return { records, datasets, connectors };
}

/** now/today: pass them in to stamp once per render pass; omitted, they are stamped here. */
function stamps(input: ScopeInput): { now: string; today: string } {
    const now = typeof input.now === 'string' ? input.now : new Date().toISOString();
    return { now, today: typeof input.today === 'string' ? input.today : now.slice(0, 10) };
}

export function buildScope(input: ScopeInput = {}): ScopeRoot {
    const { actionState = {}, dataState = {}, form = {}, forms = {}, screen = {}, vars = {} } = input;
    return {
        actions: actionState || {},
        form: form || {},
        forms: forms || {},
        screen: screen || {},
        vars: vars || {},
        item: input.item,
        index: input.index,
        value: input.value,
        currentUser: input.currentUser || null,
        ...dataRoots(dataState),
        ...stamps(input),
    };
}
