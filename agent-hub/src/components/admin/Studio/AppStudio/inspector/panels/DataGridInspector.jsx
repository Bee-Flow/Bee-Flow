import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, TextField, SelectField, usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import Slider from '../../../../../shared/Slider';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { actionOptions } from '../actionLabels';
import { registerInspector } from '../registry';

function getAlignsOptions(t) {
    return [
        { value: 'auto', label: t('studio_apps_panels.common.auto', 'Auto') },
        { value: 'left', label: t('studio_apps_panels.data_grid.align_left', 'Left') },
        { value: 'right', label: t('studio_apps_panels.data_grid.align_right', 'Right') },
        { value: 'center', label: t('studio_apps_panels.data_grid.align_center', 'Center') },
    ];
}

function getSelectableOptions(t) {
    return [
        { value: 'none', label: t('studio_apps_panels.data_grid.select_none', 'None') },
        { value: 'single', label: t('studio_apps_panels.data_grid.select_single', 'Single') },
        { value: 'multi', label: t('studio_apps_panels.data_grid.select_multi', 'Multi') },
    ];
}

function getDensityOptions(t) {
    return [
        { value: 'compact', label: t('studio_apps_panels.data_grid.density_compact', 'Compact') },
        { value: 'comfortable', label: t('studio_apps_panels.data_grid.density_cozy', 'Cozy') },
        { value: 'spacious', label: t('studio_apps_panels.data_grid.density_roomy', 'Roomy') },
    ];
}

function getLooksOptions(t) {
    return [
        { value: 'default', label: t('studio_apps_panels.common.look_default', 'Default') },
        { value: 'striped', label: t('studio_apps_panels.data_grid.look_striped', 'Striped') },
        { value: 'minimal', label: t('studio_apps_panels.data_grid.look_minimal', 'Minimal') },
        { value: 'cards', label: t('studio_apps_panels.data_grid.look_cards', 'Cards') },
    ];
}

function getFormatLabels(t) {
    return {
        text: t('studio_apps_panels.data_grid.format_text', 'Text'), number: t('studio_apps_panels.data_grid.format_number', 'Number'), date: t('studio_apps_panels.data_grid.format_date', 'Date'), badge: t('studio_apps_panels.data_grid.format_badge', 'Badge'), link: t('studio_apps_panels.data_grid.format_link', 'Link'), boolean: t('studio_apps_panels.data_grid.format_boolean', 'Boolean'), relation: t('studio_apps_panels.data_grid.format_relation', 'Relation'),
        currency: t('studio_apps_panels.data_grid.format_currency', 'Currency'), percent: t('studio_apps_panels.data_grid.format_percent', 'Percent'), datetime: t('studio_apps_panels.data_grid.format_datetime', 'Datetime'), relative: t('studio_apps_panels.data_grid.format_relative', 'Relative'), check: t('studio_apps_panels.data_grid.format_check', 'Check'), tags: t('studio_apps_panels.data_grid.format_tags', 'Tags'),
        progress: t('studio_apps_panels.data_grid.format_progress', 'Progress'), user: t('studio_apps_panels.data_grid.format_user', 'User'), breakdown: t('studio_apps_panels.data_grid.format_breakdown', 'Breakdown'), cad: t('studio_apps_panels.data_grid.format_cad', 'Cad'), document: t('studio_apps_panels.data_grid.format_document', 'Document'),
    };
}

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
// Mirror of the data_grid `look` enum (componentSpecs.js, authoritative —
// first value is the default and renders exactly what the grid always
// rendered; a set `look` wins over the legacy zebra flag).

/** Content panel for data_grid. Props mirror componentSpecs.js (authoritative). */
export default function DataGridInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const ALIGNS = getAlignsOptions(t);
    const SELECTABLE = getSelectableOptions(t);
    const DENSITY = getDensityOptions(t);
    const LOOKS = getLooksOptions(t);
    const FORMAT_LABELS = getFormatLabels(t);
    // A raw 'act_a1b2c3' told the author nothing — naming each action the way
    // the Actions accordion names it is the difference between choosing and guessing.
    const actions = actionOptions(definition);
    const actionIds = actions.map((a) => a.id);
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.data', 'Data')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                componentType="data_grid"
                hint={t('studio_apps_panels.data_grid.data_hint', 'Where the rows in this table come from.')}
                placeholder='[{"title":"…"}]'
                disabled={disabled}
            />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.data_grid.columns', 'Columns')}
                    items={props.columns || []}
                    onChange={(columns) => patch({ columns })}
                    makeNew={() => ({ key: '', label: '', format: 'text' })}
                    addLabel={t('studio_apps_panels.data_grid.add_column', 'Add column')}
                    collapsible
                    itemLabel={(c) => c.label || c.key}
                    renderItem={(col, update) => (
                        <div className="flex flex-col gap-2">
                            <FieldKeyField value={col.key} onChange={(v) => update({ ...col, key: v })} source={props.source} placeholder={t('studio_apps_panels.common.key_placeholder', 'Key (e.g. status)')} ariaLabel={t('studio_apps_panels.data_grid.column_field', 'Column field')} />
                            <input type="text" className={inputCls} value={col.label || ''} onChange={(e) => update({ ...col, label: e.target.value })} placeholder={t('studio_apps_panels.common.heading_optional', 'Heading (optional)')} />
                            <select className={inputCls} value={col.format || 'text'} onChange={(e) => update({ ...col, format: e.target.value })} aria-label={t('studio_apps_panels.data_grid.column_format', 'Column format')}>
                                {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f] ?? f}</option>)}
                            </select>
                            <div className="flex gap-2">
                                <select className={inputCls} value={col.align || 'auto'} onChange={(e) => update({ ...col, align: e.target.value })} aria-label={t('studio_apps_panels.data_grid.column_alignment', 'Column alignment')}>
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
                                    placeholder={t('studio_apps_panels.data_grid.width_placeholder', 'Width px')}
                                    aria-label={t('studio_apps_panels.data_grid.column_width_aria', 'Column width in pixels')}
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
                                placeholder={t('studio_apps_panels.data_grid.tone_placeholder', 'Colour from column (optional)')}
                                aria-label={t('studio_apps_panels.data_grid.tone_source_aria', 'Column tone source')}
                            />
                            <div className="flex flex-wrap gap-3">
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                                    <input type="checkbox" checked={col.sortable !== false} onChange={(e) => update({ ...col, sortable: e.target.checked })} className="accent-[var(--accent-primary)]" /> {t('studio_apps_panels.data_grid.sortable', 'Sortable')}
                                </label>
                                <label
                                    className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"
                                    title={t('studio_apps_panels.data_grid.filterable_hint', 'A filter under the heading, shaped by the format: a min–max range for numbers, from–to for dates, yes/no for checks, a pick list for badges, contains for text.')}
                                >
                                    <input type="checkbox" checked={!!col.filterable} onChange={(e) => update({ ...col, filterable: e.target.checked })} className="accent-[var(--accent-primary)]" /> {t('studio_apps_panels.data_grid.filterable', 'Filterable')}
                                </label>
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                                    <input type="checkbox" checked={!!col.editable} onChange={(e) => update({ ...col, editable: e.target.checked })} className="accent-[var(--accent-primary)]" /> {t('studio_apps_panels.data_grid.editable', 'Editable')}
                                </label>
                            </div>
                        </div>
                    )}
                />
            </fieldset>
            <FormField label={t('studio_apps_panels.data_grid.selection', 'Selection')}>
                <SegmentedControl value={props.selectable ?? 'none'} onChange={(v) => patch({ selectable: v })} options={SELECTABLE} size="sm" fullWidth disabled={disabled} ariaLabel={t('studio_apps_panels.data_grid.row_selection', 'Row selection')} />
            </FormField>
            <FormField label={t('studio_apps_panels.data_grid.density', 'Density')}>
                <SegmentedControl value={props.density ?? 'comfortable'} onChange={(v) => patch({ density: v })} options={DENSITY} size="sm" fullWidth disabled={disabled} ariaLabel={t('studio_apps_panels.data_grid.row_density', 'Row density')} />
            </FormField>
            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'default'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
            <Slider
                label={t('studio_apps_panels.data_grid.page_size', 'Page size')}
                value={Number.isFinite(props.pageSize) ? props.pageSize : 25}
                onChange={(v) => patch({ pageSize: Math.max(5, Math.min(100, Math.round(v))) })}
                min={5}
                max={100}
                step={5}
                suffix={t('studio_apps_panels.data_grid.rows_suffix', ' rows')}
                disabled={disabled}
            />
            <Toggle label={t('studio_apps_panels.data_grid.searchable', 'Searchable')} checked={!!props.searchable} onChange={(v) => patch({ searchable: v })} disabled={disabled} size="sm" />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.data_grid.row_actions', 'Row actions')}
                    items={props.rowActions || []}
                    onChange={(rowActions) => patch({ rowActions })}
                    makeNew={() => ({ label: '', actionId: actionIds[0] || '' })}
                    addLabel={t('studio_apps_panels.data_grid.add_row_action', 'Add row action')}
                    itemLabel={(a) => a.label}
                    renderItem={(a, update) => (
                        <div className="flex flex-col gap-2">
                            <input type="text" className={inputCls} value={a.label || ''} onChange={(e) => update({ ...a, label: e.target.value })} placeholder={t('studio_apps_panels.common.button_label', 'Button label')} />
                            <select className={inputCls} value={a.actionId || ''} onChange={(e) => update({ ...a, actionId: e.target.value })} aria-label={t('studio_apps_panels.data_grid.row_action', 'Row action')}>
                                <option value="">{t('studio_apps_panels.common.pick_action', 'Pick an action…')}</option>
                                {actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                        </div>
                    )}
                />
            </fieldset>
            <TextField label={t('studio_apps_panels.data_grid.empty_text', 'Empty text')} value={props.emptyText} onChange={(v) => patch({ emptyText: v })} disabled={disabled} />
        </div>
    );
}

registerInspector('data_grid', DataGridInspector);
