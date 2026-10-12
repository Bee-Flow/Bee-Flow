import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, TextField, NumberField, IconField, SelectField, usePatch } from './kit';
import { SpecListField } from './SpecPanel';
import useTranslation from '../../../../../../hooks/useTranslation';
import ExpressionInput from '../logic/ExpressionInput';
import { registerInspector } from '../registry';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';

function getLooksOptions(t) {
    return [
        { value: 'rows', label: t('studio_apps_panels.record_detail.layout_rows', 'Rows') },
        { value: 'cards', label: t('studio_apps_panels.list.look_cards', 'Cards') },
        { value: 'tiles', label: t('studio_apps_panels.list.look_tiles', 'Tiles') },
    ];
}

function getBadgePlacementsOptions(t) {
    return [
        { value: 'meta', label: t('studio_apps_panels.list.placement_meta', 'On the meta line') },
        { value: 'subtitle', label: t('studio_apps_panels.list.placement_subtitle', 'On the subtitle line') },
    ];
}

// Mirror of the list `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what list always rendered).
// Mirror of list.badgePlacement (componentSpecs.js).
/**
 * Content panel for `list`.
 *
 * Six props the runtime renders had no control here at all — metaKey,
 * timestampKey, badgeKey, badgeToneMap, unreadKey and selectedWhen. They were
 * AI-builder-only knobs: an author could see the AI produce a list with unread
 * dots and coloured badges and had no way to make, change or even find them.
 */
export default function ListInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const LOOKS = getLooksOptions(t);
    const BADGE_PLACEMENTS = getBadgePlacementsOptions(t);
    const patch = usePatch(node, definition, onCommit);

    const fieldKey = (key, label, placeholder, hint) => (
        <FieldKeyField
            label={label}
            value={props[key]}
            onChange={(v) => patch({ [key]: v || null })}
            source={props.source}
            placeholder={placeholder}
            hint={hint}
            ariaLabel={label}
            disabled={disabled}
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <BindingField
                label={t('studio_apps_panels.common.source', 'Source')}
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                node={node}
                hint={t('studio_apps_panels.list.source_hint', 'An array of objects to render as cards.')}
                placeholder='[{"title":"…"}]'
                disabled={disabled}
            />

            <SelectField
                label={t('studio_apps_panels.common.look', 'Look')}
                value={props.look ?? 'rows'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />

            <FieldKeyField
                label={t('studio_apps_panels.kanban.title_field', 'Title field')}
                value={props.titleKey}
                onChange={(v) => patch({ titleKey: v })}
                source={props.source}
                placeholder={t('studio_apps_panels.kanban.title_placeholder', 'title')}
                ariaLabel={t('studio_apps_panels.kanban.title_field', 'Title field')}
                disabled={disabled}
            />
            {fieldKey('subtitleKey', t('studio_apps_panels.kanban.subtitle_field', 'Subtitle field'), t('studio_apps_panels.list.subtitle_placeholder', 'Optional, e.g. subtitle'))}
            {fieldKey('metaKey', t('studio_apps_panels.list.meta_field', 'Meta field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.meta_hint', 'A third line, under the subtitle.'))}
            {fieldKey('timestampKey', t('studio_apps_panels.list.time_field', 'Time field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.time_hint', 'Shown on the right, as “2 h” or a date.'))}
            {fieldKey('badgeKey', t('studio_apps_panels.kanban.badge_field', 'Badge field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.badge_hint', 'Its value becomes the badge on each card.'))}

            <FormField label={t('studio_apps_panels.list.badge_colours', 'Badge colours')} hint={t('studio_apps_panels.list.badge_colours_hint', 'Which value gets which colour. A value not listed here shows as neutral.')}>
                <SpecListField
                    label={t('studio_apps_panels.list.badge_colours', 'Badge colours')}
                    itemShape={{
                        value: { type: 'string', required: true },
                        label: { type: 'string' },
                        tone: { type: 'enum', values: ['primary', 'neutral', 'success', 'warning', 'danger', 'info'], default: 'neutral' },
                    }}
                    items={props.badgeToneMap}
                    onChange={(items) => patch({ badgeToneMap: items })}
                    disabled={disabled}
                />
            </FormField>

            {fieldKey('unreadKey', t('studio_apps_panels.list.unread_field', 'Unread field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.unread_hint', 'A truthy value marks the card as unread.'))}

            <SelectField
                label={t('studio_apps_panels.list.badge_placement', 'Badge placement')}
                value={props.badgePlacement ?? 'meta'}
                onChange={(v) => patch({ badgePlacement: v })}
                options={BADGE_PLACEMENTS}
                disabled={disabled}
            />

            <FormField label={t('studio_apps_panels.list.highlighted_when', 'Highlighted when')} hint={t('studio_apps_panels.list.highlighted_when_hint', 'A formula. The matching card is shown as selected — e.g. item.id == vars.openId.')}>
                <ExpressionInput
                    variant="inline"
                    value={props.selectedWhen || ''}
                    onChange={(v) => patch({ selectedWhen: v || null })}
                    definition={definition}
                    node={node}
                    ariaLabel={t('studio_apps_panels.list.highlighted_when', 'Highlighted when')}
                    placeholder={t('studio_apps_panels.list.highlighted_when_placeholder', 'e.g. item.id == vars.openId')}
                    disabled={disabled}
                />
            </FormField>

            {fieldKey('selectedDetailKey', t('studio_apps_panels.list.selected_detail_field', 'Selected detail field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.selected_detail_hint', 'An extra accent line, shown only on the selected card.'))}

            {fieldKey('groupKey', t('studio_apps_panels.kanban.group_by_field', 'Group by field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.group_by_hint', 'Rows are grouped under uppercase headers by this field.'))}

            <FormField label={t('studio_apps_panels.list.group_order', 'Group order')} hint={t('studio_apps_panels.list.group_order_hint', 'Fixed order of group values; groups not listed follow in first-seen order.')}>
                <fieldset disabled={disabled} className="min-w-0">
                    <RepeatableList
                        label={t('studio_apps_panels.list.group_order', 'Group order')}
                        items={props.groupOrder || []}
                        onChange={(items) => patch({ groupOrder: items })}
                        makeNew={() => ''}
                        addLabel={t('studio_apps_panels.list.add_group_value', 'Add group value')}
                        itemLabel={(v) => v || t('studio_apps_panels.list.empty_value', '(empty)')}
                        renderItem={(value, update) => (
                            <input
                                type="text"
                                className={inputCls}
                                value={value || ''}
                                onChange={(e) => update(e.target.value)}
                                placeholder={t('studio_apps_panels.list.group_value_placeholder', 'Field value (e.g. action_needed)')}
                                spellCheck={false}
                            />
                        )}
                    />
                </fieldset>
            </FormField>

            <FormField label={t('studio_apps_panels.list.group_labels', 'Group labels')} hint={t('studio_apps_panels.list.group_labels_hint', 'A readable header per group value. A value not listed shows its raw value.')}>
                <SpecListField
                    label={t('studio_apps_panels.list.group_labels', 'Group labels')}
                    itemShape={{
                        value: { type: 'string', required: true },
                        label: { type: 'string' },
                    }}
                    items={props.groupLabelMap}
                    onChange={(items) => patch({ groupLabelMap: items })}
                    disabled={disabled}
                />
            </FormField>

            {/* The peek. Everything below is inert until a source is bound, so
                a list without one shows the controls and changes nothing. */}
            <BindingField
                label={t('studio_apps_panels.list.peek_source', 'Peek source')}
                value={props.peekSource}
                onChange={(v) => patch({ peekSource: v })}
                definition={definition}
                node={node}
                hint={t('studio_apps_panels.list.peek_source_hint', 'Records related to the rows — shown on hover, and counted into the badge. An aggregate keeps it small on a long table.')}
                placeholder='[{"thread_key":"…"}]'
                disabled={disabled}
            />
            {fieldKey('peekMatchKey', t('studio_apps_panels.list.peek_match_field', 'Peek match field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.peek_match_hint', 'The field on the related record that must equal the row’s value.'))}
            {fieldKey('peekRowKey', t('studio_apps_panels.list.peek_row_field', 'Peek row field'), t('studio_apps_panels.list.peek_row_placeholder', 'Same name'), t('studio_apps_panels.list.peek_row_hint', 'The field on the LIST row. Leave empty when both sides use the same name.'))}
            {fieldKey('peekTitleKey', t('studio_apps_panels.list.peek_title_field', 'Peek title field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.peek_title_hint', 'The main text of each related record in the panel.'))}
            {fieldKey('peekTextKey', t('studio_apps_panels.list.peek_text_field', 'Peek text field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.peek_text_hint', 'A second, muted line next to it.'))}
            {fieldKey('peekGroupKey', t('studio_apps_panels.list.peek_group_field', 'Peek group field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.peek_group_hint', 'Groups the panel, and its biggest group names the badge — “14 to check”.'))}

            <FormField label={t('studio_apps_panels.list.peek_group_labels', 'Peek group labels')} hint={t('studio_apps_panels.list.peek_group_labels_hint', 'A readable label per group value, and the colour the badge takes when that group names it. A value not listed shows its raw value and keeps the row’s own colour.')}>
                <SpecListField
                    label={t('studio_apps_panels.list.peek_group_labels', 'Peek group labels')}
                    itemShape={{
                        value: { type: 'string', required: true },
                        label: { type: 'string' },
                        tone: { type: 'enum', values: ['primary', 'neutral', 'success', 'warning', 'danger', 'info'] },
                    }}
                    items={props.peekGroupLabelMap}
                    onChange={(items) => patch({ peekGroupLabelMap: items })}
                    disabled={disabled}
                />
            </FormField>

            {fieldKey('peekCountKey', t('studio_apps_panels.list.peek_count_field', 'Peek count field'), t('studio_apps_panels.common.optional', 'Optional'), t('studio_apps_panels.list.peek_count_hint', 'Sum this field instead of counting rows — what an aggregate source needs.'))}

            <NumberField
                label={t('studio_apps_panels.list.peek_rows_shown', 'Peek rows shown')}
                value={props.peekLimit ?? 6}
                onChange={(v) => patch({ peekLimit: v == null ? 6 : Math.min(20, Math.max(1, Math.round(v))) })}
                hint={t('studio_apps_panels.list.peek_rows_hint', 'How many related records the panel lists (1–20) before it says how many more there are.')}
                disabled={disabled}
            />
            <TextField
                label={t('studio_apps_panels.list.peek_title', 'Peek title')}
                value={props.peekTitle}
                onChange={(v) => patch({ peekTitle: v || null })}
                disabled={disabled}
            />
            <TextField
                label={t('studio_apps_panels.list.peek_more_text', 'Peek “more” text')}
                value={props.peekMoreText}
                onChange={(v) => patch({ peekMoreText: v || null })}
                hint={t('studio_apps_panels.list.peek_more_hint', 'Shown when the panel is cut short. Use {count} for the number left over.', { count: '{count}' })}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_panels.list.count_in_badge', 'Count in the badge')} hint={t('studio_apps_panels.list.count_in_badge_hint', 'Off: the badge keeps reading the badge field. On: it reads “14 to check”.')}>
                <Toggle
                    label={t('studio_apps_panels.list.count_in_badge', 'Count in the badge')}
                    checked={!!props.peekBadge}
                    onChange={(v) => patch({ peekBadge: v })}
                    disabled={disabled}
                    size="sm"
                />
            </FormField>

            <IconField label={t('studio_apps_panels.common.icon', 'Icon')} value={props.icon} onChange={(v) => patch({ icon: v })} disabled={disabled} />
            <TextField
                label={t('studio_apps_panels.common.empty_text', 'Empty text')}
                value={props.emptyText}
                onChange={(v) => patch({ emptyText: v })}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('list', ListInspector);
