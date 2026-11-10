import { RepeatableList } from '@/components/admin/product-website/fields';
import type { TranslateFn } from '@/hooks/useTranslation';
import { GROUP_FILTER_OPS, type GroupFilterOp, type GroupFilterRow } from './aggregateExtras';

const OP_LABELS: Record<GroupFilterOp, [string, string]> = {
    gte: ['studio_apps_aggregates.op_gte', 'is at least'],
    gt: ['studio_apps_aggregates.op_gt', 'is more than'],
    eq: ['studio_apps_aggregates.op_eq', 'is'],
    neq: ['studio_apps_aggregates.op_neq', 'is not'],
    lt: ['studio_apps_aggregates.op_lt', 'is less than'],
    lte: ['studio_apps_aggregates.op_lte', 'is at most'],
};

/** One measure of the query, as the group filter offers it. */
export interface GroupFilterMeasure {
    label: string;
    numeric: boolean;
}

interface GroupFilterFieldProps {
    t: TranslateFn;
    rows: GroupFilterRow[];
    setRows: (rows: GroupFilterRow[]) => void;
    measures: GroupFilterMeasure[];
    inputClass: string;
}

/**
 * "Only keep groups where": a number the query works out (a count, a sum, …)
 * compared with a value, per group. Empty by default, and then the query has
 * no groupFilter at all.
 */
export default function GroupFilterField({ t, rows, setRows, measures, inputClass }: GroupFilterFieldProps) {
    const numeric = measures.map((m, i) => ({ ...m, i })).filter((m) => m.numeric);
    if (!numeric.length && !rows.length) {
        return (
            <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_aggregates.group_filter_label', 'Only keep groups where')}</span>
                <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_aggregates.group_filter_none', 'Add a count, sum or average first.')}</p>
            </div>
        );
    }
    const opLabel = (op: GroupFilterOp) => t(OP_LABELS[op][0], OP_LABELS[op][1]);
    return (
        <fieldset className="min-w-0">
            <RepeatableList
                label={t('studio_apps_aggregates.group_filter_label', 'Only keep groups where')}
                items={rows}
                onChange={setRows}
                makeNew={(): GroupFilterRow => ({ measure: numeric[0]?.i ?? 0, op: 'gte', value: '' })}
                addLabel={t('studio_apps_aggregates.group_filter_add', 'Add a condition')}
                itemLabel={(r) => t('studio_apps_aggregates.group_filter_item', '{measure} {op} {value}', { measure: measures[r.measure]?.label || '…', op: opLabel(r.op), value: r.value || '…' })}
                renderItem={(r, update) => (
                    <div className="flex flex-col gap-2">
                        <select className={inputClass} value={String(r.measure)} onChange={(e) => update({ ...r, measure: Number(e.target.value) })} aria-label={t('studio_apps_aggregates.group_filter_measure', 'Which number')}>
                            {numeric.length ? null : <option value="">{t('studio_apps_aggregates.pick_number', 'Pick a number…')}</option>}
                            {numeric.map((m) => <option key={m.i} value={String(m.i)}>{m.label}</option>)}
                        </select>
                        <div className="flex items-center gap-2 min-w-0">
                            <select className={inputClass} value={r.op} onChange={(e) => update({ ...r, op: e.target.value as GroupFilterOp })} aria-label={t('studio_apps_aggregates.group_filter_op', 'Comparison')}>
                                {GROUP_FILTER_OPS.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
                            </select>
                            <input type="number" className={inputClass} value={r.value} onChange={(e) => update({ ...r, value: e.target.value })} aria-label={t('studio_apps_aggregates.group_filter_value', 'Value')} />
                        </div>
                    </div>
                )}
            />
        </fieldset>
    );
}
