/**
 * An app action's run as its button shows it (server/routes/studioAppsRun.js).
 * The POST answers once: 200 with the run's end, or 202 `{ runId, status:
 * 'pending' }` when the run outlasts the wait. A 202's run is then polled
 * until an answer says it has stopped, and that answer is what the button
 * shows: the 202 said "pending" once and never changes, which is how the
 * button used to spin on for good after the run had finished or failed.
 */

import type { AppActionResult } from './types';

/**
 * The statuses the web's runner keeps polling through (useActionRunner.js
 * pollRun, pinned by actionRun.test.ts). A run paused on an approval or a form
 * has stopped for this button too: someone else decides when it goes on.
 */
export const GOING_STATUSES: readonly string[] = ['pending', 'running', 'queued'];

const isGoing = (result: AppActionResult | null | undefined): boolean => GOING_STATUSES.includes(String(result?.status));

/** The run to poll: the one the POST left going, when it named it. */
export function pollRunId(result: AppActionResult | null): string | null {
    return result?.runId && isGoing(result) ? result.runId : null;
}

/** Whether a poll goes on: it has not failed, and has no answer yet or its last one says the run is going. */
export function keepPolling(data: AppActionResult | null | undefined, failed: boolean): boolean {
    return !failed && (data === undefined || isGoing(data));
}

/**
 * What the button shows, and whether it still spins: the poll's answer as
 * soon as there is one, spinning only while the poll goes on. A failed poll
 * stops the spinner; the runner shows why instead.
 */
export function runView(
    result: AppActionResult | null,
    poll: { data: AppActionResult | null | undefined; failed: boolean },
): { shown: AppActionResult | null; going: boolean } {
    if (!pollRunId(result)) return { shown: result, going: false };
    return { shown: poll.data ?? result, going: keepPolling(poll.data, poll.failed) };
}
