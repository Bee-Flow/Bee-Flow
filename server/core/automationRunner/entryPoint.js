'use strict';

/**
 * Which definition a run enters, and which trigger of it. Shared by the run
 * routes (routes/automation/runs.js, formScenarios.js) and the MCP form-scenario
 * dry run (automation/mcpFormScenarios.js), so a test run of any kind picks its
 * entry point the same way. It sits in core/ because a feature may not require
 * a route; routes/automation/runEntry.js re-exports it.
 */
const { isManagedAutomation } = require('./stageVars');
const { automationForRun } = require('./definitionForRun');

/**
 * The definition a run of this automation enters: for an automation a Solution stage
 * manages that is the LIVE copy (test runs included), so a trigger that exists
 * only in the working copy is not offered. Throws managed_part_not_deployed
 * (409) when it has no live copy.
 */
async function entryDefinitionOf(a) {
    if (!await isManagedAutomation(a)) return a.definition;
    return automationForRun(a, { mode: 'live', managed: true }).definition;
}

/**
 * Resolve an optional `triggerStepId` (the entry point a test run should use)
 * against the automation's triggers — the primary `definition.trigger` and every
 * `definition.triggers[]` entry. Returns the trigger node and the `rootStepId`
 * to hand the runner (null for the primary, so an automation without additional
 * triggers behaves exactly as before). A wrong id is a 400, never a silent
 * fall-back to the primary: the caller asked to test a specific root.
 */
function resolveTriggerStepId(def, triggerStepId) {
    const known = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])].filter(t => t && t.id);
    if (!triggerStepId) {
        return { trigger: def?.trigger || null, rootStepId: null };
    }
    const hit = known.find(t => t.id === triggerStepId);
    if (!hit) {
        return { error: `Unknown triggerStepId "${triggerStepId}". This automation's triggers: ${known.map(t => `${t.id} (${t.kind})`).join(', ') || '(none)'}.` };
    }
    return { trigger: hit, rootStepId: hit.id === def?.trigger?.id ? null : hit.id };
}

module.exports = { entryDefinitionOf, resolveTriggerStepId };
