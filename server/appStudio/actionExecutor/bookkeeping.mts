/**
 * App Studio action executor: the best-effort bookkeeping after a committed record write
 * (moved out of records.js). The row is already committed, so failed bookkeeping must never turn
 * the step red after all; each helper logs and goes on.
 *
 *   bumpVersion    the data version of an app table (a miss is a cache-staleness nuisance)
 *   bumpCount      the cached row count of an app table (recountRows on schema saves heals drift)
 *   bumpDatatable  row count + data version of a linked datatable (jobs/datatableRetention
 *                  recounts `row_count` authoritatively)
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type AppRef = { id: string; userId: string };
type DatatableBound = { datatable?: { id?: string } | null; scope?: unknown };

const log = nodeRequire('../../telemetry/log') as { warn(msg: string): void };
const dataStore = (): {
    bumpDataVersion(appId: string, tableKey: string, userId: string): Promise<unknown>;
    bumpRowCount(appId: string, tableKey: string, delta: number, userId: string): Promise<unknown>;
} => nodeRequire('../../stores/studioAppDataStore');

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function bumpDatatable(bound: DatatableBound, delta: number): Promise<void> {
    try {
        const datatableStore = nodeRequire('../../stores/datatableStore') as { bumpAfterWrite(id: unknown, scope: unknown, delta: number): Promise<unknown> };
        await datatableStore.bumpAfterWrite(bound.datatable?.id, bound.scope, delta);
    } catch (e) {
        log.warn(`[ActionExecutor] datatable bookkeeping failed for ${bound.datatable && bound.datatable.id}: ${messageOf(e)}`);
    }
}

export async function bumpVersion(app: AppRef, tableKey: string): Promise<void> {
    try {
        await dataStore().bumpDataVersion(app.id, tableKey, app.userId);
    } catch (e) {
        log.warn(`[ActionExecutor] data-version bump failed for ${app.id}/${tableKey}: ${messageOf(e)}`);
    }
}

export async function bumpCount(app: AppRef, tableKey: string, delta: number): Promise<void> {
    try {
        await dataStore().bumpRowCount(app.id, tableKey, delta, app.userId);
    } catch (e) {
        log.warn(`[ActionExecutor] row-count bump failed for ${app.id}/${tableKey}: ${messageOf(e)}`);
    }
}
