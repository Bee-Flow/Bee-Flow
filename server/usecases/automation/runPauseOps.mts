/**
 * The pauses a person ends or continues from the builder and the run views,
 * for routes/automation/webhooksAndRunOps.js:
 *
 *   pendingFormPage       the page a run waits on, as the runner rendered it
 *   formJourneyExtras     GET /runs/:runId/form's approval or closing page
 *   refusePublicJourney   POST /runs/:runId/form never answers a real visitor's page
 *   finaliseContinuedRun  the answered leg closes the moment its child exists
 *   closeFormWait         POST /runs/:runId/cancel on a run waiting on a form page
 *   addRunViewFacts       GET /runs/:id's profile, versionBehind, canDecide, waitingOn
 *
 * Every write that ends a pause emits its run event (runEventBus.emitRunClosed),
 * so a list that refreshes on events never keeps a closed run "waiting"
 * (run-watch F10).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, any>;
type Session = { user?: { id?: string; isAdmin?: boolean } } | null | undefined;

// The store is untyped JavaScript.
const store = (): Record<string, (...a: any[]) => Promise<any>> => nodeRequire('../../stores/automationStore');
const facts = () => nodeRequire('../../automation/pausedRunFacts.mts') as typeof import('../../automation/pausedRunFacts.mts');
const { fallback, bestEffort } = nodeRequire('../../utils/bestEffort') as {
    fallback: <T>(where: string, e: unknown, value: T) => T;
    bestEffort: (where: string, e: unknown) => void;
};
const emitRunClosed = (run: Row, end: { status: string; summary?: string; continuedBy?: string }): void => {
    (nodeRequire('../../core/runEventBus') as { emitRunClosed: (r: Row, e: object) => void }).emitRunClosed(run, end);
};

const FINISHED_STATUSES = new Set(['success', 'error', 'cancelled']);
export const FORM_WAIT_CLOSED = 'Closed without an answer';

/** The rendered page a run is paused on, read off the awaiting step's row. */
export async function pendingFormPage(run: Row | null | undefined): Promise<{ stepId: string; form: Row } | null> {
    if (!run || run.status !== 'awaiting_form' || !run.awaitingStepId) return null;
    const steps: Row[] = await store().getRunSteps(run.id).catch((e: unknown) => fallback('usecases/automation/runPauseOps:pendingFormPage', e, []));
    const row = steps.find(st => st.stepId === run.awaitingStepId && st.status === 'awaiting_form');
    // The runner records the page AS RENDERED — labels interpolated against the
    // run that produced them. Reading it back is what makes the builder's
    // overlay show the same words the visitor would see, without this route
    // having to re-run an interpolator over a half-finished run.
    const form = row?.output?.form;
    return form ? { stepId: run.awaitingStepId, form } : null;
}

/**
 * What the builder's form overlay shows when the journey is NOT on a form
 * page: the approval it waits on (`pendingApproval`, the approval row's
 * snapshot, with whether this caller may decide it), or the closing page the
 * journey ended on (`ending`, formResult.endingFrom, null when it had none).
 */
export async function formJourneyExtras(session: Session, run: Row): Promise<Row> {
    if (run.status === 'awaiting_approval') {
        const viewer = await facts().approvalViewerFor(session);
        const pendingApproval = await facts().pendingApprovalFor(run, viewer, store())
            .catch((e: unknown) => fallback('usecases/automation/runPauseOps:formJourneyExtras', e, null));
        return { pendingApproval };
    }
    if (!FINISHED_STATUSES.has(run.status)) return {};
    const { endingFrom } = nodeRequire('../../automation/formResult') as { endingFrom: (steps: Row[]) => Row | null };
    const steps: Row[] = await store().getRunSteps(run.id).catch((e: unknown) => fallback('usecases/automation/runPauseOps:formJourneyExtras#2', e, []));
    return { ending: endingFrom(steps) };
}

/**
 * RUN-07: the builder answers its OWN test's pages. A journey a real visitor
 * is in (a form session that is not a test link's) is answered on that
 * visitor's page, never from the builder: 409 public_journey.
 */
export async function refusePublicJourney(run: Row): Promise<void> {
    const s = store();
    if (typeof s.getFormSessionsForJourney !== 'function') return;
    const sessions: { isTest: boolean }[] = await s.getFormSessionsForJourney(run.id)
        .catch((e: unknown) => fallback('usecases/automation/runPauseOps:refusePublicJourney', e, []));
    if (sessions.some((x) => !x.isTest)) {
        const { HttpError } = nodeRequire('../../core/http/errors') as { HttpError: new (status: number, code: string, message: string) => Error };
        throw new HttpError(409, 'public_journey', 'Somebody is filling in this form on its public page. Their answers continue it, not the builder.');
    }
}

/**
 * Close out the run that was just continued.
 *
 * resumeFromStep starts a CHILD run and leaves the parent in 'awaiting_form'
 * forever; the reaper would later flip a page the author actually ANSWERED to a
 * "FormExpired" error. Same shape as formPublic's finaliseResumedParent, minus
 * the session — a builder test has no journey row to re-point.
 *
 * Called when the child EXISTS, so its event reaches the stream before the
 * child's own run.started: a list keyed on the journey reads "handed on", then
 * "running", never a stale "waiting".
 */
export async function finaliseContinuedRun(parent: Row, child: { id: string }): Promise<void> {
    const summary = `Continued from the form — see run ${child.id}`;
    await store().updateRun(parent.id, {
        status: 'success',
        summary,
        finishedAt: new Date().toISOString(),
    }).catch((e: unknown) => bestEffort('usecases/automation/runPauseOps:finaliseContinuedRun', e));
    emitRunClosed(parent, { status: 'success', summary, continuedBy: child.id });
}

/**
 * Close a run that waits on a form page, without an answer: the run is
 * cancelled (not the FormExpired error the reaper would write an hour later),
 * the page's step row says so, the journey's visitor session ends (its page
 * answers "expired"), and the stream hears it. Returns the closed row.
 */
export async function closeFormWait(run: Row): Promise<Row> {
    const s = store();
    const stepId = run.awaitingStepId;
    await s.updateRun(run.id, {
        status: 'cancelled',
        summary: FORM_WAIT_CLOSED,
        finishedAt: new Date().toISOString(),
        awaitingStepId: null,
    });
    const followUps = [
        stepId ? () => s.closeAwaitingStepRow(run.id, stepId, 'awaiting_form', 'cancelled') : null,
        () => s.endFormSessionForRun(run.id),
    ];
    await Promise.all(followUps.map((fn) => (fn ? Promise.resolve().then(fn) : null)
        ?.catch((e: unknown) => bestEffort('usecases/automation/runPauseOps:closeFormWait', e))));
    emitRunClosed(run, { status: 'cancelled', summary: FORM_WAIT_CLOSED });
    const fresh = await s.getRun(run.id).catch((e: unknown) => fallback('usecases/automation/runPauseOps:closeFormWait#2', e, null));
    return fresh || { ...run, status: 'cancelled', summary: FORM_WAIT_CLOSED, awaitingStepId: null };
}

/**
 * GET /runs/:id's additions (automation/pausedRunFacts.mts): the run's
 * profile; for a test run, whether the working copy has moved past the version
 * it ran; and for a journey waiting on an approval, whether the caller may
 * decide it and who it waits on. `run` already carries the journey's last leg
 * (journeyRunId, status, awaitingStepId) and is extended in place.
 */
export async function addRunViewFacts(session: Session, run: Row): Promise<void> {
    const f = facts();
    run.profile = f.profileView(run);
    if (run.profile?.kind !== 'production') {
        const automation = await store().getAutomation(run.automationId).catch((e: unknown) => fallback('usecases/automation/runPauseOps:addRunViewFacts', e, null));
        run.versionBehind = f.versionBehind(run, automation, run.profile);
    }
    if (run.status !== 'awaiting_approval') return;
    const viewer = await f.approvalViewerFor(session);
    const pending = await f.pendingApprovalFor({ ...run, id: run.journeyRunId || run.id }, viewer, store())
        .catch((e: unknown) => fallback('usecases/automation/runPauseOps:addRunViewFacts#2', e, null));
    if (!pending) return;
    run.approvalId = pending.approvalId;
    run.canDecide = pending.canDecide;
    run.waitingOn = pending.waitingOn;
}
