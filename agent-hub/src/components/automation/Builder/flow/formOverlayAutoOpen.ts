/**
 * When should the builder open the form overlay by itself?
 *
 * A live run that reaches a `form_page` parks there until somebody answers.
 * Instead of sending the author to the public page in another tab, the builder
 * puts that page over the canvas. The decision lives here so it can be tested
 * without the whole shell.
 */

export interface AutoOpenInput {
    /** The run was started from THIS builder session as a live run (not a dry run / preview). */
    liveFromBuilder: boolean;
    /** The run the canvas is showing. */
    runId: string | null | undefined;
    /** The step currently parked on a form, or null when none is. */
    awaitingStepId: string | null | undefined;
    /** An overlay is already on screen. */
    overlayOpen: boolean;
    /** `${runId}:${stepId}` keys of pages the user closed the overlay on, and `${runId}:*` of whole runs. */
    dismissed: ReadonlySet<string>;
}

export function dismissKey(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
}

/**
 * The overlay was closed while this run was still going (RUN-11): it must not
 * pop up again when the run parks on its next page a moment later. The run
 * stays reachable from the canvas banner's "Open the form".
 */
export function runDismissKey(runId: string): string {
    return `${runId}:*`;
}

/** The overlay closed: the page on screen stays closed, and so does every run that was still going. */
export function recordDismissal(dismissed: Set<string>, closed: { runId: string | null; stepId: string | null; runIds?: readonly string[] | null }): void {
    if (closed.runId && closed.stepId) dismissed.add(dismissKey(closed.runId, closed.stepId));
    for (const id of Array.isArray(closed.runIds) ? closed.runIds : []) dismissed.add(runDismissKey(id));
}

/** True when the overlay should be opened, attached to `runId`. */
export function shouldAutoOpenFormOverlay(input: AutoOpenInput): boolean {
    const { liveFromBuilder, runId, awaitingStepId, overlayOpen, dismissed } = input;
    if (!liveFromBuilder || overlayOpen) return false;
    if (!runId || !awaitingStepId) return false;
    return !dismissed.has(runDismissKey(runId)) && !dismissed.has(dismissKey(runId, awaitingStepId));
}

/** The step id of the row parked on a form, if any. */
export function awaitingFormStepId(steps: ReadonlyArray<{ stepId?: string; status?: string } | null | undefined> | null | undefined): string | null {
    const row = (steps || []).find(r => r?.status === 'awaiting_form' && r?.stepId);
    return row?.stepId || null;
}
