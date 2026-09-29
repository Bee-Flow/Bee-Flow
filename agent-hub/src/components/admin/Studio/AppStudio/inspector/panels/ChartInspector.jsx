import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, NumberField, TextField , usePatch } from './kit';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { CHART_COLORS } from '../../runtime/chartPalette';
import { registerInspector } from '../registry';

const CHART_TYPES = [
    { value: 'bar', label: 'Bar' },
    { value: 'line', label: 'Line' },
    { value: 'area', label: 'Area' },
    { value: 'pie', label: 'Pie' },
    { value: 'donut', label: 'Donut' },
];
const VALUE_FORMATS = [
    { value: 'number', label: '#' },
    { value: 'percent', label: '%' },
    { value: 'currency', label: '€' },
];
const X_TYPES = [
    { value: 'category', label: 'Categories' },
    { value: 'time', label: 'Dates' },
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

/** Content panel for chart. Props mirror componentSpecs.js (authoritative). */
export default function ChartInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);
    const isPie = props.chartType === 'pie' || props.chartType === 'donut';

    return (
        <div className="flex flex-col gap-4">
            <FormField label="Chart type">
                <SegmentedControl value={props.chartType ?? 'bar'} onChange={(v) => patch({ chartType: v })} options={CHART_TYPES} size="sm" fullWidth disabled={disabled} ariaLabel="Chart type" />
            </FormField>
            <BindingField
                label="Data"
                value={props.source}
                onChange={(v) => patch({ source: v })}
                onBuild={(built) => patch(builtViewPatch(built))}
                definition={definition}
                componentType="chart"
                hint="Where the numbers in this chart come from."
                placeholder='[{"label":"Jan","value":10}]'
                disabled={disabled}
            />
            <TextField label="Title" value={props.title} onChange={(v) => patch({ title: v || null })} placeholder="Optional" disabled={disabled} />
            <FieldKeyField
                label={isPie ? 'Name field' : 'X-axis field'}
                value={props.xKey}
                onChange={(v) => patch({ xKey: v })}
                source={props.source}
                placeholder="label"
                ariaLabel={isPie ? 'Name field' : 'X-axis field'}
                disabled={disabled}
            />
            {!isPie ? (
                <FormField label="X-axis scale" hint="Dates space points by how far apart they actually are, so a gap in the data reads as a gap.">
                    <SegmentedControl value={props.xType ?? 'category'} onChange={(v) => patch({ xType: v })} options={X_TYPES} size="sm" fullWidth disabled={disabled} ariaLabel="X-axis scale" />
                </FormField>
            ) : null}
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label="Series"
                    items={props.series || []}
                    onChange={(series) => patch({ series })}
                    makeNew={() => ({ key: '', label: '' })}
                    addLabel="Add series"
                    itemLabel={(s) => s.label || s.key}
                    renderItem={(s, update) => (
                        <div className="flex flex-col gap-2">
                            <FieldKeyField value={s.key} onChange={(v) => update({ ...s, key: v })} source={props.source} placeholder="Value key (e.g. amount)" ariaLabel="Value field" />
                            <input type="text" className={inputCls} value={s.label || ''} onChange={(e) => update({ ...s, label: e.target.value })} placeholder="Legend label (optional)" />
                            <div className="flex items-center gap-1.5 flex-wrap">
                                {CHART_COLORS.map((c) => (
                                    <button
                                        key={c}
                                        type="button"
                                        aria-label={`Colour ${c}`}
                                        onClick={() => update({ ...s, color: c })}
                                        className="w-5 h-5 rounded-full border"
                                        style={{ background: c, borderColor: s.color === c ? 'var(--text-primary)' : 'transparent', outline: s.color === c ? '2px solid var(--text-primary)' : 'none' }}
                                    />
                                ))}
                                <button type="button" onClick={() => update({ ...s, color: undefined })} className="text-[11px] text-[var(--text-muted)] ml-1">Auto</button>
                            </div>
                        </div>
                    )}
                />
            </fieldset>
            {!isPie ? (
                <Toggle label="Stacked" checked={!!props.stacked} onChange={(v) => patch({ stacked: v })} disabled={disabled} size="sm" />
            ) : null}
            <Toggle label="Show legend" checked={props.showLegend !== false} onChange={(v) => patch({ showLegend: v })} disabled={disabled} size="sm" />
            {!isPie ? (
                <Toggle label="Show grid" checked={props.showGrid !== false} onChange={(v) => patch({ showGrid: v })} disabled={disabled} size="sm" />
            ) : null}
            <FormField label="Value format">
                <SegmentedControl value={props.valueFormat ?? 'number'} onChange={(v) => patch({ valueFormat: v })} options={VALUE_FORMATS} size="sm" fullWidth disabled={disabled} ariaLabel="Value format" />
            </FormField>
            <TextField
                label="Unit"
                value={props.unitLabel}
                onChange={(v) => patch({ unitLabel: v || null })}
                placeholder="kg, mmHg, mmol/L…"
                hint="Suffixed to the axis and the tooltip."
                disabled={disabled}
            />
            {!isPie ? (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <NumberField label="Y min" value={props.yMin} onChange={(v) => patch({ yMin: v })} placeholder="Auto" disabled={disabled} />
                        <NumberField label="Y max" value={props.yMax} onChange={(v) => patch({ yMax: v })} placeholder="Auto" disabled={disabled} />
                    </div>
                    <fieldset disabled={disabled} className="min-w-0">
                        <RepeatableList
                            label="Reference bands"
                            items={props.referenceBands || []}
                            onChange={(referenceBands) => patch({ referenceBands })}
                            makeNew={() => ({ from: null, to: null, label: '' })}
                            addLabel="Add band"
                            itemLabel={(b) => b.label || (b.from != null && b.to != null ? `${b.from}–${b.to}` : 'Band')}
                            renderItem={(b, update) => (
                                <div className="flex flex-col gap-2">
                                    <div className="grid grid-cols-2 gap-2">
                                        <input type="number" className={inputCls} value={b.from ?? ''} onChange={(e) => update({ ...b, from: e.target.value === '' ? null : Number(e.target.value) })} placeholder="From" aria-label="Band from" />
                                        <input type="number" className={inputCls} value={b.to ?? ''} onChange={(e) => update({ ...b, to: e.target.value === '' ? null : Number(e.target.value) })} placeholder="To" aria-label="Band to" />
                                    </div>
                                    <input type="text" className={inputCls} value={b.label || ''} onChange={(e) => update({ ...b, label: e.target.value })} placeholder="Label (e.g. Healthy range)" aria-label="Band label" />
                                    <ColourRow value={b.color} onPick={(c) => update({ ...b, color: c })} />
                                </div>
                            )}
                        />
                    </fieldset>
                    <fieldset disabled={disabled} className="min-w-0">
                        <RepeatableList
                            label="Reference lines"
                            items={props.referenceLines || []}
                            onChange={(referenceLines) => patch({ referenceLines })}
                            makeNew={() => ({ value: null, label: '' })}
                            addLabel="Add line"
                            itemLabel={(r) => r.label || (r.value != null ? String(r.value) : 'Line')}
                            renderItem={(r, update) => (
                                <div className="flex flex-col gap-2">
                                    <input type="number" className={inputCls} value={r.value ?? ''} onChange={(e) => update({ ...r, value: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Value (e.g. 75)" aria-label="Line value" />
                                    <input type="text" className={inputCls} value={r.label || ''} onChange={(e) => update({ ...r, label: e.target.value })} placeholder="Label (e.g. Target)" aria-label="Line label" />
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
    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {CHART_COLORS.map((c) => (
                <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    onClick={() => onPick(c)}
                    className="w-5 h-5 rounded-full border"
                    style={{ background: c, borderColor: value === c ? 'var(--text-primary)' : 'transparent', outline: value === c ? '2px solid var(--text-primary)' : 'none' }}
                />
            ))}
            <button type="button" onClick={() => onPick(undefined)} className="text-[11px] text-[var(--text-muted)] ml-1">Auto</button>
        </div>
    );
}

registerInspector('chart', ChartInspector);
