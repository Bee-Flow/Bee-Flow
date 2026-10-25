// @typecheck noImplicitAny
/**
 * What a person typed into a run's forms, kept so the same run can be played
 * again (a form scenario, a golden replay).
 *
 * Pure: it reads a finished journey and returns the answers. It never writes
 * and never fetches.
 *
 *   FormAnswers = {
 *     v: 1,
 *     trigger: { [field]: value } | null,   answers of the entered form trigger
 *     pages:   { [formPageStepId]: { [field]: value } },
 *     skipped: [{ stepId: string|null, field, reason: 'file'|'app_pick'|'not_declared' }],
 *   }
 *
 * Where the answers live:
 *   - the trigger's answers are the run's `triggerPayload` (the form's coerced
 *     values, keyed by field name);
 *   - a page's answers are the OUTPUT of its form_page step row. resumeFromStep
 *     injects the visitor's coerced answers as that step's output and
 *     recordResumeBoundary persists them as a status 'success' row in the leg
 *     that continued the run (core/automationRunner/runContext.js). The row
 *     holds exactly the values, keyed by authored field name.
 *
 * What is NOT kept: an uploaded file and a record picked from an app belong to
 * a person and to a moment, so those fields go to `skipped` (by field name only,
 * never a value) and a replay leaves them empty. Keys the form does not declare
 * are listed too, and dropped.
 */

'use strict';

const { normalizeFields, isDisplayField, isFormTriggerDefinition } = require('../formTriggerContract');

/** @param {unknown} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The trigger node a run entered through: the primary, or the `triggers[]` entry named by rootStepId.
 * @param {any} definition
 * @param {string | null | undefined} rootStepId
 */
function enteredTriggerOf(definition, rootStepId) {
    if (rootStepId && Array.isArray(definition?.triggers)) {
        const hit = definition.triggers.find((/** @type {{ id?: string } | null} */ t) => t && t.id === rootStepId);
        if (hit) return hit;
    }
    return definition?.trigger || null;
}

/**
 * Split one answered form into what is kept and what is skipped.
 * @param {object|null|undefined} form  the authored declaration (`form` of a trigger or form_page)
 * @param {any} output                  the answers as the run recorded them
 * @param {string|null} stepId
 */
function keepDeclared(form, output, stepId) {
    /** @type {Record<string, any>} */
    const kept = {};
    /** @type {Array<{ stepId: string | null, field: string, reason: 'file' | 'app_pick' | 'not_declared' }>} */
    const skipped = [];
    if (!isPlainObject(output)) return { kept, skipped };
    const declared = new Map(normalizeFields(form).filter((f) => !isDisplayField(f)).map((f) => [f.name, f]));
    for (const key of Object.keys(output)) {
        if (key.startsWith('_')) continue;
        const field = declared.get(key);
        if (!field) skipped.push({ stepId, field: key, reason: 'not_declared' });
        else if (field.type === 'file' || field.type === 'app_pick') {
            // An unanswered one (null, '' or []) lost nothing: list only what was dropped.
            const v = output[key];
            const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
            if (!empty) skipped.push({ stepId, field: key, reason: field.type });
        } else kept[key] = output[key];
    }
    return { kept, skipped };
}

/**
 * @param {{ definition: any, rootRun: any, steps: any[] }} input
 *   `steps` are the rows of the whole journey (getRunStepsForChain), oldest leg first.
 * @returns {{ v: 1, trigger: Record<string, any>|null, pages: Record<string, Record<string, any>>, skipped: Array<{ stepId: string|null, field: string, reason: 'file'|'app_pick'|'not_declared' }> }}
 */
function answersFromJourney({ definition, rootRun, steps }) {
    /** @type {Array<{ stepId: string | null, field: string, reason: 'file' | 'app_pick' | 'not_declared' }>} */
    const skipped = [];

    let trigger = null;
    const entered = enteredTriggerOf(definition, rootRun?.rootStepId);
    const isForm = entered === definition?.trigger ? isFormTriggerDefinition(definition) : entered?.kind === 'form';
    if (isForm) {
        const r = keepDeclared(entered.form, rootRun?.triggerPayload, null);
        trigger = r.kept;
        skipped.push(...r.skipped);
    }

    const rows = Array.isArray(steps) ? steps : [];
    /** @type {Record<string, Record<string, any>>} */
    const pages = {};
    for (const step of Array.isArray(definition?.steps) ? definition.steps : []) {
        if (!step || step.type !== 'form_page' || step.mode === 'ending' || !step.id) continue;
        let row = null;
        for (const r of rows) {
            if (r && r.stepId === step.id && !r.parentStepId && r.status === 'success') row = r;
        }
        if (!row || !isPlainObject(row.output) || row.output._skipped === true) continue;
        const r = keepDeclared(step.form, row.output, step.id);
        pages[step.id] = r.kept;
        skipped.push(...r.skipped);
    }

    return { v: 1, trigger, pages, skipped };
}

/**
 * JSON bytes of the answers, for the size cap.
 * @param {unknown} answers
 */
function answersSize(answers) {
    return Buffer.byteLength(JSON.stringify(answers ?? null), 'utf8');
}

/**
 * True when the answers hold anything a replay could use (trigger values or a page).
 * @param {{ trigger?: unknown, pages?: Record<string, unknown> } | null | undefined} answers
 */
function hasAnswers(answers) {
    return !!answers && ((isPlainObject(answers.trigger) && Object.keys(answers.trigger).length > 0)
        || Object.keys(answers.pages || {}).length > 0);
}

module.exports = { answersFromJourney, answersSize, hasAnswers };
