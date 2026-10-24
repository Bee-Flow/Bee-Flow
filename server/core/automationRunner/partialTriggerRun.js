// @typecheck
/**
 * The trigger-only partial run (▶ on a trigger node), split out of partialRuns.js:
 * a synthetic run that executes no step, whose output IS the trigger payload.
 *
 * It never reaches executeAutomation, so the run's mode on the caller's
 * connections (runPolicy.connections) is stamped here too.
 */

'use strict';

const automationStore = require('../../stores/automationStore');
const { resolveTriggerPayload } = require('./execution');
const { callerOnlyUserId } = require('./callerConnections');
const { resolveRunPolicy } = require('./runPolicy');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

async function runTriggerOnly({ automation, triggerId, triggerNode, triggerPayload, triggerKind, startedByUserId }) {
    // This branch synthesizes its own run and never reaches
    // executeAutomation, so the pinned-sample rule has to be applied HERE
    // too. It is the ▶ on the trigger node — the single gesture the whole
    // feature exists for — and missing it would leave the headline case
    // showing `{}` while every other entry point had data.
    const enteredPayload = resolveTriggerPayload({ trigger: triggerNode, triggerPayload, triggerKind, mode: 'live' });
    const run = await automationStore.createRun({
        automationId: automation.id,
        version: automation.version,
        userId: automation.userId,
        triggerKind,
        triggerPayload: enteredPayload,
        mode: 'live',
        parentRunId: null,
        rootStepId: triggerId,
        startedByUserId,
        connectionsMode: callerOnlyUserId(resolveRunPolicy(automation.definition), automation, startedByUserId) ? 'caller' : null,
    });
    const triggerOutput = enteredPayload || {};
    const nowIso = new Date().toISOString();
    try {
        await automationStore.recordRunStep({
            runId: run.id,
            stepId: triggerId,
            stepType: 'trigger',
            attempts: 1,
            status: 'success',
            startedAt: nowIso,
            finishedAt: nowIso,
            input: enteredPayload ?? null,
            output: triggerOutput,
            error: null,
            // No runState here — a trigger-only synthetic run executes no
            // steps, so no secret bridge can have populated any secrets.
            secretValues: [],
        });
    } catch (err) { bestEffort('core/automationRunner/partialTriggerRun:runTriggerOnly', err); /* recordRunStep is best-effort here */ }
    await automationStore.updateRun(run.id, {
        status: 'success',
        startedAt: nowIso,
        finishedAt: nowIso,
        output: triggerOutput,
        summary: 'Trigger step (no downstream execution)',
    }).catch((e) => bestEffort('core/automationRunner/partialTriggerRun:runTriggerOnly#2', e));
    return { ...run, status: 'success', output: triggerOutput };
}

module.exports = { runTriggerOnly };
