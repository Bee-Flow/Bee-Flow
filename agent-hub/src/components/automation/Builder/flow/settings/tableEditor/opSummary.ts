import type { OpKind, TableOp } from './tableOpModel';
import type { Translate } from './opHelp';

const names = (list: readonly string[] | null | undefined, max = 3): string => {
    const items = (list || []).filter(Boolean);
    return items.length > max ? `${items.slice(0, max).join(', ')}, …` : items.join(', ');
};

type Summary<K extends OpKind> = (op: Extract<TableOp, { op: K }>, t: Translate) => string;

const join: Summary<'join'> = (op, t) => {
    const key = op.on[0];
    return key && key.left && key.right ? t('automation_tables.summary.join', 'On {left} = {right}', { left: key.left, right: key.right }) : '';
};

const filter: Summary<'filter'> = (op, t) => {
    const n = op.rules.length + (op.rulesFrom ? 1 : 0) + (op.expr ? 1 : 0);
    return n ? t('automation_tables.summary.filter', '{count} rules', { count: n }) : '';
};

const select: Summary<'select'> = (op, t) => {
    if (op.keep) return t('automation_tables.summary.select_keep', 'Keep {columns}', { columns: names(op.keep) });
    if (op.drop) return t('automation_tables.summary.select_drop', 'Remove {columns}', { columns: names(op.drop) });
    return op.rename.length ? t('automation_tables.summary.select_rename', '{count} renamed', { count: op.rename.length }) : '';
};

const sample: Summary<'sample'> = (op, t) => {
    if (op.percent !== null && op.n === null) return t('automation_tables.summary.sample_percent', '{percent}% of the rows', { percent: op.percent });
    return op.n === null ? '' : t('automation_tables.summary.sample_rows', '{count} rows', { count: op.n });
};

const SUMMARIES: { [K in OpKind]: Summary<K> } = {
    join,
    filter,
    select,
    sample,
    derive: op => names(op.columns.map(c => c.name)),
    bucket: (op, t) => (op.column ? t('automation_tables.summary.bucket', '{column} into bands', { column: op.column }) : ''),
    group: (op, t) => (op.by.length ? t('automation_tables.summary.group', 'By {columns}', { columns: names(op.by) }) : t('automation_tables.summary.group_all', 'The whole table')),
    pivot: (op, t) => (op.rows && op.columns ? t('automation_tables.summary.pivot', '{rows} by {columns}', { rows: op.rows, columns: op.columns }) : ''),
    groups: op => names(op.splits.map(s => s.column)),
    pseudonymise: op => names(op.columns),
    describe: (op, t) => (op.columns ? names(op.columns) : t('automation_tables.summary.describe_all', 'All columns')),
};

/** One short line on what an operation is set to do, for its row in the list. Empty when it is not set up yet. */
export function opSummary(op: TableOp, t: Translate): string {
    const summary = SUMMARIES[op.op] as (op: TableOp, t: Translate) => string;
    return summary ? summary(op, t) : '';
}
