/**
 * "Koppelingen bijwerken": upgrade the mappings of one stored automation,
 * with the data it really ran on as the evidence.
 *
 * The rewrite itself is shared/mapping/upgrade.mjs upgradeDefinition: every
 * forEach to a repeat and every ref to a pick, each one dry-run and kept as
 * it is when its value would change (an expr stays a Formula). This file
 * only hands it the runStates to dry-run on:
 *
 *   lastRun  the newest output of every step over the last few LIVE runs
 *            (a dry run's outputs are synthesised, so never those), and the
 *            newest run's trigger payload: the window the builder's partial
 *            runs replay, read through it
 *            (core/automationRunner/replaySeeding.js seedReplayState)
 *   sample   what the definition pins: the trigger's pinned output (or the
 *            saved test input) and every step's pinnedOutput
 *
 * PRIVACY. The run data stays in this process: it is compared, never
 * returned. The report names steps, fields and labels of paths only.
 */

'use strict';

const { upgradeDefinition } = require('../shared/mapping/index.mjs');
const parse = require('../shared/expr/parse.mjs');
const { evaluate } = require('./expr');
const { buildTriggerState } = require('../core/automationRunner/triggerState');
const { seedReplayState } = require('../core/automationRunner/replaySeeding');

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Every step of a definition's root graph, nested ones included. */
function allSteps(steps, out = []) {
    for (const s of Array.isArray(steps) ? steps : []) {
        if (!isObject(s)) continue;
        out.push(s);
        if (s.type === 'loop') allSteps(s.body, out);
        if (s.type === 'parallel' && Array.isArray(s.branches)) for (const b of s.branches) allSteps(b, out);
    }
    return out;
}

/**
 * The runState of what the definition pins, or null when it pins nothing.
 * @param {object} definition
 */
function sampleState(definition) {
    if (!isObject(definition)) return null;
    const trig = isObject(definition.trigger) ? definition.trigger : {};
    const payload = trig.pinnedOutput != null ? trig.pinnedOutput
        : (isObject(definition.manualTriggerPayload) ? definition.manualTriggerPayload : null);
    const steps = {};
    for (const s of allSteps(definition.steps)) {
        if (typeof s.id === 'string' && s.pinnedOutput !== undefined && s.pinnedOutput !== null) steps[s.id] = { output: s.pinnedOutput };
    }
    if (payload == null && !Object.keys(steps).length) return null;
    return {
        trigger: buildTriggerState({ triggerKind: trig.kind || 'manual', triggerPayload: payload }),
        steps,
        vars: isObject(definition.vars) ? definition.vars : {},
        loop: {},
    };
}

/**
 * The runState of the automation's recent live runs, or null when it has
 * none: per step the newest recorded output and the newest trigger payload.
 * The window is replaySeeding.js's own (seedReplayState): the same live runs,
 * the same newest-row-per-step rule, a truncated output as no data. Only a
 * plain success is evidence; a handled error carries no output to compare.
 * @param {{ id: string, definition?: object }} automation
 * @param {{ getRunsForAutomation: Function, getRunSteps: Function, getRunStepsForRuns?: Function }} store
 */
async function lastRunState(automation, store) {
    // A flowlet's own steps (`cl1/out`) are not steps of this graph.
    const stepIdFor = row => (row && !row.parentStepId && typeof row.stepId === 'string' ? row.stepId : null);
    const { replayState, runsWindow } = await seedReplayState(automation.id, null, stepIdFor, { store });
    if (!runsWindow.length) return null;
    const steps = {};
    for (const [id, entry] of Object.entries(replayState)) {
        if (entry.status === 'success') steps[id] = { output: entry.output };
    }
    const withPayload = runsWindow.find(r => r.triggerPayload != null) || runsWindow[0];
    const def = isObject(automation.definition) ? automation.definition : {};
    return {
        trigger: buildTriggerState({
            enteredTrigger: isObject(def.trigger) ? def.trigger : null,
            triggerKind: withPayload.triggerKind || 'manual',
            triggerPayload: withPayload.triggerPayload ?? null,
            startedAt: Date.parse(withPayload.startedAt || '') || Date.now(),
        }),
        steps,
        vars: isObject(def.vars) ? def.vars : {},
        loop: {},
    };
}

/**
 * The upgrade of `automation`'s definition, dry-run on its own data:
 * `{ definition, changed, kept, evidence: { lastRun, sample } }`.
 * @param {{ id: string, definition?: object }} automation
 * @param {object} store the automation store (run reads only)
 */
async function upgradeAutomationMappings(automation, store) {
    const definition = automation.definition;
    const [lastRun, sample] = [await lastRunState(automation, store), sampleState(definition)];
    const result = upgradeDefinition(definition, { sample, lastRun, evaluate, parse });
    return { ...result, evidence: { lastRun: !!lastRun, sample: !!sample } };
}

module.exports = { upgradeAutomationMappings, lastRunState, sampleState };
