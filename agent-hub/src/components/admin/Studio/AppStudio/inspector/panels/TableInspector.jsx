import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import Slider from '../../../../../shared/Slider';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { registerInspector } from '../registry';
import BindingField from './BindingField';
import { FieldKeyField, TextField, SelectField, usePatch } from './kit';

function getLooksOptions(t) {
    return [
        { value: 'default', label: t('studio_apps_panels.common.look_default', 'Default') },
        { value: 'striped', label: t('studio_apps_panels.data_grid.look_striped', 'Striped') },
        { value: 'minimal', label: t('studio_apps_panels.data_grid.look_minimal', 'Minimal') },
    ];
}

function getFormatLabels(t) {
    return {
        text: t('studio_apps_panels.data_grid.format_text', 'Text'),
        number: t('studio_apps_panels.data_grid.format_number', 'Number'),
        date: t('studio_apps_panels.data_grid.format_date', 'Date'),
        badge: t('studio_apps_panels.data_grid.format_badge', 'Badge'),
        link: t('studio_apps_panels.data_grid.format_link', 'Link'),
        boolean: t('studio_apps_panels.data_grid.format_boolean', 'Boolean'),
        relation: t('studio_apps_panels.data_grid.format_relation', 'Relation'),
        currency: t('studio_apps_panels.data_grid.format_currency', 'Currency'),
        percent: t('studio_apps_panels.data_grid.format_percent', 'Percent'),
        datetime: t('studio_apps_panels.data_grid.format_datetime', 'Datetime'),
        relative: t('studio_apps_panels.data_grid.format_relative', 'Relative'),
        check: t('studio_apps_panels.data_grid.format_check', 'Check'),
        tags: t('studio_apps_panels.data_grid.format_tags', 'Tags'),
        progress: t('studio_apps_panels.data_grid.format_progress', 'Progress'),
        user: t('studio_apps_panels.data_grid.format_user', 'User'),
        breakdown: t('studio_apps_panels.data_grid.format_breakdown', 'Breakdown'),
        cad: t('studio_apps_panels.data_grid.format_cad', 'Cad'),
        document: t('studio_apps_panels.data_grid.format_document', 'Document'),
    };
}

// Mirror of the table column `format` enum (componentSpecs.js, authoritative).
// `table` and `data_grid` render through the same cellValue module, so their
// format lists are the same list — lookSelects.test.jsx pins both against the
// server spec.
const FORMATS = [
    'text', 'number', 'date', 'badge', 'link', 'boolean', 'relation',
    'currency', 'percent', 'datetime', 'relative', 'check', 'tags', 'progress', 'user',
    'breakdown',
    'cad',
    'document',
];

// Mirror of the table `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what table always rendered).
export default function TableInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                hint={t('studio_apps_panels.table.source_hint', 'An array of objects — usually an automation result.')}
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
                    itemLabel={(c) => c.label || c.key}
                    renderItem={(col, update) => (
                        <div className="flex flex-col gap-2">
                            <FieldKeyField
                                value={col.key}
                                onChange={(v) => update({ ...col, key: v })}
                                source={props.source}
                                placeholder={t('studio_apps_panels.common.key_placeholder', 'Key (e.g. status)')}
                                ariaLabel={t('studio_apps_panels.data_grid.column_field', 'Column field')}
                            />
                            <input
                                type="text"
                                className={inputCls}
                                value={col.label || ''}
                                onChange={(e) => update({ ...col, label: e.target.value })}
                                placeholder={t('studio_apps_panels.common.heading_optional', 'Heading (optional)')}
                            />
                            <select
                                className={inputCls}
                                value={col.format || 'text'}
                                onChange={(e) => update({ ...col, format: e.target.value })}
                                aria-label={t('studio_apps_panels.data_grid.column_format', 'Column format')}
                            >
                                {FORMATS.map((f) => (
                                    <option key={f} value={f}>{getFormatLabels(t)[f] ?? f}</option>
                                ))}
                            </select>
                        </div>
                    )}
                />
            </fieldset>
            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'default'}
                onChange={(v) => patch({ look: v })}
                options={getLooksOptions(t)}
                disabled={disabled}
            />
            <TextField
                label={t('studio_apps_panels.common.empty_text', 'Empty text')}
                value={props.emptyText}
                onChange={(v) => patch({ emptyText: v })}
                disabled={disabled}
            />
            <Slider
                label={t('studio_apps_panels.table.row_limit', 'Row limit')}
                value={Number.isFinite(props.rowLimit) ? props.rowLimit : 25}
                onChange={(v) => patch({ rowLimit: Math.max(1, Math.min(100, Math.round(v))) })}
                min={1}
                max={100}
                step={1}
                suffix={t('studio_apps_panels.data_grid.rows_suffix', ' rows')}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('table', TableInspector);
