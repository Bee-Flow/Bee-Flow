/**
 * "Koppelingen bijwerken": upgrade the mappings of one stored automation,
 * with the data it really ran on as the evidence.
 *
 * The rewrite itself is shared/mapping/upgrade.mjs upgradeDefinition: every
 * forEach to a repeat and every ref to a pick, each one dry-run and kept as
 * it is when its value would change (an expr stays a Formula). This file
 * only hands it the runStates to dry-run on:
 *
 *   runs     one runState per LIVE run in the window the builder's partial
 *            runs replay (core/automationRunner/replaySeeding.js
 *            seedReplayState): that run's own trigger payload and step
 *            outputs (a dry run's outputs are synthesised, so never those).
 *            Every upgrade must resolve the same on each of them.
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
const { seedReplayState, replayEntryFromRow } = require('../core/automationRunner/replaySeeding');

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
 * One runState per recent live run, newest first, or [] when there is none:
 * each run's OWN trigger payload and step outputs, never a mix of runs. A
 * binding that agrees with its pick on a composite of the newest outputs can
 * still read differently on an older run (another shape of the same list,
 * a key that run lacked), so every run is evidence on its own and an upgrade
 * must agree on each.
 *
 * The window is replaySeeding.js's own (seedReplayState): the same live runs
 * (a dry run's outputs are synthesised, so never those), read through the
 * same row rule (replayEntryFromRow: a truncated output, a failed or skipped
 * row is no data; inside a run the last attempt decides). Only a plain
 * success is evidence; a handled error carries no output to compare. A run
 * that holds no data at all adds nothing.
 * @param {{ id: string, definition?: object }} automation
 * @param {{ getRunsForAutomation: Function, getRunSteps: Function, getRunStepsForRuns?: Function }} store
 * @returns {Promise<object[]>}
 */
async function recentRunStates(automation, store) {
    // A flowlet's own steps (`cl1/out`) are not steps of this graph.
    const stepIdFor = row => (row && !row.parentStepId && typeof row.stepId === 'string' ? row.stepId : null);
    const { runsWindow, stepsByRun } = await seedReplayState(automation.id, null, stepIdFor, { store });
    const def = isObject(automation.definition) ? automation.definition : {};
    const states = [];
    for (const run of runsWindow) {
        const entries = {};
        for (const row of (stepsByRun.get(run.id) || [])) {
            const stepId = stepIdFor(row);
            if (!stepId) continue;
            const entry = replayEntryFromRow(row, stepId);
            if (entry) entries[stepId] = entry;
            else delete entries[stepId];
        }
        const steps = {};
        for (const [id, entry] of Object.entries(entries)) {
            if (entry.status === 'success') steps[id] = { output: entry.output };
        }
        const payload = run.triggerPayload ?? null;
        if (payload == null && !Object.keys(steps).length) continue;
        states.push({
            trigger: buildTriggerState({
                enteredTrigger: isObject(def.trigger) ? def.trigger : null,
                triggerKind: run.triggerKind || 'manual',
                triggerPayload: payload,
                startedAt: Date.parse(run.startedAt || '') || Date.now(),
            }),
            steps,
            vars: isObject(def.vars) ? def.vars : {},
            loop: {},
        });
    }
    return states;
}

/**
 * The upgrade of `automation`'s definition, dry-run on its own data:
 * `{ definition, changed, kept, evidence: { lastRun, sample }, states }`.
 *
 * `states` is the runStates themselves (`{ runs, sample }`: one per recent
 * live run, and the pinned sample or null), for the AI fix's gate
 * (mappingAiFix.js), which dry-runs a proposal on the same data. It is run
 * data: a route answers with the report and `evidence`, never with `states`.
 * @param {{ id: string, definition?: object }} automation
 * @param {object} store the automation store (run reads only)
 */
async function upgradeAutomationMappings(automation, store) {
    const definition = automation.definition;
    const [runs, sample] = [await recentRunStates(automation, store), sampleState(definition)];
    const result = upgradeDefinition(definition, { sample, runs, evaluate, parse });
    return { ...result, evidence: { lastRun: runs.length > 0, sample: !!sample }, states: { runs, sample } };
}

module.exports = { upgradeAutomationMappings, recentRunStates, sampleState };
