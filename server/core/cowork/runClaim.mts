/**
 * The claim of one attempt of a Cowork run, shared by its two run modes (core/aiTaskRunner.js for a plain prompt,
 * ./agentScheduleRun.js for a run as an agent).
 *
 * The store's markRunning is the claim (stores/coworkStore.js): it flips the schedule to 'running' and opens the
 * history row in one guarded statement, and answers NULL when another attempt holds the schedule or, for the
 * scheduler tick (`due`), the moment was already run and moved on. Null is not a failure: nothing ran here, and
 * whoever claimed the schedule reports the outcome. So a run asks first, and stops quietly on null.
 *
 * Only null refuses. A store that answers nothing at all (a test fake, a store without history) is a claim without a
 * row id, as it always was.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { info: (msg: string) => void };

export interface ClaimStore {
    markRunning: (id: string, opts: { triggerKind: string; due: boolean }) => Promise<unknown>;
}

/** A claimed attempt: the id of the history row it opened, when the store hands one back. */
export interface Attempt { runId: string | null }

/** The id of the row a claim opened: a string id, or a row with one. */
function runIdOf(opened: unknown): string | null {
    if (typeof opened === 'string' && opened) return opened;
    const id = opened && typeof opened === 'object' ? (opened as { id?: unknown }).id : null;
    return typeof id === 'string' && id ? id : null;
}

/**
 * Claim this attempt, or answer null when it was refused.
 *
 * `manual`: a person pressed Run now (the claim then does not ask for a due schedule).
 * `due`: the scheduler tick started this for a due moment.
 */
export async function claimAttempt(
    store: ClaimStore,
    task: { id: string },
    { manual = false, due = false }: { manual?: boolean; due?: boolean } = {},
): Promise<Attempt | null> {
    const claimed = await store.markRunning(task.id, { triggerKind: manual ? 'manual' : 'schedule', due });
    if (claimed === null) {
        log.info(`[AITaskRunner] ${task.id} was not claimed (already running, or no longer due); skipped`);
        return null;
    }
    return { runId: runIdOf(claimed) };
}
