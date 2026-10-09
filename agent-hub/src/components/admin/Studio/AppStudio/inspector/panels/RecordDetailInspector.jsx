import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, TextField, usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { registerInspector } from '../registry';

/**
 * Content panel for record_detail. Props mirror componentSpecs.js
 * (authoritative). Bespoke for the fields list UX (key/label/format rows) and
 * the 1–3 column layout picker.
 */

const FORMATS = ['text', 'number', 'date', 'datetime', 'badge', 'link', 'markdown', 'document', 'cad'];
function getLayoutOptionsOptions(t) {
    return [
        { value: 'stacked', label: t('studio_apps_panels.record_detail.layout_stacked', 'Stacked') },
        { value: 'rows', label: t('studio_apps_panels.record_detail.layout_rows', 'Rows') },
    ];
}

function getColumnOptionsOptions(t) {
    return [
        { value: 1, label: t('studio_apps_panels.record_detail.columns_1', '1 column') },
        { value: 2, label: t('studio_apps_panels.record_detail.columns_2', '2 columns') },
        { value: 3, label: t('studio_apps_panels.record_detail.columns_3', '3 columns') },
    ];
}

function getFormatLabels(t) {
    return {
        text: t('studio_apps_panels.data_grid.format_text', 'Text'),
        number: t('studio_apps_panels.data_grid.format_number', 'Number'),
        date: t('studio_apps_panels.data_grid.format_date', 'Date'),
        datetime: t('studio_apps_panels.data_grid.format_datetime', 'Datetime'),
        badge: t('studio_apps_panels.data_grid.format_badge', 'Badge'),
        link: t('studio_apps_panels.data_grid.format_link', 'Link'),
        markdown: t('studio_apps_panels.record_detail.format_markdown', 'Markdown'),
        document: t('studio_apps_panels.data_grid.format_document', 'Document'),
        cad: t('studio_apps_panels.data_grid.format_cad', 'Cad'),
    };
}

// Mirror of record_detail.layout (componentSpecs.js) — first value is the
// default and renders what every record_detail always rendered.

export default function RecordDetailInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const LAYOUT_OPTIONS = getLayoutOptionsOptions(t);
    const COLUMN_OPTIONS = getColumnOptionsOptions(t);
    const FORMAT_LABELS = getFormatLabels(t);
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                hint={t('studio_apps_panels.record_detail.source_hint', 'ONE record — typically a record binding filtered by screen.params.')}
                placeholder='{"name":"…"}'
                disabled={disabled}
            />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.common.fields', 'Fields')}
                    items={props.fields || []}
                    onChange={(fields) => patch({ fields })}
                    makeNew={() => ({ key: '', label: '', format: 'text' })}
                    addLabel={t('studio_apps_panels.common.add_field', 'Add field')}
                    collapsible
                    itemLabel={(f) => f.label || f.key}
                    renderItem={(field, update) => (
                        <div className="flex flex-col gap-2">
                            {/* The panel already holds the source binding, so
                                the column list is right there — this used to be
                                free text and a typo like "statuss" produced a
                                silently blank row, exactly what every other data
                                panel stopped doing when it moved to FieldKeyField. */}
                            <FieldKeyField
                                value={field.key}
                                onChange={(v) => update({ ...field, key: v })}
                                source={props.source}
                                placeholder={t('studio_apps_panels.common.key_placeholder', 'Key (e.g. status)')}
                                ariaLabel={t('studio_apps_panels.record_detail.field_key', 'Field key')}
                            />
                            <input
                                type="text"
                                className={inputCls}
                                value={field.label || ''}
                                onChange={(e) => update({ ...field, label: e.target.value })}
                                placeholder={t('studio_apps_panels.common.label_optional', 'Label (optional)')}
                                aria-label={t('studio_apps_panels.record_detail.field_label', 'Field label')}
                            />
                            <select
                                className={inputCls}
                                value={field.format || 'text'}
                                onChange={(e) => update({ ...field, format: e.target.value })}
                                aria-label={t('studio_apps_panels.record_detail.field_format', 'Field format')}
                            >
                                {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f] ?? f}</option>)}
                            </select>
                            <input
                                type="text"
                                className={inputCls}
                                value={field.group || ''}
                                onChange={(e) => update({ ...field, group: e.target.value || undefined })}
                                placeholder={t('studio_apps_panels.record_detail.group_placeholder', 'Group heading (optional)')}
                                aria-label={t('studio_apps_panels.record_detail.field_group', 'Field group')}
                            />
                        </div>
                    )}
                />
            </fieldset>
            <p className="text-xs text-[var(--text-secondary)]">
                {t('studio_apps_panels.record_detail.fields_hint', 'Leave fields empty to show every column of the record.')}
            </p>
            <FormField label={t('studio_apps_panels.record_detail.layout', 'Layout')} hint={t('studio_apps_panels.record_detail.layout_hint', 'Stacked = label above value. Rows = label and value on one line, value right-aligned — the fact sheet a narrow panel can hold.')}>
                <SegmentedControl
                    value={props.layout === 'rows' ? 'rows' : 'stacked'}
                    onChange={(v) => patch({ layout: v })}
                    options={LAYOUT_OPTIONS}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.record_detail.layout_aria', 'Detail layout')}
                />
            </FormField>
            <FormField label={t('studio_apps_panels.record_detail.columns', 'Columns')}>
                <SegmentedControl
                    value={Number.isInteger(props.columns) ? props.columns : 2}
                    onChange={(v) => patch({ columns: v })}
                    options={COLUMN_OPTIONS}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.record_detail.columns_aria', 'Detail columns')}
                />
            </FormField>
            <TextField
                label={t('studio_apps_panels.common.empty_text', 'Empty text')}
                value={props.emptyText}
                onChange={(v) => patch({ emptyText: v })}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('record_detail', RecordDetailInspector);
