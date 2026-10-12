/**
 * Which live run events end a run. Only these move what an automation's list row
 * shows (its last status and when it last ran, which the "Last run failed"
 * filter reads too); a run starting or a step moving does not. The server's
 * bus has no other terminal type (server/core/runEventBus.js).
 */

import type { RunEvent } from './types';

const SETTLED: ReadonlySet<string> = new Set(['run.finished', 'run.failed']);

export function isSettledRunEvent(event: Pick<RunEvent, 'type'>): boolean {
    return SETTLED.has(event.type);
}
