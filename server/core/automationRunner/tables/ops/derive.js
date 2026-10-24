// @typecheck
'use strict';
/**
 * derive: add or replace columns from a value, a reference, a template or a
 * formula, evaluated per row with scope { ...runState, row, rowIndex }. A
 * formula is read once. A row that fails gets an empty cell and one counted
 * warning.
 */

const { parseExpr, evaluate } = require('../../expr');
const bind = require('../../../automationModel/bind');
const { isBinding } = require('../../../automationModel/tableOps/constants');
const { tableError, toScalar, makeColumn } = require('./values');

const short = (e) => String(e?.message || e).slice(0, 160);

/** One column's evaluator: (scope) => value. */
function compileValue(value, opId, field) {
    if (!isBinding(value)) return () => value;
    switch (value.kind) {
        case 'literal': return () => value.value;
        case 'ref': return (scope) => bind.walkPath(value.path, scope);
        case 'template': return (scope) => bind.interpolateTemplate(value.value || '', scope);
        case 'expr': {
            let ast;
            try { ast = parseExpr(String(value.value ?? '')); } catch (e) {
                throw tableError('table_op_invalid', `The formula cannot be read: ${short(e)}`, { opId, field });
            }
            return (scope) => evaluate(ast, scope);
        }
        default: return () => null;
    }
}

function apply(op, input, ctx) {
    if (!op.columns.length) throw tableError('table_op_invalid', 'Add at least one column to calculate.', { opId: op.id, field: 'columns' });
    const evaluators = op.columns.map((c, i) => {
        if (!c.name) throw tableError('table_op_invalid', `Give column ${i + 1} a name.`, { opId: op.id, field: `columns[${i}].name` });
        return { name: c.name, run: compileValue(c.value, op.id, `columns[${i}].value`) };
    });
    let columns = input.columns;
    for (const e of evaluators) {
        const at = columns.findIndex((c) => c.key === e.name);
        columns = at >= 0 ? columns.map((c, i) => (i === at ? makeColumn(e.name) : c)) : [...columns, makeColumn(e.name)];
    }

    async function* rows() {
        const scope = { ...ctx.runState, row: null, rowIndex: 0 };
        let index = 0;
        let failed = 0;
        let firstError = null;
        for await (const row of input.rows()) {
            await ctx.tick();
            const out = { ...row };
            scope.row = out;
            scope.rowIndex = index++;
            for (const e of evaluators) {
                try { out[e.name] = toScalar(e.run(scope)); } catch (err) {
                    out[e.name] = null;
                    failed++;
                    firstError = firstError || short(err);
                }
            }
            yield out;
        }
        if (failed) ctx.warn(`${failed} value${failed === 1 ? '' : 's'} could not be calculated and ${failed === 1 ? 'was' : 'were'} left empty (first error: ${firstError}).`, 'derive_failed');
    }
    return { columns, rows };
}

module.exports = { apply };
