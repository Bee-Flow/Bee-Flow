'use strict';
/**
 * filter: keep the rows that pass the rules, the rules fed in at run time and
 * the formula. Lazy: rows flow through one at a time.
 */

const { parseExpr, evaluate } = require('../../expr');
const { resolveValue } = require('../../../automationModel/bind');
const { normalizeRules, compileRule } = require('../../../automationModel/tableOps/rules');
const { isBinding } = require('../../../automationModel/tableOps/constants');
const { tableError, requireColumn } = require('./values');

const short = (e) => String(e?.message || e).slice(0, 160);

/** Resolve value bindings once, check the list, bind each rule to a column. Throws table_rule_invalid. */
function prepareRules(rawRules, columns, ctx, where, label) {
    const resolved = (Array.isArray(rawRules) ? rawRules : []).map((r) => (r && typeof r === 'object' && isBinding(r.value)
        ? { ...r, value: resolveValue(r.value, ctx.runState) }
        : r));
    const { rules, errors } = normalizeRules(resolved);
    if (errors.length) {
        const e = errors[0];
        throw tableError('table_rule_invalid', `${label} ${e.index + 1}: ${e.message}`, { ...where, field: `${where.field || 'rules'}[${e.index}]` });
    }
    return rules.map((rule, index) => {
        let col;
        try { col = requireColumn(columns, rule.column, where); } catch (err) {
            throw tableError('table_rule_invalid', `${label} ${index + 1}: ${err.message}`, { ...where, field: `${where.field || 'rules'}[${index}].column` });
        }
        const test = compileRule(rule);
        return (row) => test(row[col.key]);
    });
}

const combine = (tests, mode) => {
    if (!tests.length) return null;
    return mode === 'any' ? (row) => tests.some((t) => t(row)) : (row) => tests.every((t) => t(row));
};

function apply(op, input, ctx) {
    const where = { opId: op.id, field: 'rules' };
    const own = combine(prepareRules(op.rules, input.columns, ctx, where, 'Rule'), op.match);

    let fed = null;
    if (op.rulesFrom) {
        if (ctx.mode === 'preview') {
            ctx.warn('The rules that come from an earlier step are applied when the automation runs, not in the preview.', 'rules_from_runtime');
        } else {
            const list = resolveValue(op.rulesFrom, ctx.runState);
            if (!Array.isArray(list)) {
                throw tableError('table_rule_invalid', 'The rules from an earlier step did not resolve to a list of rules. Re-run the step that makes them.', { opId: op.id, field: 'rulesFrom' });
            }
            fed = combine(prepareRules(list, input.columns, ctx, { opId: op.id, field: 'rulesFrom' }, 'Rule from earlier step'), op.rulesFromMatch);
        }
    }

    let ast = null;
    if (op.expr) {
        try { ast = parseExpr(op.expr); } catch (e) {
            throw tableError('table_op_invalid', `The formula cannot be read: ${short(e)}`, { opId: op.id, field: 'expr' });
        }
    }

    async function* rows() {
        const scope = { ...ctx.runState, row: null };
        let failed = 0;
        let firstError = null;
        for await (const row of input.rows()) {
            await ctx.tick();
            if (own && !own(row)) continue;
            if (fed && !fed(row)) continue;
            if (ast) {
                scope.row = row;
                let keep = false;
                try { keep = !!evaluate(ast, scope); } catch (e) { failed++; firstError = firstError || short(e); }
                if (!keep) continue;
            }
            yield row;
        }
        if (failed) ctx.warn(`The formula failed for ${failed} row${failed === 1 ? '' : 's'}; those rows were left out (first error: ${firstError}).`, 'filter_expr_failed');
    }
    return { columns: input.columns, rows };
}

module.exports = { apply, prepareRules };
