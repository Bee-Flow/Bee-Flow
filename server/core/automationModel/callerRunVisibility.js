// @typecheck
/**
 * Who may read a run's DATA when the run used the starter's own connections
 * (runPolicy.connections = 'caller', started by somebody other than the owner;
 * the run row says so in `connectionsMode`, fixed when the run started).
 *
 * Such a run acted in the starter's mailbox, calendar and drive, so its step
 * inputs, outputs, errors and trigger payload belong to the starter alone.
 * The owner, editors and other sharers still see the run's status, the step
 * names, step statuses and timing, nothing that carries a value. What they see
 * is built from an explicit allow-list of fields, so a column added next year
 * stays hidden until somebody decides it may travel. Applied on every
 * server-side run read (detail, steps, full output, lists, the stream, polls
 * and the answers of write routes), never only in the UI.
 *
 * Pure apart from the one HttpError the assert throws.
 */

'use strict';

const { HttpError } = require('../http/errors');

/** The run fields that carry no value: identity of the run, its state, its timing. */
const RUN_FIELDS_SHOWN = Object.freeze([
    'id', 'journeyRunId', 'rootRunId', 'parentRunId', 'automationId', 'automationTitle', 'automationKind',
    'automationIcon', 'automationTriggerType', 'rootStepId', 'rootTriggerLabel', 'version', 'userId',
    'startedByUserId', 'triggerKind', 'mode', 'status', 'startedAt', 'finishedAt', 'durationMs', 'errorClass',
    'handledErrorCount', 'isTest', 'awaitingStepId', 'awaitingStepExpiresAt', 'cancelRequested', 'connectionsMode',
    'callerAgentId', 'callerConversationId', 'submittedByUserId', 'approvalId',
    // The run-list decoration (automation/runListRows.js): step bars, how it started, who.
    'stepsTotal', 'stepsDone', 'stepStatuses', 'howStarted', 'startedBy', 'mine',
]);

/** The step fields that carry no value: which step, its state, its timing. */
const STEP_FIELDS_SHOWN = Object.freeze([
    'runId', 'stepId', 'parentStepId', 'stepType', 'attempts', 'status', 'startedAt', 'finishedAt', 'branchIndex', 'errorClass',
]);

/** @param {{ connectionsMode?: string|null }|null|undefined} run */
function isCallerRun(run) {
    return !!run && run.connectionsMode === 'caller';
}

/**
 * May `viewerId` read this run's payloads? True for every ordinary run, and for
 * a caller-mode run only for the person who started it.
 *
 * @param {{ connectionsMode?: string|null, startedByUserId?: string|null }|null|undefined} run
 * @param {string|null|undefined} viewerId
 */
function canReadRunData(run, viewerId) {
    if (!isCallerRun(run)) return true;
    return !!viewerId && !!run?.startedByUserId && run.startedByUserId === viewerId;
}

/** Throws the 403 for a route that would hand a caller-mode run's data (or a continuation of it) to somebody else. */
function assertCanReadRunData(run, viewerId, what = 'see its data') {
    if (!canReadRunData(run, viewerId)) {
        throw new HttpError(403, 'caller_run_private', `This run used the connections of the person who started it, so only they can ${what}.`);
    }
}

const pick = (source, keys) => Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]));

/** The run row without anything a value could ride in. */
function redactRunForViewer(run, viewerId) {
    if (!run || canReadRunData(run, viewerId)) return run;
    /** @type {Record<string, any>} */
    const out = { ...pick(run, RUN_FIELDS_SHOWN), dataHidden: true };
    if (run.outcome && typeof run.outcome === 'object') out.outcome = { code: run.outcome.code ?? null, params: {}, text: null };
    return out;
}

/** A list/org row (already a run-shaped object) for a viewer. */
function redactRunRowForViewer(row, viewerId) {
    return redactRunForViewer(row, viewerId);
}

const hideStep = (s) => ({ ...pick(s, STEP_FIELDS_SHOWN), dataHidden: true });

/** Step rows reduced to name, type, status and timing. */
function redactStepsForViewer(run, steps, viewerId) {
    if (!Array.isArray(steps) || canReadRunData(run, viewerId)) return steps;
    return steps.map(hideStep);
}

/**
 * A journey's step rows, each judged by the mode of the leg that recorded it
 * (`legs`: the runs of the chain). A row of a leg that cannot be identified is hidden,
 * unless it is the head's own: a failed lookup of the legs never opens a door.
 */
function redactChainStepsForViewer(head, legs, steps, viewerId) {
    if (!Array.isArray(steps)) return steps;
    const byId = new Map((Array.isArray(legs) ? legs : []).map((l) => [l.id, l]));
    return steps.map((s) => {
        const leg = byId.get(s.runId) || (head && s.runId === head.id ? head : null);
        return leg && canReadRunData(leg, viewerId) ? s : hideStep(s);
    });
}

module.exports = {
    isCallerRun, canReadRunData, assertCanReadRunData, redactRunForViewer, redactStepsForViewer,
    redactChainStepsForViewer, redactRunRowForViewer, RUN_FIELDS_SHOWN, STEP_FIELDS_SHOWN,
};
