'use strict';

/**
 * The units of form work behind the queue (formQueue.js): what a first
 * submission and a resume actually run. Built from (automation, session, work)
 * and nothing else, so the call a recovered row makes is exactly the call the
 * original request would have made.
 */

const { lostToConcurrency, answersRefOf } = require('./formQueueShared');

/**
 * @param {{ automationStore: any, runner: () => any, formAnswers: () => any }} deps
 */
function createFormWork({ automationStore, runner, formAnswers }) {
    /**
     * Close out the run the visitor just resumed.
     *
     * resumeFromStep starts a CHILD run and leaves the parent sitting in
     * 'awaiting_form' forever — so reapExpiredFormWaits later flipped a form the
     * visitor had actually COMPLETED to a "FormExpired" error, and the owner's run
     * history recorded a failure for a submission that worked (W5-15). The
     * approve-step endpoint has always finalised its parent this way; this is the
     * same shape for the form pause: the parent's own portion, up to the pause,
     * succeeded, and its summary points at the child that carries the continuation.
     *
     * The session is re-pointed at the child FIRST. It happens again in runQueued
     * (idempotent), but doing it here closes a real window: the poll reads
     * `session.runId`, and a parent flipped to 'success' while the session still
     * pointed at it would answer `state: 'done'` — ending the visitor's journey
     * before the child had a chance to serve the next page.
     */
    async function finaliseResumedParent(session, parentRunId, child) {
        if (session?.id) await automationStore.attachFormSessionRun(session.id, child.id).catch(() => {});
        await automationStore.updateRun(parentRunId, {
            status: 'success',
            summary: `Resumed from the form — see child run ${child.id}`,
            finishedAt: new Date().toISOString(),
            awaitingStepId: null,
        }).catch(() => {});
    }

    // ── The work itself ───────────────────────────────────
    //
    // Built from (automation, session, work) and nothing else, so the call a
    // recovered row makes is exactly the call the original request would have
    // made. `work` is what sits in pending_work:
    //
    //   { kind: 'submit', payload, submitterId }
    //   { kind: 'resume', parentRunId, stepId, values, submitterId }

    /** A first submission: start the automation with the visitor's answers. */
    function submitThunk(automation, session, work) {
        const answers = answersRefOf(session);
        const submitterId = work.submitterId || null;
        return () => runner().executeAutomation(automation, {
            triggerKind: 'form',
            triggerPayload: { ...(work.payload || {}) },
            triggerHeaders: session.triggerHeaders,
            rootStepId: session.rootStepId || null,
            // Point the session at the run the MOMENT it exists, not when it
            // returns. executeAutomation resolves only once the automation has
            // paused or finished, so waiting for it left session.runId null for
            // the whole first stretch — and the poll has nothing to report
            // progress from without a run to read.
            onRunCreated: async (r) => {
                await automationStore.attachFormSessionRun(session.id, r.id);
                // FRM-08: who submitted, on the run — and the run, on the row.
                if (submitterId) await automationStore.updateRun(r.id, { submittedByUserId: submitterId }).catch(() => {});
                if (answers) await formAnswers().attachRun({ automation, datatableId: answers.datatableId, rowId: answers.rowId, run: r });
            },
            // No more pages to answer: the journey is complete (an error is
            // "complete" too — nothing further will be asked).
            onRunFinished: answers
                ? (r, { status }) => ((status === 'success' || status === 'error')
                    ? formAnswers().markCompleted({ automation, datatableId: answers.datatableId, rowId: answers.rowId })
                    : null)
                : null,
        });
    }

    /** Stop handing the answered page back while its resume is in flight (see formPublic.js). */
    function stopServingPage(parentRunId) {
        return automationStore.updateRun(parentRunId, { awaitingStepId: null }).catch(() => {});
    }

    /** A later page: resume the paused run with this page's answers. */
    function resumeThunk(automation, session, work) {
        const answersRef = answersRefOf(session);
        const submitterId = work.submitterId || null;
        const parentRunId = work.parentRunId;
        const stepId = work.stepId;
        const serveAgain = () => automationStore.updateRun(parentRunId, { awaitingStepId: stepId }).catch(() => {});
        // The session is pointed at the child as soon as it exists (below), so
        // a resume that never completed has to hand the pointer BACK — else the
        // poll reads a dead child and shows a failure for an answer that is
        // about to be retried.
        const pointAtParent = () => automationStore.attachFormSessionRun(session.id, parentRunId).catch(() => {});
        return async () => {
            await stopServingPage(parentRunId);   // idempotent: runQueued may retry this thunk
            let child;
            try {
                child = await runner().resumeFromStep(parentRunId, stepId, {
                    decision: { ...(work.values || {}) },
                    rootStepId: session.rootStepId,
                    triggerHeaders: session.triggerHeaders,
                    // Same reason as the first submission: the child is where
                    // the work happens, and it must be readable while it
                    // happens. finaliseResumedParent only runs once the child
                    // is DONE, which is far too late to show progress.
                    onRunCreated: async (r) => {
                        await automationStore.attachFormSessionRun(session.id, r.id);
                        if (submitterId) await automationStore.updateRun(r.id, { submittedByUserId: submitterId }).catch(() => {});
                    },
                    onRunFinished: answersRef
                        ? (r, { status }) => ((status === 'success' || status === 'error')
                            ? formAnswers().markCompleted({ automation, ...answersRef })
                            : null)
                        : null,
                });
            } catch (e) {
                await pointAtParent();
                await serveAgain();    // the answer never ran — let them retry
                throw e;
            }
            // A lost cross-pod race is not a completed resume — leave the
            // parent paused so runQueued's retry can try again.
            if (child?.id && !lostToConcurrency(child)) {
                await finaliseResumedParent(session, parentRunId, child);
            } else {
                await pointAtParent();
                await serveAgain();
            }
            return child;
        };
    }

    function makeItem(automation, session, work) {
        const thunk = work.kind === 'resume' ? resumeThunk(automation, session, work) : submitThunk(automation, session, work);
        return { automationId: automation.id, sessionId: session.id, kind: work.kind, thunk };
    }

    return { makeItem, stopServingPage };
}

module.exports = { createFormWork };
