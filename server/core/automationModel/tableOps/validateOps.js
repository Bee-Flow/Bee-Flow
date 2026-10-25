// @typecheck strict
'use strict';
/**
 * Field checks per operation. Each checker gets the raw op `r` (what was
 * typed), the normalised op `n` (defaults filled) and `add`, which prefixes
 * the sentence with "Step 3 (Group): " and the path with "ops[2]".
 */

const { parseExpr } = require('../../../shared/expr/index.mjs');
const { SALT_VAR_RE, COLUMN_NAME_MAX_CHARS, isBinding, bindingBlank } = require('./constants');
const { normalizeRules } = require('./rules');
const { AGG_FNS } = require('./normalize');

/**
 * Reports one issue: severity, code, path under the op, sentence, optional hint.
 * @typedef {(severity: string, code: string, sub: string, message: string, hint?: string) => void} AddIssue
 */
/**
 * The raw op as typed; the fields compared against a fixed list are text.
 * @typedef {{ how?: string, onDuplicate?: string, mode?: string, percent?: string, match?: string,
 *   [key: string]: unknown }} RawOp
 */
/** @typedef {typeof import('./normalize').byOp} ByOp */

const E = 'error';
const W = 'warning';

/** @param {unknown} src */
const exprProblem = (src) => {
    try { parseExpr(String(src)); return null; } catch (e) { return String(e?.message || e).slice(0, 200); }
};

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['join']>} n
 * @param {AddIssue} add
 */
function join(r, n, add) {
    if (bindingBlank(n.with)) add(E, 'join_with_missing', '.with', 'pick the table to join with.', 'Choose a table from an earlier step, or a list of rows.');
    if (r.how !== undefined && !['left', 'inner'].includes(r.how)) add(E, 'join_how_invalid', '.how', 'choose "left" (keep every row) or "inner" (only rows with a match).');
    if (r.onDuplicate !== undefined && !['first', 'all'].includes(r.onDuplicate)) add(E, 'join_on_duplicate_invalid', '.onDuplicate', 'choose "first" or "all" for rows that match more than once.');
    if (!n.on.length) add(E, 'join_on_missing', '.on', 'pick the column that links both tables.', 'Add one to three pairs of columns that hold the same kind of value.');
    if (n.on.length > 3) add(E, 'join_on_too_many', '.on', 'link on at most three columns.');
    n.on.forEach((k, j) => {
        if (!k.left) add(E, 'join_on_missing', `.on[${j}].left`, 'pick the column of this table.');
        if (!k.right) add(E, 'join_on_missing', `.on[${j}].right`, 'pick the column of the table you join with.');
    });
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['pseudonymise']>} n
 * @param {AddIssue} add
 */
function pseudonymise(r, n, add) {
    if (!n.columns.length) add(E, 'pseudonymise_columns_missing', '.columns', 'pick the columns that identify a person.', 'Their values are replaced by a code that cannot be traced back.');
    if (n.columns.length > 10) add(E, 'pseudonymise_columns_too_many', '.columns', 'pick at most 10 columns.');
    if (!SALT_VAR_RE.test(n.saltVar)) {
        add(E, 'pseudonymise_salt_var_invalid', '.saltVar', 'name the variable that holds the secret value for the code.',
            'Use letters, digits and underscores, starting with a letter. Add a Solution variable with a long random value.');
    }
    if (r.length !== undefined && (!Number.isInteger(Number(r.length)) || Number(r.length) < 8 || Number(r.length) > 64)) {
        add(E, 'pseudonymise_length_invalid', '.length', 'the code length must be between 8 and 64 characters.');
    }
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['derive']>} n
 * @param {AddIssue} add
 */
function derive(r, n, add) {
    if (!n.columns.length) add(E, 'derive_columns_missing', '.columns', 'add at least one column to calculate.');
    if (n.columns.length > 20) add(E, 'derive_columns_too_many', '.columns', 'add at most 20 columns in one step.', 'Use a second step for the rest.');
    const seen = new Set();
    n.columns.forEach((c, j) => {
        const key = c.name.toLowerCase();
        if (!c.name || c.name.length > COLUMN_NAME_MAX_CHARS) {
            add(E, 'derive_name_invalid', `.columns[${j}].name`, `give column ${j + 1} a name of up to ${COLUMN_NAME_MAX_CHARS} characters.`);
        } else if (seen.has(key)) {
            add(E, 'derive_name_invalid', `.columns[${j}].name`, `the name "${c.name}" is used twice.`);
        }
        seen.add(key);
        if (bindingBlank(c.value)) {
            add(E, 'derive_value_missing', `.columns[${j}].value`, `column ${j + 1} has no value or formula.`);
        } else if (isBinding(c.value) && c.value.kind === 'expr') {
            const problem = exprProblem(c.value.value);
            if (problem) add(E, 'derive_expr_invalid', `.columns[${j}].value`, `the formula of column ${j + 1} cannot be read: ${problem}`, 'Refer to a cell as row["Column name"].');
        }
    });
}

/**
 * @param {ReturnType<ByOp['bucket']>} n
 * @param {AddIssue} add
 */
function bandChecks(n, add) {
    if (!n.bands.length) add(E, 'bucket_bands_invalid', '.bands', 'add at least one band.', 'Each band has a label and a lowest and/or highest value.');
    /** @type {{ j: number, lo: number, hi: number }[]} */
    const usable = [];
    n.bands.forEach((b, j) => {
        if (!b.label) add(E, 'bucket_bands_invalid', `.bands[${j}].label`, `band ${j + 1} needs a label.`);
        if (b.min !== null && b.max !== null && b.min >= b.max) {
            add(E, 'bucket_bands_invalid', `.bands[${j}]`, `band ${j + 1} starts at ${b.min} but ends at ${b.max}.`, 'The lowest value is included, the highest is not, so it must be lower than the highest.');
        } else usable.push({ j, lo: b.min ?? -Infinity, hi: b.max ?? Infinity });
    });
    usable.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    for (let i = 1; i < usable.length; i++) {
        if (usable[i - 1].hi > usable[i].lo) {
            add(E, 'bucket_bands_invalid', `.bands[${usable[i].j}]`, `band ${usable[i].j + 1} overlaps band ${usable[i - 1].j + 1}.`, 'A band includes its lowest value and stops just before its highest.');
        }
    }
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['bucket']>} n
 * @param {AddIssue} add
 */
function bucket(r, n, add) {
    if (!n.column) add(E, 'bucket_column_missing', '.column', 'pick the column to sort into groups.');
    if (r.mode !== undefined && !['bands', 'quantiles', 'values'].includes(r.mode)) add(E, 'bucket_mode_invalid', '.mode', 'choose bands, equal parts or listed values.');
    if (n.mode === 'bands') bandChecks(n, add);
    if (n.mode === 'quantiles' && n.labels && n.labels.length !== n.quantiles) {
        add(E, 'bucket_labels_invalid', '.labels', `give ${n.quantiles} labels, one for each part (now ${n.labels.length}).`);
    }
    if (n.mode === 'values') {
        if (!n.map.length) add(E, 'bucket_map_invalid', '.map', 'add at least one group of values.');
        n.map.forEach((m, j) => {
            if (!m.label) add(E, 'bucket_map_invalid', `.map[${j}].label`, `group ${j + 1} needs a label.`);
            if (!m.values.length) add(E, 'bucket_map_invalid', `.map[${j}].values`, `group ${j + 1} needs at least one value.`);
        });
    }
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['group']>} n
 * @param {AddIssue} add
 */
function group(r, n, add) {
    if (n.by.length > 5) add(E, 'group_by_too_many', '.by', 'group by at most 5 columns.');
    if (!n.aggregates.length) add(E, 'group_aggregate_invalid', '.aggregates', 'pick at least one value to calculate.', 'For example a count, or the sum of a column.');
    if (n.aggregates.length > 20) add(E, 'group_aggregate_invalid', '.aggregates', 'calculate at most 20 values in one step.');
    const names = new Set([...n.by.map((c) => c.toLowerCase()), 'n', 'suppressed']);
    n.aggregates.forEach((a, j) => {
        if (!AGG_FNS.includes(a.fn)) add(E, 'group_aggregate_invalid', `.aggregates[${j}].fn`, `value ${j + 1}: pick what to calculate.`);
        else if (!['count', 'share'].includes(a.fn) && !a.column) add(E, 'group_aggregate_invalid', `.aggregates[${j}].column`, `value ${j + 1}: pick the column to calculate on.`);
        if (names.has(a.as.toLowerCase())) add(E, 'group_aggregate_invalid', `.aggregates[${j}].as`, `the name "${a.as}" is used twice.`, 'Give each calculated value its own name.');
        names.add(a.as.toLowerCase());
    });
    const outputs = new Set([...n.by, ...n.aggregates.map((a) => a.as), 'n'].map((c) => c.toLowerCase()));
    n.sort.forEach((s, j) => {
        if (!s.column || !outputs.has(s.column.toLowerCase())) add(E, 'group_sort_invalid', `.sort[${j}].column`, `sort on one of the columns the result has (not "${s.column}").`);
    });
    if (r.minN !== undefined && Number(r.minN) < 0) add(E, 'group_min_n_invalid', '.minN', 'the minimum group size cannot be negative.');
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['pivot']>} n
 * @param {AddIssue} add
 */
function pivot(r, n, add) {
    if (!n.rows) add(E, 'pivot_rows_missing', '.rows', 'pick the column that makes the rows.');
    if (!n.columns) add(E, 'pivot_columns_missing', '.columns', 'pick the column that makes the columns.');
    if (n.rows && n.rows === n.columns) add(E, 'pivot_same_column', '.columns', 'rows and columns must be different columns.');
    if (n.value.fn !== 'count' && !n.value.column) add(E, 'pivot_value_invalid', '.value.column', `pick the column to ${n.value.fn === 'sum' ? 'add up' : 'average'}.`);
    if (r.percent !== undefined && !['none', 'row', 'column', 'total'].includes(r.percent)) add(E, 'pivot_percent_invalid', '.percent', 'choose none, row, column or total.');
    if (n.percent !== 'none' && n.value.fn === 'mean') add(W, 'pivot_percent_mean', '.percent', 'percentages of an average are not meaningful and are ignored.', 'Use a count or a sum for percentages.');
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['filter']>} n
 * @param {AddIssue} add
 */
function filter(r, n, add) {
    if (r.match !== undefined && !['all', 'any'].includes(r.match)) add(E, 'filter_match_invalid', '.match', 'choose "all" or "any".');
    const { errors } = normalizeRules(n.rules);
    for (const e of errors) add(E, 'filter_rule_invalid', `.rules[${e.index}]${e.field === 'rule' ? '' : `.${e.field}`}`, `rule ${e.index + 1}: ${e.message}`);
    if (n.expr) {
        const problem = exprProblem(n.expr);
        if (problem) add(E, 'filter_expr_invalid', '.expr', `the formula cannot be read: ${problem}`, 'Refer to a cell as row["Column name"].');
    }
    if (!n.rules.length && !n.rulesFrom && !n.expr) add(W, 'filter_empty', '', 'no rule is set, so every row is kept.');
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['select']>} n
 * @param {AddIssue} add
 */
function select(r, n, add) {
    if (n.keep && n.drop) add(E, 'select_conflict', '', 'choose either the columns to keep or the columns to drop, not both.');
    n.rename.forEach((x, j) => {
        if (!x.from || !x.to) add(E, 'select_rename_invalid', `.rename[${j}]`, `rename ${j + 1} needs the old and the new name.`);
    });
    const targets = n.rename.map((x) => x.to.toLowerCase()).filter(Boolean);
    if (new Set(targets).size !== targets.length) add(E, 'select_rename_invalid', '.rename', 'two columns get the same new name.');
    if (!n.keep && !n.drop && !n.rename.length) add(W, 'select_empty', '', 'nothing is kept, dropped or renamed, so the columns stay as they are.');
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['sample']>} n
 * @param {AddIssue} add
 */
function sample(r, n, add) {
    const { n: gotN, percent: gotP } = n._given;
    if (gotN === gotP) {
        add(E, 'sample_size_invalid', gotN ? '.percent' : '.n', gotN ? 'give either a number of rows or a percentage, not both.' : 'give a number of rows or a percentage.');
    } else if (gotN && n.n === null) {
        add(E, 'sample_size_invalid', '.n', 'the number of rows must be 1 or more.');
    } else if (gotP && n.percent === null) {
        add(E, 'sample_size_invalid', '.percent', 'the percentage must be above 0 and at most 100.');
    }
    if (r.mode !== undefined && !['first', 'random'].includes(r.mode)) add(E, 'sample_mode_invalid', '.mode', 'choose first rows or a random sample.');
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['groups']>} n
 * @param {AddIssue} add
 */
function groups(r, n, add) {
    if (!n.splits.length) add(E, 'groups_splits_missing', '.splits', 'pick at least one column to split on.');
    if (n.splits.length > 10) add(E, 'groups_splits_too_many', '.splits', 'split on at most 10 columns.');
    n.splits.forEach((s, j) => {
        if (!s.column) add(E, 'groups_column_missing', `.splits[${j}].column`, `split ${j + 1}: pick a column.`);
    });
    if (n.minN < 30) {
        add(W, 'groups_min_n_low', '.minN', `the minimum group size is only ${n.minN}.`,
            'Small groups can point at individuals. 30 is a safe minimum; the organisation can set a stricter one.');
    }
}

/**
 * @param {RawOp} r
 * @param {ReturnType<ByOp['describe']>} n
 * @param {AddIssue} add
 */
function describe(r, n, add) {
    if (r.columns !== undefined && r.columns !== null && !Array.isArray(r.columns)) add(E, 'describe_columns_invalid', '.columns', 'the columns must be a list.');
}

const CHECKS = { join, pseudonymise, derive, bucket, group, pivot, filter, select, sample, groups, describe };

module.exports = { CHECKS };
