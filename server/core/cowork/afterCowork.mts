/**
 * "After another cowork": when a run of an item ends well, the items that start after it run, each with what its run
 * produced (./eventRun.mts, kind 'after_cowork'). The owner's own items, and, on a desk (stores/coworkDesks.mts), the
 * accepted items of the other owners on it that chose to start after this one, both owners counting in the desk's
 * organisation.
 *
 * A hand-off carries data, never access: the follower is a normal event run of ITS owner, with that owner's
 * connections and permissions, and it gets only the result text of the run before it, as outside text. Across owners
 * not even the title of the item before it goes along (the follower's owner did not write it).
 *
 * A chain is at most MAX_CHAIN items long, at most MAX_CROSS_OWNER of its hand-offs go from one owner to another, and
 * an item never starts again inside a chain it is already in, so items that follow each other cannot run each other
 * forever. A chain is read back through the runs themselves: the run an item started after names the run before it
 * (`trigger_ref` 'after_cowork:<run id>'), and each run names its owner.
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
/** Hand-offs from one owner to another in one chain (a desk's rule: a chain ends by itself). */
export const MAX_CROSS_OWNER = 3;
const REF_PREFIX = 'after_cowork:';

export interface AfterDeps {
    runOrigin: (runId: string) => Promise<RunOrigin | null>;
    listFollowers: (scheduleId: string, userId: string) => Promise<CoworkItem[]>;
    /** The followers on the item's desk, of any owner (stores/coworkDesks.mts deskFollowers). */
    listDeskFollowers?: (scheduleId: string) => Promise<CoworkItem[]>;
    start: (item: CoworkItem, event: CoworkEvent) => Promise<boolean>;
}

const defaults = (): AfterDeps => {
    const starts = () => (nodeRequire('../../stores/coworkStarts.mts') as typeof import('../../stores/coworkStarts.mts')).coworkStarts();
    return {
        runOrigin: (id) => starts().runOrigin(id),
        listFollowers: (id, userId) => starts().listFollowers(id, userId),
        listDeskFollowers: (id) => (nodeRequire('../../stores/coworkDesks.mts') as typeof import('../../stores/coworkDesks.mts')).coworkDesks().deskFollowers(id),
        start: (item, event) => runOnEvent(item, event),
    };
};

/** The runs of the chain that led to this run, this run's own first. */
async function chainRuns(origin: RunOrigin, deps: Pick<AfterDeps, 'runOrigin'>): Promise<RunOrigin[]> {
    const runs = [origin];
    let current: RunOrigin | null = origin;
    while (current && runs.length <= MAX_CHAIN && current.triggerKind === 'after_cowork' && current.triggerRef?.startsWith(REF_PREFIX)) {
        current = await deps.runOrigin(current.triggerRef.slice(REF_PREFIX.length));
        if (current) runs.push(current);
    }
    return runs;
}

/** The items of the chain that led to this run, this run's own first. */
export async function chainOf(origin: RunOrigin, deps: Pick<AfterDeps, 'runOrigin'>): Promise<string[]> {
    return (await chainRuns(origin, deps)).map((r) => r.scheduleId);
}

/** How many hand-offs of the chain went from one owner to another. */
export const crossings = (runs: RunOrigin[]): number => runs.slice(1).filter((r, i) => !!r.userId && !!runs[i].userId && r.userId !== runs[i].userId).length;

/** The owner's own followers and those on the item's desk, each once. */
async function followersOf(item: { id: string; userId: string }, deps: AfterDeps): Promise<CoworkItem[]> {
    const own = await deps.listFollowers(item.id, item.userId);
    const desk = deps.listDeskFollowers ? await deps.listDeskFollowers(item.id) : [];
    const ids = new Set(own.map((f) => f.id));
    return [...own, ...desk.filter((f) => !ids.has(f.id))];
}

/** The event a follower starts on: across owners only the result goes along. */
function eventFor(follower: CoworkItem, item: { userId: string; title?: string | null }, runId: string, result: string | null): CoworkEvent {
    if (follower.userId !== item.userId) return { kind: 'after_cowork', ref: runId, label: 'a hand-off from a cowork on your desk', data: { after: { result } } };
    const title = item.title || 'Untitled work';
    return { kind: 'after_cowork', ref: runId, label: `the end of "${title}"`, data: { after: { title, result } } };
}

/** May this follower start in this chain? Logged when it may not. */
function mayFollow(follower: CoworkItem, item: { id: string; userId: string }, chain: RunOrigin[]): boolean {
    if (follower.id === item.id || chain.some((r) => r.scheduleId === follower.id)) {
        log.warn(`[Cowork] ${follower.id} is already in this chain: it does not start again`);
        return false;
    }
    if (follower.userId !== item.userId && crossings(chain) >= MAX_CROSS_OWNER) {
        log.warn(`[Cowork] ${MAX_CROSS_OWNER} hand-offs between owners end the chain at ${item.id}: ${follower.id} does not start`);
        return false;
    }
    return true;
}

/** A run of `item` ended: start the items that follow it when it ended well. Answers how many started. */
export async function afterRunEnded(item: { id: string; userId: string; title?: string | null }, runId: string, deps: AfterDeps = defaults()): Promise<number> {
    const origin = await deps.runOrigin(runId);
    if (!origin || origin.status !== 'success' || origin.scheduleId !== item.id) return 0;
    const followers = await followersOf(item, deps);
    if (followers.length === 0) return 0;
    const chain = await chainRuns(origin, deps);
    if (chain.length >= MAX_CHAIN) {
        log.warn(`[Cowork] a chain of ${chain.length} coworks ends at ${item.id}: its followers do not start`);
        return 0;
    }
    let started = 0;
    for (const follower of followers) {
        if (!mayFollow(follower, item, chain)) continue;
        const event = eventFor(follower, item, runId, origin.result);
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
