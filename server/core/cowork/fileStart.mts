/**
 * "When a new file arrives in a folder": the Nextcloud file.new event of an item's own subscription
 * (automation/subscriptionSync.js syncCoworkFileTrigger, polled like an automation's) starts the item
 * (./eventRun.mts, kind 'file') with the file's name, path and id. The subscription belongs to the item's owner, so
 * the poller only sees files the owner can see; what the run does with the file is its plan's or its agent's.
 */

import { createRequire } from 'node:module';
import { runOnEvent, type CoworkEvent } from './eventRun.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { info: (m: string) => void };

interface Sub { coworkScheduleId?: string | null; userId?: string | null }
interface Item { id: string; userId: string; isActive?: boolean | null; triggerKind?: string | null; planId?: string | null; agentId?: string | null; prompt?: string | null }

export interface FileStartDeps {
    getSchedule: (id: string) => Promise<Item | null>;
    start: (item: Item, event: CoworkEvent) => Promise<boolean>;
}

const defaults = (): FileStartDeps => ({
    getSchedule: (id) => (nodeRequire('../../stores/coworkStore.js') as { getSchedule: FileStartDeps['getSchedule'] }).getSchedule(id),
    start: (item, event) => runOnEvent(item, event),
});

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One file.new event of a Cowork-owned subscription (automation/triggerBus/dispatch.js). */
export async function runForEvent(sub: Sub, payload: Record<string, unknown>, deps: FileStartDeps = defaults()): Promise<boolean> {
    if (!sub.coworkScheduleId) return false;
    const item = await deps.getSchedule(sub.coworkScheduleId);
    if (!item || item.userId !== sub.userId) { log.info(`[Cowork] file event for ${sub.coworkScheduleId}: the item is gone or not the subscriber's`); return false; }
    const path = text(payload.path);
    const id = text(payload.id) || text(payload.fileId) || path;
    if (!id) return false;
    const name = text(payload.name) || path.split('/').filter(Boolean).at(-1) || '';
    return deps.start(item, { kind: 'file', ref: id, label: 'a new file in a folder', data: { file: { id, name, path } } });
}
