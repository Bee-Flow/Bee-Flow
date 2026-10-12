import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, SelectField, usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { registerInspector } from '../registry';
import { COLOR_ROLES } from '../styleKnobMeta';

function getCardLooksOptions(t) {
    return [
        { value: 'default', label: t('studio_apps_panels.common.look_default', 'Default') },
        { value: 'tinted', label: t('studio_apps_panels.common.look_tinted', 'Tinted') },
        { value: 'raised', label: t('studio_apps_panels.card.look_raised', 'Raised') },
    ];
}

function getColorLabels(t) {
    return {
        primary: t('studio_apps_panels.kanban.color_primary', 'Primary'),
        neutral: t('studio_apps_panels.kanban.color_neutral', 'Neutral'),
        success: t('studio_apps_panels.kanban.color_success', 'Success'),
        warning: t('studio_apps_panels.kanban.color_warning', 'Warning'),
        danger: t('studio_apps_panels.kanban.color_danger', 'Danger'),
        info: t('studio_apps_panels.kanban.color_info', 'Info'),
    };
}

// Mirror of the kanban `cardLook` enum (componentSpecs.js, authoritative —
// first value is the default and renders exactly what the board always
// rendered). Deliberately NOT called "look": the column color above styles
// cards BY DATA; this styles every card the same way.

/**
 * Content panel for kanban. Props mirror componentSpecs.js (authoritative).
 * Bespoke for the columns list (value/label/color) and the drag hint —
 * onCardMove itself is wired as a node event (AI builder / actions tooling),
 * carrying { item: <moved row>, value: <target column value> } as form values.
 */

export default function KanbanInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const CARD_LOOKS = getCardLooksOptions(t);
    const COLOR_LABELS = getColorLabels(t);
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                hint={t('studio_apps_panels.kanban.source_hint', 'An array of objects — one card per row.')}
                placeholder='[{"title":"…","status":"open"}]'
                disabled={disabled}
            />
            <FieldKeyField
                label={t('studio_apps_panels.kanban.group_by_field', 'Group by field')}
                value={props.groupByField}
                onChange={(v) => patch({ groupByField: v })}
                source={props.source}
                placeholder={t('studio_apps_panels.kanban.group_by_placeholder', 'status')}
                hint={t('studio_apps_panels.kanban.group_by_hint', 'The field whose value decides the column.')}
                ariaLabel={t('studio_apps_panels.kanban.group_by_field', 'Group by field')}
                disabled={disabled}
            />
            <fieldset disabled={disabled} className="min-w-0">
                <RepeatableList
                    label={t('studio_apps_panels.kanban.columns', 'Columns')}
                    items={props.columns || []}
                    onChange={(columns) => patch({ columns })}
                    makeNew={() => ({ value: '', label: '', color: 'neutral' })}
                    addLabel={t('studio_apps_panels.kanban.add_column', 'Add column')}
                    collapsible
                    itemLabel={(c) => c.label || c.value}
                    renderItem={(col, update) => (
                        <div className="flex flex-col gap-2">
                            <input
                                type="text"
                                className={inputCls}
                                value={col.value || ''}
                                onChange={(e) => update({ ...col, value: e.target.value })}
                                placeholder={t('studio_apps_panels.kanban.column_value_placeholder', 'Value (e.g. open)')}
                                spellCheck={false}
                                aria-label={t('studio_apps_panels.kanban.column_value', 'Column value')}
                            />
                            <input
                                type="text"
                                className={inputCls}
                                value={col.label || ''}
                                onChange={(e) => update({ ...col, label: e.target.value })}
                                placeholder={t('studio_apps_panels.common.heading_optional', 'Heading (optional)')}
                                aria-label={t('studio_apps_panels.kanban.column_heading', 'Column heading')}
                            />
                            <select
                                className={inputCls}
                                value={col.color || 'neutral'}
                                onChange={(e) => update({ ...col, color: e.target.value })}
                                aria-label={t('studio_apps_panels.kanban.column_color', 'Column color')}
                            >
                                {COLOR_ROLES.map((r) => <option key={r} value={r}>{COLOR_LABELS[r] ?? r}</option>)}
                            </select>
                        </div>
                    )}
                />
            </fieldset>
            <p className="text-xs text-[var(--text-muted)]">
                {t('studio_apps_panels.kanban.columns_hint', 'Leave columns empty to derive them from the data’s distinct values.')}
            </p>
            <FieldKeyField label={t('studio_apps_panels.kanban.title_field', 'Title field')} value={props.titleKey} onChange={(v) => patch({ titleKey: v })} source={props.source} placeholder={t('studio_apps_panels.kanban.title_placeholder', 'title')} ariaLabel={t('studio_apps_panels.kanban.title_field', 'Title field')} disabled={disabled} />
            <FieldKeyField label={t('studio_apps_panels.kanban.subtitle_field', 'Subtitle field')} value={props.subtitleKey} onChange={(v) => patch({ subtitleKey: v || null })} source={props.source} placeholder={t('studio_apps_panels.common.optional', 'Optional')} ariaLabel={t('studio_apps_panels.kanban.subtitle_field', 'Subtitle field')} disabled={disabled} />
            <FieldKeyField label={t('studio_apps_panels.kanban.badge_field', 'Badge field')} value={props.badgeKey} onChange={(v) => patch({ badgeKey: v || null })} source={props.source} placeholder={t('studio_apps_panels.common.optional', 'Optional')} ariaLabel={t('studio_apps_panels.kanban.badge_field', 'Badge field')} disabled={disabled} />
            <SelectField
                label={t('studio_apps_panels.kanban.card_look', 'Card look')}
                value={props.cardLook ?? 'default'}
                onChange={(v) => patch({ cardLook: v })}
                options={CARD_LOOKS}
                hint={t('studio_apps_panels.kanban.card_look_hint', 'Every card, the same way — column colours still come from the data.')}
                disabled={disabled}
            />
            <Toggle
                label={t('studio_apps_panels.kanban.allow_drag', 'Allow dragging cards')}
                checked={props.allowDrag !== false}
                onChange={(v) => patch({ allowDrag: v })}
                disabled={disabled}
                size="sm"
            />
            <p className="text-xs text-[var(--text-muted)]">
                {t('studio_apps_panels.kanban.drop_prefix', 'Dropping a card fires the node’s')} <code>onCardMove</code> {t('studio_apps_panels.kanban.drop_action_with', 'action with')}
                <code> form.item</code> {t('studio_apps_panels.kanban.drop_row_and', '(the row) and')} <code>form.value</code> {t('studio_apps_panels.kanban.drop_new_value', '(the new column value).')}
            </p>
        </div>
    );
}

registerInspector('kanban', KanbanInspector);
