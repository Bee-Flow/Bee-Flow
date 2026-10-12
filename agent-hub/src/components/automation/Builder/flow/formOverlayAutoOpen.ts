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
    /** `${runId}:${stepId}` keys the user closed the overlay on. */
    dismissed: ReadonlySet<string>;
}

export function dismissKey(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
}

/** True when the overlay should be opened, attached to `runId`. */
export function shouldAutoOpenFormOverlay(input: AutoOpenInput): boolean {
    const { liveFromBuilder, runId, awaitingStepId, overlayOpen, dismissed } = input;
    if (!liveFromBuilder || overlayOpen) return false;
    if (!runId || !awaitingStepId) return false;
    return !dismissed.has(dismissKey(runId, awaitingStepId));
}

/** The step id of the row parked on a form, if any. */
export function awaitingFormStepId(steps: ReadonlyArray<{ stepId?: string; status?: string } | null | undefined> | null | undefined): string | null {
    const row = (steps || []).find(r => r?.status === 'awaiting_form' && r?.stepId);
    return row?.stepId || null;
}
