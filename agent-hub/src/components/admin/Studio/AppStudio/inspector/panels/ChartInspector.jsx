import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, NumberField, TextField , usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { CHART_COLORS } from '../../runtime/chartPalette';
import { registerInspector } from '../registry';

const VALUE_FORMATS = [
    { value: 'number', label: '#' },
    { value: 'percent', label: '%' },
    { value: 'currency', label: '€' },
];

/**
 * A view built inside the Data block also prefills the drawing — source and
 * mapping travel in ONE patch so the chart lands as a single history entry.
 */
function builtViewPatch({ datasetId, chart }) {
    const p = { source: { kind: 'dataset', datasetId } };
    if (chart?.chartType) p.chartType = chart.chartType;
    if (chart?.xKey) p.xKey = chart.xKey;
    if (Array.isArray(chart?.series) && chart.series.length) {
        p.series = chart.series.map((s) => ({ key: s.key, label: s.label || s.key, ...(s.color ? { color: s.color } : {}) }));
    }
    return p;
}

function getChartTypesOptions(t) {
    return [
        { value: 'bar', label: t('studio_apps_panels.chart.type_bar', 'Bar') },
        { value: 'line', label: t('studio_apps_panels.chart.type_line', 'Line') },
        { value: 'area', label: t('studio_apps_panels.chart.type_area', 'Area') },
        { value: 'pie', label: t('studio_apps_panels.chart.type_pie', 'Pie') },
        { value: 'donut', label: t('studio_apps_panels.chart.type_donut', 'Donut') },
    ];
}

function getXTypesOptions(t) {
    return [
        { value: 'category', label: t('studio_apps_panels.chart.x_categories', 'Categories') },
        { value: 'time', label: t('studio_apps_panels.chart.x_dates', 'Dates') },
    ];
}

/** Content panel for chart. Props mirror componentSpecs.js (authoritative). */
export default function ChartInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const CHART_TYPES = getChartTypesOptions(t);
    const X_TYPES = getXTypesOptions(t);
    const patch = usePatch(node, definition, onCommit);
    const isPie = props.chartType === 'pie' || props.chartType === 'donut';

    return (
        <div className="flex flex-col gap-4">
            <FormField label={t('studio_apps_panels.chart.chart_type', 'Chart type')}>
                <SegmentedControl value={props.chartType ?? 'bar'} onChange={(v) => patch({ chartType: v })} options={CHART_TYPES} size="sm" fullWidth disabled={disabled} ariaLabel={t('studio_apps_panels.chart.chart_type', 'Chart type')} />
            </FormField>
            <BindingField
                label={t('studio_apps_panels.common.data', 'Data')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                onBuild={(built) => patch(builtViewPatch(built))}
                definition={definition}
                componentType="chart"
                hint={t('studio_apps_panels.chart.data_hint', 'Where the numbers in this chart come from.')}
                placeholder='[{"label":"Jan","value":10}]'
                disabled={disabled}
            />
            <TextField label={t('studio_apps_panels.common.title', 'Title')} value={props.title} onChange={(v) => patch({ title: v || null })} placeholder={t('studio_apps_panels.common.optional', 'Optional')} disabled={disabled} />
            <FieldKeyField
                label={isPie ? t('studio_apps_panels.chart.name_field', 'Name field') : t('studio_apps_panels.chart.x_axis_field', 'X-axis field')}
                value={props.xKey}
                onChange={(v) => patch({ xKey: v })}
                source={props.source}
                placeholder={t('studio_apps_panels.chart.label_placeholder', 'label')}
                ariaLabel={isPie ? t('studio_apps_panels.chart.name_field', 'Name field') : t('studio_apps_panels.chart.x_axis_field', 'X-axis field')}
                disabled={disabled}
            />
            {!isPie ? (
                <FormField label={t('studio_apps_panels.chart.x_axis_scale', 'X-axis scale')} hint={t('studio_apps_panels.chart.x_axis_scale_hint', 'Dates space points by how far apart they actually are, so a gap in the data reads as a gap.')}>
                    <SegmentedControl value={props.xType ?? 'category'} onChange={(v) => patch({ xType: v })} options={X_TYPES} size="sm" fullWidth disabled={disabled} ariaLabel={t('studio_apps_panels.chart.x_axis_scale', 'X-axis scale')} />
                </FormField>
            ) : null}
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.chart.series', 'Series')}
                    items={props.series || []}
                    onChange={(series) => patch({ series })}
                    makeNew={() => ({ key: '', label: '' })}
                    addLabel={t('studio_apps_panels.chart.add_series', 'Add series')}
                    itemLabel={(s) => s.label || s.key}
                    renderItem={(s, update) => (
                        <div className="flex flex-col gap-2">
                            <FieldKeyField value={s.key} onChange={(v) => update({ ...s, key: v })} source={props.source} placeholder={t('studio_apps_panels.chart.value_key_placeholder', 'Value key (e.g. amount)')} ariaLabel={t('studio_apps_panels.chart.value_field', 'Value field')} />
                            <input type="text" className={inputCls} value={s.label || ''} onChange={(e) => update({ ...s, label: e.target.value })} placeholder={t('studio_apps_panels.chart.legend_label_placeholder', 'Legend label (optional)')} />
                            <div className="flex items-center gap-1.5 flex-wrap">
                                {CHART_COLORS.map((c) => (
                                    <button
                                        key={c}
                                        type="button"
                                        aria-label={t('studio_apps_panels.chart.colour_aria', 'Colour {color}', { color: c })}
                                        onClick={() => update({ ...s, color: c })}
                                        className="w-5 h-5 rounded-full border"
                                        style={{ background: c, borderColor: s.color === c ? 'var(--text-primary)' : 'transparent', outline: s.color === c ? '2px solid var(--text-primary)' : 'none' }}
                                    />
                                ))}
                                <button type="button" onClick={() => update({ ...s, color: undefined })} className="text-[11px] text-[var(--text-muted)] ml-1">{t('studio_apps_panels.common.auto', 'Auto')}</button>
                            </div>
                        </div>
                    )}
                />
            </fieldset>
            {!isPie ? (
                <Toggle label={t('studio_apps_panels.chart.stacked', 'Stacked')} checked={!!props.stacked} onChange={(v) => patch({ stacked: v })} disabled={disabled} size="sm" />
            ) : null}
            <Toggle label={t('studio_apps_panels.chart.show_legend', 'Show legend')} checked={props.showLegend !== false} onChange={(v) => patch({ showLegend: v })} disabled={disabled} size="sm" />
            {!isPie ? (
                <Toggle label={t('studio_apps_panels.chart.show_grid', 'Show grid')} checked={props.showGrid !== false} onChange={(v) => patch({ showGrid: v })} disabled={disabled} size="sm" />
            ) : null}
            <FormField label={t('studio_apps_panels.chart.value_format', 'Value format')}>
                <SegmentedControl value={props.valueFormat ?? 'number'} onChange={(v) => patch({ valueFormat: v })} options={VALUE_FORMATS} size="sm" fullWidth disabled={disabled} ariaLabel={t('studio_apps_panels.chart.value_format', 'Value format')} />
            </FormField>
            <TextField
                label={t('studio_apps_panels.chart.unit', 'Unit')}
                value={props.unitLabel}
                onChange={(v) => patch({ unitLabel: v || null })}
                placeholder={t('studio_apps_panels.chart.unit_placeholder', 'kg, mmHg, mmol/L…')}
                hint={t('studio_apps_panels.chart.unit_hint', 'Suffixed to the axis and the tooltip.')}
                disabled={disabled}
            />
            {!isPie ? (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <NumberField label={t('studio_apps_panels.chart.y_min', 'Y min')} value={props.yMin} onChange={(v) => patch({ yMin: v })} placeholder={t('studio_apps_panels.common.auto', 'Auto')} disabled={disabled} />
                        <NumberField label={t('studio_apps_panels.chart.y_max', 'Y max')} value={props.yMax} onChange={(v) => patch({ yMax: v })} placeholder={t('studio_apps_panels.common.auto', 'Auto')} disabled={disabled} />
                    </div>
                    <fieldset disabled={disabled} className="min-w-0">
                        <RepeatableList
                            label={t('studio_apps_panels.chart.reference_bands', 'Reference bands')}
                            items={props.referenceBands || []}
                            onChange={(referenceBands) => patch({ referenceBands })}
                            makeNew={() => ({ from: null, to: null, label: '' })}
                            addLabel={t('studio_apps_panels.chart.add_band', 'Add band')}
                            itemLabel={(b) => b.label || (b.from != null && b.to != null ? `${b.from}–${b.to}` : t('studio_apps_panels.chart.band', 'Band'))}
                            renderItem={(b, update) => (
                                <div className="flex flex-col gap-2">
                                    <div className="grid grid-cols-2 gap-2">
                                        <input type="number" className={inputCls} value={b.from ?? ''} onChange={(e) => update({ ...b, from: e.target.value === '' ? null : Number(e.target.value) })} placeholder={t('studio_apps_panels.chart.band_from_placeholder', 'From')} aria-label={t('studio_apps_panels.chart.band_from', 'Band from')} />
                                        <input type="number" className={inputCls} value={b.to ?? ''} onChange={(e) => update({ ...b, to: e.target.value === '' ? null : Number(e.target.value) })} placeholder={t('studio_apps_panels.chart.band_to_placeholder', 'To')} aria-label={t('studio_apps_panels.chart.band_to', 'Band to')} />
                                    </div>
                                    <input type="text" className={inputCls} value={b.label || ''} onChange={(e) => update({ ...b, label: e.target.value })} placeholder={t('studio_apps_panels.chart.band_label_placeholder', 'Label (e.g. Healthy range)')} aria-label={t('studio_apps_panels.chart.band_label', 'Band label')} />
                                    <ColourRow value={b.color} onPick={(c) => update({ ...b, color: c })} />
                                </div>
                            )}
                        />
                    </fieldset>
                    <fieldset disabled={disabled} className="min-w-0">
                        <RepeatableList
                            label={t('studio_apps_panels.chart.reference_lines', 'Reference lines')}
                            items={props.referenceLines || []}
                            onChange={(referenceLines) => patch({ referenceLines })}
                            makeNew={() => ({ value: null, label: '' })}
                            addLabel={t('studio_apps_panels.chart.add_line', 'Add line')}
                            itemLabel={(r) => r.label || (r.value != null ? String(r.value) : t('studio_apps_panels.chart.line', 'Line'))}
                            renderItem={(r, update) => (
                                <div className="flex flex-col gap-2">
                                    <input type="number" className={inputCls} value={r.value ?? ''} onChange={(e) => update({ ...r, value: e.target.value === '' ? null : Number(e.target.value) })} placeholder={t('studio_apps_panels.chart.line_value_placeholder', 'Value (e.g. 75)')} aria-label={t('studio_apps_panels.chart.line_value', 'Line value')} />
                                    <input type="text" className={inputCls} value={r.label || ''} onChange={(e) => update({ ...r, label: e.target.value })} placeholder={t('studio_apps_panels.chart.line_label_placeholder', 'Label (e.g. Target)')} aria-label={t('studio_apps_panels.chart.line_label', 'Line label')} />
                                    <ColourRow value={r.color} onPick={(c) => update({ ...r, color: c })} />
                                </div>
                            )}
                        />
                    </fieldset>
                </>
            ) : null}
        </div>
    );
}

/** The same swatch row the series list uses, shared by both reference lists. */
function ColourRow({ value, onPick }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {CHART_COLORS.map((c) => (
                <button
                    key={c}
                    type="button"
                    aria-label={t('studio_apps_panels.chart.colour_aria', 'Colour {color}', { color: c })}
                    onClick={() => onPick(c)}
                    className="w-5 h-5 rounded-full border"
                    style={{ background: c, borderColor: value === c ? 'var(--text-primary)' : 'transparent', outline: value === c ? '2px solid var(--text-primary)' : 'none' }}
                />
            ))}
            <button type="button" onClick={() => onPick(undefined)} className="text-[11px] text-[var(--text-muted)] ml-1">{t('studio_apps_panels.common.auto', 'Auto')}</button>
        </div>
    );
}

registerInspector('chart', ChartInspector);
