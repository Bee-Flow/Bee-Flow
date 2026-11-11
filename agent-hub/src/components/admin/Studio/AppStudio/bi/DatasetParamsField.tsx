import { inputCls, RepeatableList } from '@/components/admin/product-website/fields';
import useTranslation from '@/hooks/useTranslation';
import { opsFor } from './FilterRowsEditor.helpers';
import { isParamOp, paramProblems, paramTypeFor, type ParamProblem, type ParamRow } from './datasetParamRows';
import type { TableColumn } from '../inspector/aiFieldMatching';

/**
 * The dataset builder's "Parameters" list: filters whose value the component
 * that shows the view fills in, so one view can serve many screens. What a row
 * turns into is datasetParamRows.ts.
 */

const MAX_PARAMS = 10;

const PROBLEM_TEXT: Record<ParamProblem, [string, string]> = {
    name: ['studio_apps_dataset_params.builder.bad_name', 'A name starts with a letter and holds only letters, digits and _.'],
    duplicate: ['studio_apps_dataset_params.builder.duplicate', 'Each parameter needs a name of its own.'],
    field: ['studio_apps_dataset_params.builder.no_field', 'Pick the column this parameter filters.'],
    default: ['studio_apps_dataset_params.builder.bad_default', 'The default does not fit this column.'],
};

function DefaultControl({ row, type, onChange }: { row: ParamRow; type: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    const label = t('studio_apps_dataset_params.builder.default_aria', 'Default value');
    if (type === 'boolean') {
        return (
            <select className={inputCls} value={row.defaultValue} onChange={(e) => onChange(e.target.value)} aria-label={label}>
                <option value="">{t('studio_apps_dataset_params.builder.no_default', 'No default')}</option>
                <option value="true">{t('studio_apps_dataset_params.builder.yes', 'Yes')}</option>
                <option value="false">{t('studio_apps_dataset_params.builder.no', 'No')}</option>
            </select>
        );
    }
    return (
        <input
            type={type === 'date' ? 'date' : 'text'}
            inputMode={type === 'number' ? 'decimal' : undefined}
            className={inputCls}
            value={row.defaultValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('studio_apps_dataset_params.builder.default', 'Default (optional)')}
            aria-label={label}
        />
    );
}

export default function DatasetParamsField({ rows, onChange, fields }: { rows: ParamRow[]; onChange: (rows: ParamRow[]) => void; fields: TableColumn[] }) {
    const { t } = useTranslation();
    const problems = paramProblems(rows, fields);
    return (
        <fieldset className="min-w-0 flex flex-col gap-1.5">
            <RepeatableList
                label={t('studio_apps_dataset_params.builder.title', 'Parameters')}
                items={rows}
                onChange={onChange}
                maxItems={MAX_PARAMS}
                makeNew={() => ({ name: '', field: '', op: 'eq', defaultValue: '', required: false })}
                addLabel={t('studio_apps_dataset_params.builder.add', 'Add a parameter')}
                itemLabel={(row) => row.name || t('studio_apps_dataset_params.builder.unnamed', 'New parameter')}
                renderItem={(row, update, idx) => {
                    const field = fields.find((f) => f.key === row.field) || null;
                    const problem = problems[idx];
                    return (
                        <div className="flex flex-col gap-2">
                            <input
                                type="text"
                                className={inputCls}
                                value={row.name}
                                onChange={(e) => update({ ...row, name: e.target.value.trim() })}
                                placeholder={t('studio_apps_dataset_params.builder.name', 'Name, e.g. region')}
                                aria-label={t('studio_apps_dataset_params.builder.name_aria', 'Parameter name')}
                                spellCheck={false}
                            />
                            <div className="grid grid-cols-2 gap-2">
                                <select className={inputCls} value={row.field} onChange={(e) => update({ ...row, field: e.target.value, op: 'eq', defaultValue: '' })} aria-label={t('studio_apps_dataset_params.builder.field_aria', 'Column the parameter filters')}>
                                    <option value="">{t('studio_apps_dataset_params.builder.pick_field', 'Pick a column…')}</option>
                                    {fields.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                                </select>
                                <select className={inputCls} value={row.op} onChange={(e) => update({ ...row, op: e.target.value })} aria-label={t('studio_apps_dataset_params.builder.op_aria', 'Comparison')}>
                                    {opsFor(field, row.op, t).filter((o) => isParamOp(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                            </div>
                            <DefaultControl row={row} type={paramTypeFor(field?.type)} onChange={(defaultValue) => update({ ...row, defaultValue })} />
                            <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                                <input type="checkbox" checked={row.required} onChange={(e) => update({ ...row, required: e.target.checked })} className="accent-[var(--accent-primary)]" />
                                {t('studio_apps_dataset_params.builder.required', 'Without a value, show nothing (instead of ignoring this filter)')}
                            </label>
                            {problem ? <p className="text-xs text-[var(--error)]" role="alert">{t(PROBLEM_TEXT[problem][0], PROBLEM_TEXT[problem][1])}</p> : null}
                        </div>
                    );
                }}
            />
            {rows.length ? (
                <p className="text-[11px] text-[var(--text-muted)]">
                    {t('studio_apps_dataset_params.builder.access_note', 'The component that shows this view fills in each value. A parameter narrows what the view shows; who may see which rows is still decided by the table’s access rules.')}
                </p>
            ) : null}
        </fieldset>
    );
}
