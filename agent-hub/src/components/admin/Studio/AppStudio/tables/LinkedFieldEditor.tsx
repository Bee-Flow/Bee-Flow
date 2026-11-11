import useTranslation from '@/hooks/useTranslation';
import {
    ON_DELETE_RULES, ROLLUP_FNS, isManyRelation, lookupOf, lookupRelations, lookupTargetFields,
    rollupNumberFields, rollupOf, rollupSources, withMany, withOnDelete,
} from './linkedFieldsModel';
import type { ModelField, ModelTable } from './tablesManagerModel';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * App Studio table editor — the options of a field that reads through other records: a lookup
 * (a field of the record a relation points at), a rollup (a figure over the records pointing
 * here), and the many and onDelete options of a relation. A rollup's filter is kept as it is
 * (the assistant writes it); this editor only says that it is there.
 */

const SELECT_CLS = 'w-full px-3 py-2 text-sm rounded-md border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)] disabled:opacity-50';
const LABEL_CLS = 'flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]';
const HINT_CLS = 'text-xs text-[var(--text-tertiary)]';

interface LinkedFieldEditorProps {
    field: ModelField;
    update: (next: ModelField) => void;
    tables?: ModelTable[] | null;
    table?: ModelTable | null;
    disabled: boolean;
}

interface PickProps {
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    disabled: boolean;
    empty?: string;
}

function Pick({ label, value, options, onChange, disabled, empty }: PickProps) {
    return (
        <label className={LABEL_CLS}>
            {label}
            <select className={SELECT_CLS} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={label}>
                {empty !== undefined ? <option value="">{empty}</option> : null}
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                {value && !options.some((o) => o.value === value) ? <option value={value}>{value}</option> : null}
            </select>
        </label>
    );
}

const named = (fields: ModelField[]) => fields.map((f) => ({ value: f.key as string, label: f.name || (f.key as string) }));

function RelationOptions({ field, update, disabled, t }: LinkedFieldEditorProps & { t: TranslateFn }) {
    const many = isManyRelation(field);
    const rule = String((field.relation as Record<string, unknown> | undefined)?.onDelete || '');
    const ruleLabels: Record<string, string> = {
        restrict: t('studio_apps_di.on_delete_restrict', 'Refuse the delete'),
        setNull: t('studio_apps_di.on_delete_set_null', 'Empty this field'),
        cascade: t('studio_apps_di.on_delete_cascade', 'Delete these records too'),
    };
    return (
        <div className="flex flex-col gap-2">
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-[var(--text-secondary)]">
                <input type="checkbox" className="accent-[var(--accent-primary)]" checked={many} disabled={disabled} onChange={(e) => update(withMany(field, e.target.checked))} />
                {t('studio_apps_di.many', 'Holds several records')}
            </label>
            {many ? <p className={HINT_CLS}>{t('studio_apps_di.many_hint', 'Its value is a list of records. Filter on it with “contains”.')}</p> : (
                <>
                    <Pick label={t('studio_apps_di.on_delete', 'When the linked record is deleted')} value={rule} disabled={disabled}
                        empty={t('studio_apps_di.on_delete_default', 'Default')}
                        options={ON_DELETE_RULES.map((r) => ({ value: r, label: ruleLabels[r] }))}
                        onChange={(v) => update(withOnDelete(field, v))} />
                    {rule ? <p className={HINT_CLS}>{t('studio_apps_di.on_delete_hint', 'The person deleting must be allowed to change or delete every linked record, or nothing is deleted.')}</p> : null}
                </>
            )}
        </div>
    );
}

function LookupOptions({ field, update, tables, table, disabled, t }: LinkedFieldEditorProps & { t: TranslateFn }) {
    const spec = lookupOf(field);
    const set = (patch: Record<string, string>) => update({ ...field, lookup: { ...spec, ...patch } });
    return (
        <div className="flex flex-col gap-2">
            <Pick label={t('studio_apps_di.lookup_relation', 'Through relation')} value={spec.relation || ''} disabled={disabled}
                empty={t('studio_apps_di.choose', 'Choose…')} options={named(lookupRelations(table))}
                onChange={(v) => set({ relation: v, field: '' })} />
            <Pick label={t('studio_apps_di.lookup_field', 'Show field')} value={spec.field || ''} disabled={disabled || !spec.relation}
                empty={t('studio_apps_di.choose', 'Choose…')} options={named(lookupTargetFields(tables, table, spec.relation))}
                onChange={(v) => set({ field: v })} />
            <p className={HINT_CLS}>{t('studio_apps_di.lookup_hint', 'Read-only. Shows the field of the linked record, and stays empty when the viewer may not see that record.')}</p>
        </div>
    );
}

function RollupOptions({ field, update, tables, table, disabled, t }: LinkedFieldEditorProps & { t: TranslateFn }) {
    const spec = rollupOf(field);
    const set = (patch: Record<string, unknown>) => update({ ...field, rollup: { ...spec, ...patch } });
    const sources = rollupSources(tables, table?.id);
    const sourceValue = spec.table && spec.relation ? `${spec.table}:${spec.relation}` : '';
    const fnLabels: Record<string, string> = {
        count: t('studio_apps_di.fn_count', 'Count'), sum: t('studio_apps_di.fn_sum', 'Sum'), min: t('studio_apps_di.fn_min', 'Lowest'),
        max: t('studio_apps_di.fn_max', 'Highest'), avg: t('studio_apps_di.fn_avg', 'Average'),
    };
    const filters = Array.isArray(spec.filter) ? spec.filter.length : 0;
    return (
        <div className="flex flex-col gap-2">
            <Pick label={t('studio_apps_di.rollup_source', 'Records that point here')} value={sourceValue} disabled={disabled}
                empty={t('studio_apps_di.choose', 'Choose…')}
                options={sources.map((s) => ({ value: `${s.table.id}:${s.relation.key}`, label: `${s.table.name || s.table.key} · ${s.relation.name || s.relation.key}` }))}
                onChange={(v) => { const [tableId, relation] = v.split(':'); set({ table: tableId || undefined, relation: relation || undefined, field: undefined }); }} />
            <Pick label={t('studio_apps_di.rollup_fn', 'Calculate')} value={spec.fn || 'count'} disabled={disabled}
                options={ROLLUP_FNS.map((fn) => ({ value: fn, label: fnLabels[fn] }))}
                onChange={(v) => set({ fn: v, ...(v === 'count' ? { field: undefined } : {}) })} />
            {spec.fn && spec.fn !== 'count' ? (
                <Pick label={t('studio_apps_di.rollup_field', 'Of field')} value={spec.field || ''} disabled={disabled}
                    empty={t('studio_apps_di.choose', 'Choose…')} options={named(rollupNumberFields(tables, spec.table))}
                    onChange={(v) => set({ field: v || undefined })} />
            ) : null}
            {filters ? <p className={HINT_CLS}>{t('studio_apps_di.rollup_filter_kept', 'Only records that match {n} filter rule(s) are counted; the rules are kept as they are.', { n: filters })}</p> : null}
            <p className={HINT_CLS}>{t('studio_apps_di.rollup_hint', 'Read-only. Only the records the viewer may see are counted.')}</p>
        </div>
    );
}

export default function LinkedFieldEditor(props: LinkedFieldEditorProps) {
    const { t } = useTranslation();
    if (props.field.type === 'relation') return <RelationOptions {...props} t={t} />;
    if (props.field.type === 'lookup') return <LookupOptions {...props} t={t} />;
    if (props.field.type === 'rollup') return <RollupOptions {...props} t={t} />;
    return null;
}
