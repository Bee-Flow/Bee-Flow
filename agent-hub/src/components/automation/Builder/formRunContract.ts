/**
 * The contract between the builder shell and the form test overlay
 * (FormRunOverlay). The shell owns starting and following runs; the overlay
 * shows the pages and asks for them.
 *
 *   onStartRun(answers, { mode })  start a run with the answers as the trigger
 *                                  payload: 'dry' simulates every write and
 *                                  pauses for real at forms and approvals;
 *                                  'live' runs for real behind the confirm the
 *                                  shell asks once per overlay session.
 *   onFollowRun(runId)             the canvas follows that run (or the
 *                                  continuation of a journey) by its id.
 *   onClose(info)                  the overlay closed; `dismissRunIds` are the
 *                                  runs it was following while they still ran,
 *                                  so the shell must not open it again by itself
 *                                  when one of them parks on a page (RUN-11).
 *
 * A start answers with what happened, never with "done": a run that started
 * is followed by id until it pauses or ends, so the overlay must not claim a
 * finish it has not seen.
 */

import type { FormDef } from '../../forms/PublicFormRenderer.types';

export type FormRunMode = 'dry' | 'live';

export type FormRunStartResult =
    /** Nothing started: the person said no to a confirm, or another run is still going. */
    | { kind: 'declined'; runId?: undefined; message?: string }
    /** Nothing to run: the server skipped the start, or the automation could not be created. */
    | { kind: 'skipped'; runId?: undefined; message?: string }
    /** The run exists; follow it by this id. */
    | { kind: 'started'; runId: string; message?: string };

export type FormRunStart = (answers: Record<string, unknown>, opts: { mode: FormRunMode }) => Promise<FormRunStartResult>;

export type FormRunFollow = (runId: string) => void;

/** The form test overlay while it is open: page one of a trigger, or attached to a run. */
export interface FormTestSession {
    form?: FormDef;
    triggerStepId?: string | null;
    /** Attach mode: the run that is already going (or parked on a page). */
    runId?: string | null;
    /** What Submit starts; Dry run unless the session was opened from Run live. */
    mode?: FormRunMode;
    /** The Run live confirm was answered yes in this session. */
    liveConfirmed?: boolean;
}

/** Who a test run is, as the overlay's chip says it: a dry run, a live test, or a production run (no chip). */
export type FormRunKind = FormRunMode | 'production';

/** What the overlay hands the shell when it closes. */
export interface FormRunCloseInfo {
    /** Runs that were still going when the overlay closed: no auto-open for them any more. */
    dismissRunIds?: string[];
}

export type FormRunClose = (info?: FormRunCloseInfo) => void;

/**
 * Props the builder shell (build/BuildCanvas.tsx) hands the overlay besides
 * the session: `triggerStepId` names the form trigger of page one, so an
 * upload on a second form trigger is checked against that trigger's own
 * questions (POST /:id/form-test/upload). Left out, the primary trigger.
 */
export interface FormRunShellProps {
    triggerStepId?: string | null;
}
