/**
 * "When rows of a table change": the owner's items that start on a datatable run once per change of its rows
 * (./eventRun.mts, kind 'row'). The change itself is the storage layer's debounced signal
 * (stores/datatableStore/liveChanges.js): a burst of writes is one change, and its version makes it one event.
 *
 * The run gets which table and which version; it reads the rows itself, through its own plan or agent, so what it may
 * read is still decided by the table's sharing. An owner who can no longer read the table starts nothing.
 */

import { createRequire } from 'node:module';
import type { CoworkItem } from '../../stores/coworkStarts.mts';
import { runOnEvent, type CoworkEvent } from './eventRun.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { warn: (m: string) => void };
const { fallback } = nodeRequire('../../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

export interface TableStartDeps {
    listTableStarters: (datatableId: string) => Promise<CoworkItem[]>;
    dataVersion: (datatableId: string) => Promise<number | string | null>;
    canRead: (userId: string, datatableId: string) => Promise<boolean>;
    start: (item: CoworkItem, event: CoworkEvent) => Promise<boolean>;
}

type Defs = { resolveAsker: (userId: string, deps: unknown) => Promise<unknown>; resolveForAsker: (id: string, asker: unknown, deps: unknown) => Promise<unknown>; _deps: unknown };

/** Can this person read the table now, through its own sharing (the same check a datatable step makes)? */
export async function ownerCanRead(userId: string, datatableId: string): Promise<boolean> {
    const defs = nodeRequire('../tools/datatableToolDefs.js') as Defs;
    try {
        await defs.resolveForAsker(datatableId, await defs.resolveAsker(userId, defs._deps), defs._deps);
        return true;
    } catch (e) {
        return fallback('core/cowork/tableStart:ownerCanRead', e, false);
    }
}

const defaults = (): TableStartDeps => ({
    listTableStarters: (id) => (nodeRequire('../../stores/coworkStarts.mts') as typeof import('../../stores/coworkStarts.mts')).coworkStarts().listTableStarters(id),
    dataVersion: (id) => (nodeRequire('../../stores/datatableStore/liveChanges.js') as { getDataVersion: (id: string) => Promise<number | null> }).getDataVersion(id),
    canRead: ownerCanRead,
    start: (item, event) => runOnEvent(item, event),
});

/** One change of a table's rows: start the items that start on it. Answers how many started. */
export async function onTableChanged(datatableId: string, deps: TableStartDeps = defaults()): Promise<number> {
    const items = await deps.listTableStarters(datatableId);
    if (items.length === 0) return 0;
    const version = await deps.dataVersion(datatableId);
    if (version === null || version === undefined) return 0;
    let started = 0;
    for (const item of items) {
        if (!(await deps.canRead(item.userId, datatableId))) {
            log.warn(`[Cowork] ${item.id} starts on a table its owner can no longer read; nothing runs`);
            continue;
        }
        const event: CoworkEvent = { kind: 'row', ref: `${datatableId}:${version}`, label: 'a change in a table', data: { table: { id: datatableId, version } } };
        if (await deps.start(item, event).catch((e: Error) => { log.warn(`[Cowork] ${item.id} did not start on its table: ${e.message}`); return false; })) started += 1;
    }
    return started;
}
