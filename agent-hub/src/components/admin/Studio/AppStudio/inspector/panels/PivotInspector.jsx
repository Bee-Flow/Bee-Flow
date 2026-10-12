import React from 'react';
import BindingField from './BindingField';
import { TextField , usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { ConfigureDataButton } from '../../bi/QueryBuilder';
import { registerInspector } from '../registry';

function DimList({ label, addLabel, items, onChange, disabled }) {
    const { t } = useTranslation();
    return (
        <fieldset disabled={disabled} className="min-w-0">
            <RepeatableList
                label={label}
                items={items || []}
                onChange={onChange}
                makeNew={() => ({ key: '', label: '' })}
                addLabel={addLabel}
                itemLabel={(d) => d.label || d.key}
                renderItem={(d, update) => (
                    <div className="flex flex-col gap-2">
                        <input type="text" className={inputCls} value={d.key || ''} onChange={(e) => update({ ...d, key: e.target.value })} placeholder={t('studio_apps_panels.pivot.field_key', 'Field key')} spellCheck={false} />
                        <input type="text" className={inputCls} value={d.label || ''} onChange={(e) => update({ ...d, label: e.target.value })} placeholder={t('studio_apps_panels.common.heading_optional', 'Heading (optional)')} />
                    </div>
                )}
            />
        </fieldset>
    );
}

/** Content panel for pivot. Props mirror componentSpecs.js (authoritative). */
export default function PivotInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const AGGS = [
        { value: 'sum', label: t('studio_apps_panels.pivot.agg_sum', 'sum') },
        { value: 'avg', label: t('studio_apps_panels.pivot.agg_avg', 'avg') },
        { value: 'count', label: t('studio_apps_panels.pivot.agg_count', 'count') },
        { value: 'min', label: t('studio_apps_panels.pivot.agg_min', 'min') },
        { value: 'max', label: t('studio_apps_panels.pivot.agg_max', 'max') },
    ];
    const FORMATS = [
        { value: 'number', label: t('studio_apps_panels.pivot.format_number', 'number') },
        { value: 'percent', label: t('studio_apps_panels.pivot.format_percent', 'percent') },
        { value: 'currency', label: t('studio_apps_panels.pivot.format_currency', 'currency') },
        { value: 'date', label: t('studio_apps_panels.pivot.format_date', 'date') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <ConfigureDataButton node={node} definition={definition} patch={patch} componentType="pivot" disabled={disabled} />
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                hint={t('studio_apps_panels.pivot.source_hint', 'Pick a dataset above, or bind an array of objects to cross-tabulate.')}
                placeholder='[{"region":"EU","amount":10}]'
                disabled={disabled}
            />
            <DimList label={t('studio_apps_panels.pivot.row_groups', 'Row groups')} addLabel={t('studio_apps_panels.pivot.add_row_dimension', 'Add row dimension')} items={props.rows} onChange={(rows) => patch({ rows })} disabled={disabled} />
            <DimList label={t('studio_apps_panels.pivot.column_groups', 'Column groups')} addLabel={t('studio_apps_panels.pivot.add_column_dimension', 'Add column dimension')} items={props.columns} onChange={(columns) => patch({ columns })} disabled={disabled} />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.pivot.values', 'Values')}
                    items={props.values || []}
                    onChange={(values) => patch({ values })}
                    makeNew={() => ({ key: '', agg: 'sum', label: '', format: 'number' })}
                    addLabel={t('studio_apps_panels.pivot.add_value', 'Add value')}
                    itemLabel={(v) => v.label || v.key}
                    renderItem={(v, update) => (
                        <div className="flex flex-col gap-2">
                            <input type="text" className={inputCls} value={v.key || ''} onChange={(e) => update({ ...v, key: e.target.value })} placeholder={t('studio_apps_panels.pivot.field_key', 'Field key')} spellCheck={false} />
                            <input type="text" className={inputCls} value={v.label || ''} onChange={(e) => update({ ...v, label: e.target.value })} placeholder={t('studio_apps_panels.common.heading_optional', 'Heading (optional)')} />
                            <div className="grid grid-cols-2 gap-2">
                                <select className={inputCls} value={v.agg || 'sum'} onChange={(e) => update({ ...v, agg: e.target.value })} aria-label={t('studio_apps_panels.pivot.aggregation', 'Aggregation')}>
                                    {AGGS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                <select className={inputCls} value={v.format || 'number'} onChange={(e) => update({ ...v, format: e.target.value })} aria-label={t('studio_apps_panels.pivot.value_format', 'Value format')}>
                                    {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                                </select>
                            </div>
                        </div>
                    )}
                />
            </fieldset>
            <Toggle label={t('studio_apps_panels.pivot.show_totals', 'Show totals')} checked={props.showTotals !== false} onChange={(v) => patch({ showTotals: v })} disabled={disabled} size="sm" />
            <TextField label={t('studio_apps_panels.common.empty_text', 'Empty text')} value={props.emptyText} onChange={(v) => patch({ emptyText: v })} disabled={disabled} />
        </div>
    );
}

registerInspector('pivot', PivotInspector);
