import React from 'react';
import { usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { registerInspector } from '../registry';

/**
 * Content panel for filter_bar. Props mirror componentSpecs.js (authoritative):
 * fields: [{ name, label?, type: search|select|toggle|date, options? }] — each
 * control writes vars.filters.<name> at runtime, for use in records-binding
 * filter formulas. Bespoke because the nested options list (select type) is
 * beyond the generic SpecPanel list editor.
 */

function getFieldTypesOptions(t) {
    return [
        { value: 'search', label: t('studio_apps_panels.filter_bar.type_search', 'Search') },
        { value: 'select', label: t('studio_apps_panels.filter_bar.type_select', 'Select') },
        { value: 'toggle', label: t('studio_apps_panels.filter_bar.type_toggle', 'Toggle') },
        { value: 'date', label: t('studio_apps_panels.filter_bar.type_date', 'Date') },
    ];
}

export default function FilterBarInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const FIELD_TYPES = getFieldTypesOptions(t);
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.filter_bar.filters', 'Filters')}
                    items={props.fields || []}
                    onChange={(fields) => patch({ fields })}
                    makeNew={() => ({ name: '', label: '', type: 'search', options: [] })}
                    addLabel={t('studio_apps_panels.filter_bar.add_filter', 'Add filter')}
                    collapsible
                    itemLabel={(f) => f.label || f.name}
                    renderItem={(field, update) => (
                        <div className="flex flex-col gap-2">
                            <input
                                type="text"
                                className={inputCls}
                                value={field.name || ''}
                                onChange={(e) => update({ ...field, name: e.target.value })}
                                placeholder={t('studio_apps_panels.filter_bar.name_placeholder', 'Name (vars.filters.<name>)')}
                                spellCheck={false}
                                aria-label={t('studio_apps_panels.filter_bar.filter_name', 'Filter name')}
                            />
                            <input
                                type="text"
                                className={inputCls}
                                value={field.label || ''}
                                onChange={(e) => update({ ...field, label: e.target.value })}
                                placeholder={t('studio_apps_panels.common.label_optional', 'Label (optional)')}
                                aria-label={t('studio_apps_panels.filter_bar.filter_label', 'Filter label')}
                            />
                            <select
                                className={inputCls}
                                value={field.type || 'search'}
                                onChange={(e) => update({ ...field, type: e.target.value })}
                                aria-label={t('studio_apps_panels.filter_bar.filter_type', 'Filter type')}
                            >
                                {FIELD_TYPES.map((ft) => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                            </select>
                            {field.type === 'select' ? (
                                <RepeatableList
                                    label={t('studio_apps_panels.common.options', 'Options')}
                                    items={field.options || []}
                                    onChange={(options) => update({ ...field, options })}
                                    makeNew={() => ({ value: '', label: '' })}
                                    addLabel={t('studio_apps_panels.common.add_option', 'Add option')}
                                    itemLabel={(o) => o.label || o.value}
                                    renderItem={(opt, updateOpt) => (
                                        <div className="flex flex-col gap-2">
                                            <input
                                                type="text"
                                                className={inputCls}
                                                value={opt.value || ''}
                                                onChange={(e) => updateOpt({ ...opt, value: e.target.value })}
                                                placeholder={t('studio_apps_panels.common.value', 'Value')}
                                                spellCheck={false}
                                                aria-label={t('studio_apps_panels.filter_bar.option_value', 'Option value')}
                                            />
                                            <input
                                                type="text"
                                                className={inputCls}
                                                value={opt.label || ''}
                                                onChange={(e) => updateOpt({ ...opt, label: e.target.value })}
                                                placeholder={t('studio_apps_panels.common.label_optional', 'Label (optional)')}
                                                aria-label={t('studio_apps_panels.filter_bar.option_label', 'Option label')}
                                            />
                                        </div>
                                    )}
                                />
                            ) : null}
                        </div>
                    )}
                />
            </fieldset>
            <p className="text-xs text-[var(--text-muted)]">
                {t('studio_apps_panels.filter_bar.publishes_prefix', 'Each control publishes')} <code>vars.filters.&lt;name&gt;</code> {t('studio_apps_panels.filter_bar.publishes_suffix', '— use it in a records binding’s filter formula, e.g.')} <code>vars.filters.status</code>.
            </p>
        </div>
    );
}

registerInspector('filter_bar', FilterBarInspector);
