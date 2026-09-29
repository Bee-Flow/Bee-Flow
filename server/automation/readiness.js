/**
 * "Ready to activate?" (Studio → Automations handoff 5, settings page): the
 * checklist beside the settings, answered from the same rules the server
 * enforces when somebody presses Activate or "Make vN live".
 *
 *   stepsComplete  the working copy passes the definition checks at the
 *                  activation stage (validateDefinition, the pure pass) and no
 *                  step serves hand-written sample data (the pinned-sample
 *                  refusal in routes/automation/activate.js). `issues` counts
 *                  both. The database-backed checks activation adds on top
 *                  (the owner's tool, agent and knowledge-base catalogs) are
 *                  not run here: this is a checklist, activation stays the gate.
 *   lastTest       the newest finished test run of the routine (the Test button
 *                  or a dry run), or null. Advice, not a gate.
 *   aiAct          the AI Act check (automation/aiActCheck.js). Gates only when
 *                  the organisation has the compliance hub licence.
 *   description    the routine has a description. Recommended, not a gate.
 *   canActivate    what the server would let through: the steps and the AI Act
 *                  check. The test run and the description do not block.
 *
 * Pure: the caller hands in the automation, the validator result, the runs and
 * the AI Act state.
 */

'use strict';

const { collectPinnedNodes } = require('./portability');

/** Run statuses that are still going; a test that is still running has no verdict yet. */
const UNFINISHED = new Set(['running', 'queued', 'pending', 'awaiting_approval', 'awaiting_input', 'paused']);

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** A run the builder started to try the routine: the Test button (isTest) or a dry run. */
function isTestRun(run) {
    return !!run && (run.isTest === true || run.mode === 'dry_run');
}

/** The newest finished test run, from a newest-first list. */
function lastTestOf(runs) {
    for (const r of Array.isArray(runs) ? runs : []) {
        if (!isTestRun(r) || UNFINISHED.has(r.status)) continue;
        return {
            ok: r.status === 'success',
            at: r.finishedAt || r.startedAt || null,
            runId: r.id,
            status: r.status,
            version: r.version ?? null,
        };
    }
    return null;
}

/**
 * The steps half: validator errors plus hand-written pinned samples.
 * `validation` is validateDefinition's result for the working copy.
 */
function stepsCompleteOf(definition, validation) {
    const errors = Array.isArray(validation?.errors) ? validation.errors : [];
    let edited = [];
    try { edited = collectPinnedNodes(isObject(definition) ? definition : {}).filter(p => p.pinnedSource === 'edited'); }
    catch { edited = []; }
    const issues = errors.length + edited.length;
    const first = errors[0]
        ? { code: errors[0].code, path: errors[0].path ?? null, message: errors[0].message }
        : edited[0]
            ? { code: 'pin.edited_sample_blocks_activation', path: null, message: `Step "${edited[0].id || '(no id)'}" serves sample data you wrote by hand instead of running.` }
            : null;
    return { ok: issues === 0, issues, firstIssue: first };
}

/**
 * @param {{
 *   automation: object,
 *   validation: { ok: boolean, errors?: any[] },
 *   runs?: any[],
 *   aiAct: { required: boolean, status: string, expiresAt: string|null, outcome?: string|null, attestedAt?: string|null },
 * }} input
 */
function computeReadiness({ automation, validation, runs = [], aiAct }) {
    const a = automation || {};
    const stepsComplete = stepsCompleteOf(a.definition, validation);
    const lastTest = lastTestOf(runs);
    const ai = aiAct || { required: false, status: 'not_required', expiresAt: null };
    const aiOk = !ai.required || ai.status === 'valid';
    const description = { ok: typeof a.description === 'string' && a.description.trim().length > 0 };
    return {
        version: a.version ?? null,
        stepsComplete,
        lastTest,
        aiAct: {
            required: !!ai.required,
            status: ai.status,
            expiresAt: ai.expiresAt ?? null,
            outcome: ai.outcome ?? null,
            attestedAt: ai.attestedAt ?? null,
        },
        description,
        canActivate: stepsComplete.ok && aiOk,
    };
}

module.exports = { computeReadiness, lastTestOf, stepsCompleteOf, isTestRun };
