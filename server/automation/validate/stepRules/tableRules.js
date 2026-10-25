// @typecheck
/**
 * Field rules of the two table steps: read_table (open an uploaded spreadsheet
 * or CSV as tables) and table (edit a table without code).
 *
 * The rules themselves live in the shared specs under
 * core/automationModel/tableOps (the runner and the builder read the same
 * ones); this file only maps their findings onto the validator's records with
 * the path prefixed by the step's own, and adds the one rule that needs the
 * definition: a pseudonymisation salt must not sit in the definition itself.
 * References inside the step (source, join, rules, derived values) are scoped
 * by refSurfaces.js like every other step's.
 */

const { isObject } = require('../helpers');

/** Findings of a spec onto the validator's two sinks. */
function report(ctx, findings, at) {
    for (const f of findings) {
        const record = {
            code: f.code,
            severity: f.severity,
            path: f.path ? `${at}.${f.path}` : at,
            message: f.message,
            ...(f.hint ? { hint: f.hint } : {}),
        };
        if (f.severity === 'error') ctx.pushE(record); else ctx.pushW(record);
    }
}

function checkReadTable(ctx, step, at) {
    if (step.type !== 'read_table') return;
    const { validateReadTableStep } = require('../../../core/automationModel/tableOps/readTableSpec');
    report(ctx, validateReadTableStep(step), at);
}

/**
 * A salt written into the definition's own `vars` travels with every export of
 * the automation, and anyone holding the export can re-derive the pseudonyms.
 * A Solution variable is the place for it.
 */
function checkSaltPlacement(ctx, step, at) {
    const own = ctx.graph && isObject(ctx.graph.vars) ? ctx.graph.vars : null;
    if (!own) return;
    (Array.isArray(step.ops) ? step.ops : []).forEach((op, i) => {
        if (!isObject(op) || op.op !== 'pseudonymise' || op.enabled === false) return;
        const name = typeof op.saltVar === 'string' ? op.saltVar : '';
        if (!name || !Object.prototype.hasOwnProperty.call(own, name)) return;
        ctx.pushW({
            code: 'table.salt_in_definition',
            severity: 'warning',
            path: `${at}.ops[${i}].saltVar`,
            message: `Step ${step.id}: the salt "${name}" is kept in this automation's own variables, so it travels with every export of the automation.`,
            hint: 'Keep the salt in a Solution variable instead, so the automation can be shared without it.',
        });
    });
}

/**
 * A pseudonymisation salt that no variable holds. Without it the first run
 * fails with table_salt_missing, so it is a completeness problem: a warning
 * while the flow is a draft, a block at activation. Only checked when the
 * caller supplied the declared Solution variable names (`knownVarNames`, a
 * Set); an unknown state never blocks. Names the automation keeps in its own
 * variables count as declared (checkSaltPlacement warns about those).
 */
function checkSaltDeclared(ctx, step, at) {
    const known = ctx.knownVarNames;
    if (!(known instanceof Set)) return;
    const own = ctx.graph && isObject(ctx.graph.vars) ? ctx.graph.vars : {};
    (Array.isArray(step.ops) ? step.ops : []).forEach((op, i) => {
        if (!isObject(op) || op.op !== 'pseudonymise' || op.enabled === false) return;
        const name = typeof op.saltVar === 'string' ? op.saltVar.trim() : '';
        if (!name || known.has(name) || Object.prototype.hasOwnProperty.call(own, name)) return;
        ctx.pushE({
            code: 'table.salt_var_missing',
            severity: 'error',
            path: `${at}.ops[${i}].saltVar`,
            message: `Step ${step.id}: the salt variable "${name}" has no value yet, so the first run would stop at this step.`,
            hint: 'Add a Solution variable with this name and give it a secret value of at least 16 characters, or pick another variable.',
        });
    });
}

function checkTable(ctx, step, at) {
    if (step.type !== 'table') return;
    const { validateTableStep } = /** @type {any} */ (require('../../../core/automationModel/tableOps/spec'));
    const { tableLimits } = require('../../../core/automationRunner/tables/limits');
    report(ctx, validateTableStep(step, { maxOps: tableLimits().maxOps }), at);
    checkSaltPlacement(ctx, step, at);
    checkSaltDeclared(ctx, step, at);
}

module.exports = { checkReadTable, checkTable, checkSaltPlacement, checkSaltDeclared };

/** @typedef {import('../../../core/automationModel/tableOps/readTableSpec').Finding} Finding */

/**
 * @typedef {import('./stepContext').StepCtx} StepCtx
 * @typedef {import('./stepContext').StepDef} StepDef
 */
