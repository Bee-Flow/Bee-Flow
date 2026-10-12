/**
 * The `vars` a run sees: the automation's own `definition.vars` with the
 * project's Solution variable values laid over them (design 4.2).
 *
 * A Solution declares variables in Dev (solution_variables) and every project
 * of it (Dev, UAT, PRD) holds its own values (solution_variable_values). A run
 * reads the APPLIED values through solutionStageStore.variableValuesFor: typed,
 * coerced and memoised there (30 s per project, dropped in-process on a
 * write). A steering value (D18) only becomes applied through a redeploy, so a
 * stage editor cannot point a live run somewhere else by typing a value.
 *
 * A declared name wins over an automation's own `definition.vars` key of the same
 * name (the release cut blocks that shadowing, `variable.shadowed`).
 *
 * Never throws: a run must not die because the variables could not be read.
 * On an error it logs a warning and the run gets `definition.vars`, exactly
 * what it saw before Solutions had variables.
 *
 * `automation/bind.js` and `shared/expr` are untouched: they already read
 * `vars.*` from runState. `secrets` stays `{}` (execution.js).
 *
 * Also home of `isManagedAutomation` (is this automation in a Solution stage, D17),
 * so the runner reads both stage lookups through one injectable seam
 * (`configureStageVars`).
 */

'use strict';

const log = require('../../telemetry/log');

/** The automation's own vars as a plain object (anything else counts as none). */
function ownVars(definition) {
    const v = definition && typeof definition === 'object' ? definition.vars : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

const defaultDeps = {
    variableValuesFor: (projectId) => require('../../stores/solutionStageStore').variableValuesFor(projectId),
    managedInfo: (projectId) => require('../../stores/lib/managedParts').managedInfo(projectId),
    log,
};

// The init seam: what the runner (execution.js, partialRuns.js) reads through
// when a call passes no deps of its own. Production never sets it; a test
// injects its stage lookup and variable values here instead of replacing a
// module.
let configured = {};

/**
 * Point the stage lookups at other implementations (tests). Returns a
 * function that restores the previous configuration.
 * @param {{ variableValuesFor?: Function, managedInfo?: Function, log?: any }} overrides
 */
function configureStageVars(overrides = {}) {
    const previous = configured;
    configured = { ...configured, ...overrides };
    return () => { configured = previous; };
}

const depsFor = (deps) => ({ ...defaultDeps, ...configured, ...(deps || {}) });

/**
 * True when this automation lives in a Solution stage project (UAT/PRD), whose
 * runs follow D17 (definitionForRun.js). Only automations with a project are
 * looked up; managedParts caches the stage lookup. A failing lookup REJECTS
 * (the run fails): guessing "not managed" would run a working copy that may
 * be a release still being prepared.
 * @param {{ kind?: string, projectId?: string|null }|null} automation
 * @param {{ managedInfo?: (projectId: string) => Promise<object|null> }} [deps]
 * @returns {Promise<boolean>}
 */
async function isManagedAutomation(automation, deps) {
    if (!automation || (automation.kind || 'automation') !== 'automation') return false;
    const projectId = automation.projectId;
    if (typeof projectId !== 'string' || !projectId) return false;
    return !!(await depsFor(deps).managedInfo(projectId));
}

/**
 * @param {{ projectId?: string|null, definition?: object|null }|null} automation
 * @param {{ definition?: object|null }} [opts] the definition this run executes
 *        (default: `automation.definition`); a partial run passes the one it built
 * @param {{ variableValuesFor?: (projectId: string) => Promise<Record<string, any>>, log?: any }} [deps]
 * @returns {Promise<Record<string, any>>}
 */
async function runVarsFor(automation, opts = {}, deps = {}) {
    const definition = opts && opts.definition !== undefined ? opts.definition : automation?.definition;
    const base = ownVars(definition);
    const projectId = automation?.projectId;
    if (typeof projectId !== 'string' || !projectId) return base;
    const { variableValuesFor, log: logger } = depsFor(deps);
    try {
        const values = await variableValuesFor(projectId);
        if (!values || typeof values !== 'object' || Object.keys(values).length === 0) return base;
        return { ...base, ...values };
    } catch (err) {
        logger.warn(`[stageVars] could not read the Solution variables of project ${projectId} for automation ${automation?.id || '?'}: ${err?.message || err}`);
        return base;
    }
}

module.exports = { runVarsFor, isManagedAutomation, configureStageVars };
