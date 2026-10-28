// @typecheck
'use strict';
/**
 * The second chance of an ai_step answer that did not pass its checks: ONE
 * repair message (what failed, what the model itself wrote there) and, when
 * that does not help either, the step's `fallback`.
 *
 * Privacy: the repair message quotes only the model's own PRE-restore value at
 * the failing path (max 200 characters), so it holds the placeholders the
 * model was given, never the restored data, the source lists or the allowed
 * values. It also goes through the same input guard as the prompt.
 */

const safety = require('./safety');
const { resolveInputs } = require('../automationModel/bind');
const { noteRunWarning } = require('./runWarnings');
const { errorSummary } = require('./aiStepChecks');

/** AUTOMATION_AI_REPAIR_MAX_ERRORS: failing paths quoted in a repair message. 0 = unlimited. */
function repairLines() {
    const raw = process.env.AUTOMATION_AI_REPAIR_MAX_ERRORS;
    if (raw == null || String(raw).trim() === '') return 25;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 25;
}

/**
 * The messages of the repair round: the original request, the model's own
 * answer, and what was wrong with it. Null when the guard refuses the new
 * message (a dry run under a block policy): then there is no repair.
 * @returns {Promise<Array<any>|null>}
 */
async function buildRepairMessages({ base, prior, errors, policy, auditBase, mode, ctx }) {
    const cap = repairLines();
    const lines = (cap > 0 ? errors.slice(0, cap) : errors).map((e) => {
        const wrote = e.modelValue ? ` (you wrote: ${JSON.stringify(e.modelValue)})` : '';
        return `- ${e.path || 'answer'}: ${e.message}${wrote}`;
    });
    const userMsg = {
        role: 'user',
        content: `Your answer did not pass these checks:\n${lines.join('\n')}\nReturn the complete corrected answer in the same format. Use only values from the lists you were given and only numbers that appear in the input data.`,
    };
    const guard = await safety.guardAiInput([userMsg], policy, auditBase, mode, ctx);
    if (guard.blocked) return null;
    const assistantText = typeof prior === 'string' ? prior : JSON.stringify(prior);
    return [...base, { role: 'assistant', content: assistantText || '(no answer)' }, userMsg];
}

/** The report that rides next to `piiSummary` on the step result (never inside the output). */
function makeCheckReport({ passed, repaired, fallbackUsed, errors }) {
    return {
        passed, repaired, fallbackUsed,
        errors: errors.slice(0, 50).map(({ code, path, message }) => ({ code, path, message })),
    };
}

/**
 * The step's fallback once the repair round has failed too: the configured
 * values (read from run data, never from secrets), or a failed step.
 * @returns {Record<string, unknown>} the output to use
 */
function applyFallback({ step, rel, runState, errors }) {
    if (rel.fallback && rel.fallback.kind === 'value') {
        noteRunWarning(runState, `${step.id}: the AI answer did not pass its checks after one repair round, so the fallback values were used`);
        return resolveInputs(rel.fallback.fields, runState, { allowSecrets: false });
    }
    const err = new Error(`This AI step's answer did not pass its checks after one repair round: ${errorSummary(errors)}`);
    /** @type {Error & { errorClass?: string }} */ (err).errorClass = 'ai_check_failed';
    throw err;
}

module.exports = { buildRepairMessages, makeCheckReport, applyFallback };

/** @typedef {{ code: string, path: string, message: string, modelValue: string }} AiCheckError */
