/**
 * The `flatten` step's own shape (spec F3-F7): a route with at least one
 * `[*]` level, `parents` that fit that route, and well formed column plans.
 * The plan itself is made by shared/expr/flatten.mjs; this only checks what
 * was stored.
 */

const { normalizeFlattenRoute, checkFlattenParents } = require('../../expr');
const { checkMaxItems } = require('../fieldChecks');

const PARENTS_HINT = {
    count: 'Keep one entry in `parents` for each `[*]` in `arrayRef`, outermost first.',
    overRef: 'Each `parents[i].overRef` must be the part of `arrayRef` before its `[*]`.',
    itemVar: 'Give each level its own short name, such as `message`; not `item`, `loop`, `steps` or the child\'s name.',
};

function checkFlattenRoute(ctx, step, at) {
    if (!step.arrayRef || typeof step.arrayRef !== 'string') {
        ctx.pushE({ code: 'flatten.arrayRef_missing', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: pick the list to flatten.`, hint: 'Bind to a list whose items each hold a list, e.g. `steps.<id>.output.messages[*].attachments`.' });
        return false;
    }
    if (!normalizeFlattenRoute(step.arrayRef)) {
        ctx.pushE({ code: 'flatten.level_missing', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: pick which list inside each item to make rows from.`, hint: 'Add the inner list after `[*]`, e.g. `steps.<id>.output.messages[*].attachments`.' });
        return false;
    }
    return true;
}

function checkFlattenColumns(ctx, step, at) {
    const reason = checkFlattenParents(step);
    if (reason === 'fields') {
        ctx.pushE({ code: 'flatten.fields_invalid', severity: 'error', path: at + '.parents', message: `Step ${step.id}: a copied field is malformed or two fields land under the same name.`, hint: 'Each entry is `{ from, to, mode }` with `mode` copy or fill, and every `to` is used once.' });
    } else if (reason) {
        ctx.pushE({ code: 'flatten.parents_invalid', severity: 'error', path: at + '.parents', message: `Step ${step.id}: the stored levels do not fit the list it flattens.`, hint: PARENTS_HINT[reason] });
    } else if (!Array.isArray(step.parents) || step.parents.some(p => !Array.isArray(p?.fields))) {
        ctx.pushW({ code: 'flatten.columns_unsaved', severity: 'warning', path: at + '.parents', message: `Step ${step.id}: open this step once so its columns are fixed.`, hint: 'Until then the run picks the copied fields from its own data, so the columns can change between runs.' });
    }
}

function checkFlatten(ctx, step, at) {
    if (step.type !== 'flatten') return;
    checkMaxItems(step, at, ctx.pushE, ctx.pushW);
    if (checkFlattenRoute(ctx, step, at)) checkFlattenColumns(ctx, step, at);
}

module.exports = { checkFlatten };
