import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { registerInspector } from '../registry';
import BindingField from './BindingField';
import { TextField, SelectField, NumberField, usePatch } from './kit';

// Mirror of keyValue.layout (componentSpecs.js).
export default function KeyValueInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const LAYOUTS = [
        { value: 'rows', label: t('studio_apps_panels.key_value.layout_rows', 'Rows (label left)') },
        { value: 'grid', label: t('studio_apps_panels.key_value.layout_grid', 'Grid (label on top)') },
    ];
    const patch = usePatch(node, definition, onCommit);
    const layout = props.layout ?? 'rows';

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                hint={t('studio_apps_panels.key_value.source_hint', 'An object to render as label/value rows.')}
                placeholder='{"title":"…","owner":"…"}'
                disabled={disabled}
            />
            <SelectField
                label={t('studio_apps_panels.key_value.layout', 'Layout')}
                value={layout}
                onChange={(v) => patch({ layout: v })}
                options={LAYOUTS}
                disabled={disabled}
            />
            {layout === 'grid' ? (
                <NumberField
                    label={t('studio_apps_panels.key_value.columns', 'Columns')}
                    value={props.columns ?? 2}
                    onChange={(v) => patch({ columns: v })}
                    hint={t('studio_apps_panels.key_value.columns_hint', '1–4 columns, divided by vertical lines.')}
                    disabled={disabled}
                />
            ) : null}
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.common.fields', 'Fields')}
                    items={props.fields || []}
                    onChange={(fields) => patch({ fields })}
                    makeNew={() => ({ key: '', label: '' })}
                    addLabel={t('studio_apps_panels.common.add_field', 'Add field')}
                    itemLabel={(f) => f.label || f.key}
                    renderItem={(field, update) => (
                        <div className="flex flex-col gap-2">
                            <input
                                type="text"
                                className={inputCls}
                                value={field.key || ''}
                                onChange={(e) => update({ ...field, key: e.target.value })}
                                placeholder={t('studio_apps_panels.key_value.key_placeholder', 'Key (e.g. owner)')}
                                spellCheck={false}
                            />
                            <input
                                type="text"
                                className={inputCls}
                                value={field.label || ''}
                                onChange={(e) => update({ ...field, label: e.target.value })}
                                placeholder={t('studio_apps_panels.common.label_optional', 'Label (optional)')}
                            />
                        </div>
                    )}
                />
            </fieldset>
            <TextField
                label={t('studio_apps_panels.common.empty_text', 'Empty text')}
                value={props.emptyText}
                onChange={(v) => patch({ emptyText: v })}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('keyValue', KeyValueInspector);
