/**
 * "After another cowork": when a run of an item ends well, the owner's items that start after it run, each with the
 * title of the item before it and what its run produced (./eventRun.mts, kind 'after_cowork').
 *
 * A chain is at most MAX_CHAIN items long, and an item never starts again inside a chain it is already in, so two
 * items that follow each other cannot run each other forever. A chain is read back through the runs themselves: the
 * run an item started after names the run before it (`trigger_ref` 'after_cowork:<run id>').
 *
 * Heard through ./runEnded.mts: the Cowork runner says it when a run returns, the follow-up when a run that waited for
 * its owner's decision ends. `start()` is called from boot (boot/startupJobs.js): requiring this module starts nothing.
 */

import { createRequire } from 'node:module';
import type { RunOrigin, CoworkItem } from '../../stores/coworkStarts.mts';
import { runOnEvent, type CoworkEvent } from './eventRun.mts';
import { onRunEnded } from './runEnded.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

export const MAX_CHAIN = 5;
const REF_PREFIX = 'after_cowork:';

export interface AfterDeps {
    runOrigin: (runId: string) => Promise<RunOrigin | null>;
    listFollowers: (scheduleId: string, userId: string) => Promise<CoworkItem[]>;
    start: (item: CoworkItem, event: CoworkEvent) => Promise<boolean>;
}

const defaults = (): AfterDeps => {
    const starts = () => (nodeRequire('../../stores/coworkStarts.mts') as typeof import('../../stores/coworkStarts.mts')).coworkStarts();
    return {
        runOrigin: (id) => starts().runOrigin(id),
        listFollowers: (id, userId) => starts().listFollowers(id, userId),
        start: (item, event) => runOnEvent(item, event),
    };
};

/** The items of the chain that led to this run, this run's own first. */
export async function chainOf(origin: RunOrigin, deps: Pick<AfterDeps, 'runOrigin'>): Promise<string[]> {
    const ids = [origin.scheduleId];
    let current: RunOrigin | null = origin;
    while (current && ids.length <= MAX_CHAIN && current.triggerKind === 'after_cowork' && current.triggerRef?.startsWith(REF_PREFIX)) {
        current = await deps.runOrigin(current.triggerRef.slice(REF_PREFIX.length));
        if (current) ids.push(current.scheduleId);
    }
    return ids;
}

/** A run of `item` ended: start the items that follow it when it ended well. Answers how many started. */
export async function afterRunEnded(item: { id: string; userId: string; title?: string | null }, runId: string, deps: AfterDeps = defaults()): Promise<number> {
    const origin = await deps.runOrigin(runId);
    if (!origin || origin.status !== 'success' || origin.scheduleId !== item.id) return 0;
    const followers = await deps.listFollowers(item.id, item.userId);
    if (followers.length === 0) return 0;
    const chain = await chainOf(origin, deps);
    if (chain.length >= MAX_CHAIN) {
        log.warn(`[Cowork] a chain of ${chain.length} coworks ends at ${item.id}: its followers do not start`);
        return 0;
    }
    const title = item.title || 'Untitled work';
    let started = 0;
    for (const follower of followers) {
        if (chain.includes(follower.id)) {
            log.warn(`[Cowork] ${follower.id} is already in this chain: it does not start again`);
            continue;
        }
        const event: CoworkEvent = { kind: 'after_cowork', ref: runId, label: `the end of "${title}"`, data: { after: { title, result: origin.result } } };
        if (await deps.start(follower, event).catch((e: Error) => { log.warn(`[Cowork] ${follower.id} did not start after ${item.id}: ${e.message}`); return false; })) started += 1;
    }
    return started;
}

/** The same, for a caller that does not wait (the runner): failures are logged. */
export function afterRunEndedLater(item: { id: string; userId: string; title?: string | null }, runId: string | null): void {
    if (!runId) return;
    afterRunEnded(item, runId).catch((e: Error) => log.warn(`[Cowork] the followers of ${item.id} were not started: ${e.message}`));
}

let stopListening: (() => void) | null = null;

/** Hear the runs that end. A second start does nothing; answers whether this one started. */
export function start(): boolean {
    if (stopListening) return false;
    stopListening = onRunEnded((item, runId) => afterRunEndedLater(item, runId));
    return true;
}

/** Stop hearing them (shutdown, tests). */
export function stop(): void {
    stopListening?.();
    stopListening = null;
}
