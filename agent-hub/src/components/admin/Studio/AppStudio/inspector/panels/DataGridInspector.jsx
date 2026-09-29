import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, TextField, SelectField, usePatch } from './kit';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import Slider from '../../../../../shared/Slider';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { actionOptions } from '../actionLabels';
import { registerInspector } from '../registry';

// Mirror of the data_grid column `format` enum (componentSpecs.js, authoritative).
// Pinned in lockstep by lookSelects.test.jsx — the spec list and this one are
// compared value for value, in order, so a format added on the server cannot
// stay unreachable from the inspector.
const FORMATS = [
    'text', 'number', 'date', 'badge', 'link', 'boolean', 'relation',
    'currency', 'percent', 'datetime', 'relative', 'check', 'tags', 'progress', 'user',
    'breakdown',
    'cad',
    'document',
];
// Mirror of the column `align` enum. 'auto' is the default: numbers right,
// everything else left.
const ALIGNS = [
    { value: 'auto', label: 'Auto' },
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
    { value: 'center', label: 'Center' },
];
const SELECTABLE = [
    { value: 'none', label: 'None' },
    { value: 'single', label: 'Single' },
    { value: 'multi', label: 'Multi' },
];
const DENSITY = [
    { value: 'compact', label: 'Compact' },
    { value: 'comfortable', label: 'Cozy' },
    { value: 'spacious', label: 'Roomy' },
];
// Mirror of the data_grid `look` enum (componentSpecs.js, authoritative —
// first value is the default and renders exactly what the grid always
// rendered; a set `look` wins over the legacy zebra flag).
const LOOKS = [
    { value: 'default', label: 'Default' },
    { value: 'striped', label: 'Striped' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'cards', label: 'Cards' },
];

/** Content panel for data_grid. Props mirror componentSpecs.js (authoritative). */
export default function DataGridInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    // A raw 'act_a1b2c3' told the author nothing — naming each action the way
    // the Actions accordion names it is the difference between choosing and guessing.
    const actions = actionOptions(definition);
    const actionIds = actions.map((a) => a.id);
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label="Data"
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                componentType="data_grid"
                hint="Where the rows in this table come from."
                placeholder='[{"title":"…"}]'
                disabled={disabled}
            />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label="Columns"
                    items={props.columns || []}
                    onChange={(columns) => patch({ columns })}
                    makeNew={() => ({ key: '', label: '', format: 'text' })}
                    addLabel="Add column"
                    collapsible
                    itemLabel={(c) => c.label || c.key}
                    renderItem={(col, update) => (
                        <div className="flex flex-col gap-2">
                            <FieldKeyField value={col.key} onChange={(v) => update({ ...col, key: v })} source={props.source} placeholder="Key (e.g. status)" ariaLabel="Column field" />
                            <input type="text" className={inputCls} value={col.label || ''} onChange={(e) => update({ ...col, label: e.target.value })} placeholder="Heading (optional)" />
                            <select className={inputCls} value={col.format || 'text'} onChange={(e) => update({ ...col, format: e.target.value })} aria-label="Column format">
                                {FORMATS.map((f) => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
                            </select>
                            <div className="flex gap-2">
                                <select className={inputCls} value={col.align || 'auto'} onChange={(e) => update({ ...col, align: e.target.value })} aria-label="Column alignment">
                                    {ALIGNS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                {/* `width` has been in the spec since the grid
                                    shipped and has never had a control — so the
                                    only way to size a column was to hand-edit
                                    the definition. Blank means "size to fit". */}
                                <input
                                    type="number"
                                    className={inputCls}
                                    value={Number.isFinite(col.width) ? col.width : ''}
                                    min={40}
                                    max={800}
                                    onChange={(e) => {
                                        const n = Math.round(Number(e.target.value));
                                        const next = { ...col };
                                        if (Number.isFinite(n) && e.target.value !== '') next.width = Math.max(40, Math.min(800, n));
                                        else delete next.width;
                                        update(next);
                                    }}
                                    placeholder="Width px"
                                    aria-label="Column width in pixels"
                                />
                            </div>
                            {/* A sibling column whose value is the pill's colour
                                — the reason a status column can stop being grey. */}
                            <input
                                type="text"
                                className={inputCls}
                                value={col.toneFrom || ''}
                                onChange={(e) => {
                                    const next = { ...col };
                                    if (e.target.value) next.toneFrom = e.target.value; else delete next.toneFrom;
                                    update(next);
                                }}
                                placeholder="Colour from column (optional)"
                                aria-label="Column tone source"
                            />
                            <div className="flex flex-wrap gap-3">
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                                    <input type="checkbox" checked={col.sortable !== false} onChange={(e) => update({ ...col, sortable: e.target.checked })} className="accent-[var(--accent-primary)]" /> Sortable
                                </label>
                                <label
                                    className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                                    title="A filter under the heading, shaped by the format: a min–max range for numbers, from–to for dates, yes/no for checks, a pick list for badges, contains for text."
                                >
                                    <input type="checkbox" checked={!!col.filterable} onChange={(e) => update({ ...col, filterable: e.target.checked })} className="accent-[var(--accent-primary)]" /> Filterable
                                </label>
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                                    <input type="checkbox" checked={!!col.editable} onChange={(e) => update({ ...col, editable: e.target.checked })} className="accent-[var(--accent-primary)]" /> Editable
                                </label>
                            </div>
                        </div>
                    )}
                />
            </fieldset>
            <FormField label="Selection">
                <SegmentedControl value={props.selectable ?? 'none'} onChange={(v) => patch({ selectable: v })} options={SELECTABLE} size="sm" fullWidth disabled={disabled} ariaLabel="Row selection" />
            </FormField>
            <FormField label="Density">
                <SegmentedControl value={props.density ?? 'comfortable'} onChange={(v) => patch({ density: v })} options={DENSITY} size="sm" fullWidth disabled={disabled} ariaLabel="Row density" />
            </FormField>
            <SelectField
                label="Look"
                value={props.look ?? 'default'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
            <Slider
                label="Page size"
                value={Number.isFinite(props.pageSize) ? props.pageSize : 25}
                onChange={(v) => patch({ pageSize: Math.max(5, Math.min(100, Math.round(v))) })}
                min={5}
                max={100}
                step={5}
                suffix=" rows"
                disabled={disabled}
            />
            <Toggle label="Searchable" checked={!!props.searchable} onChange={(v) => patch({ searchable: v })} disabled={disabled} size="sm" />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label="Row actions"
                    items={props.rowActions || []}
                    onChange={(rowActions) => patch({ rowActions })}
                    makeNew={() => ({ label: '', actionId: actionIds[0] || '' })}
                    addLabel="Add row action"
                    itemLabel={(a) => a.label}
                    renderItem={(a, update) => (
                        <div className="flex flex-col gap-2">
                            <input type="text" className={inputCls} value={a.label || ''} onChange={(e) => update({ ...a, label: e.target.value })} placeholder="Button label" />
                            <select className={inputCls} value={a.actionId || ''} onChange={(e) => update({ ...a, actionId: e.target.value })} aria-label="Row action">
                                <option value="">Pick an action…</option>
                                {actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                        </div>
                    )}
                />
            </fieldset>
            <TextField label="Empty text" value={props.emptyText} onChange={(v) => patch({ emptyText: v })} disabled={disabled} />
        </div>
    );
}

registerInspector('data_grid', DataGridInspector);
