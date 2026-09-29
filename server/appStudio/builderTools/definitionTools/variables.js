/**
 * App Studio builder tools — the app-wide VARIABLES (app_set_variables).
 */

'use strict';

const { LIMITS } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { adoptCanonical } = require('../shared');

/**
 * Declare the app-wide variables. Whole-list replace, mirroring app_set_roles.
 *
 * A name the model gets wrong is REPAIRED by canonicalize and surfaced as a
 * hint rather than an error, which is how the model learns the grammar from
 * its own output. Dropping a name a formula still reads is likewise a hint,
 * not a refusal — the reads keep working off whatever writes them, and telling
 * the model beats blocking it mid-plan.
 */
function applySetVariables(draftWrap, args) {
    if (!Array.isArray(args?.variables)) {
        return { error: 'Pass `variables` as an array of { name, type, label?, default?, description? }.' };
    }
    if (args.variables.length > LIMITS.MAX_VARIABLES) {
        return { error: `variables: max ${LIMITS.MAX_VARIABLES} variables.` };
    }

    const before = new Set((draftWrap.def.variables || []).map((v) => v && v.name).filter(Boolean));
    const next = ops.setVariables(draftWrap.def, args.variables);
    // ECHO AFTER ADOPTION. Built as an argument to adoptCanonical this read the
    // PREVIOUS list — call 1 returned [], call 2 returned call 1's variables —
    // so a model that trusts its own tool results concluded the tool silently
    // did nothing and started changing the payload until the echo looked right.
    // Nothing about the payload was ever wrong. Every echo in this file must be
    // read off draftWrap.def AFTER adoptCanonical has reassigned it.
    const result = adoptCanonical(draftWrap, next, {});
    result.variables = (draftWrap.def.variables || []).map((v) => ({ name: v.name, type: v.type, default: v.default }));

    const after = new Set((draftWrap.def.variables || []).map((v) => v.name));
    const dropped = [...before].filter((n) => !after.has(n));
    if (dropped.length) {
        const read = dropped.filter((n) => JSON.stringify(draftWrap.def).includes(`vars.${n}`));
        if (read.length) {
            result._hints = [
                ...(result._hints || []),
                `Formulas still read ${read.map((n) => `vars.${n}`).join(', ')} — re-declare them or fix those formulas.`,
            ];
        }
    }
    return result;
}

module.exports = { applySetVariables };
