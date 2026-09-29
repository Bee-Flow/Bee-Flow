import React from 'react';
import BindingField from './BindingField';
import { FieldKeyField, TextField, NumberField, IconField, SelectField, usePatch } from './kit';
import { SpecListField } from './SpecPanel';
import ExpressionInput from '../logic/ExpressionInput';
import { registerInspector } from '../registry';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';

// Mirror of the list `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what list always rendered).
const LOOKS = [
    { value: 'rows', label: 'Rows' },
    { value: 'cards', label: 'Cards' },
    { value: 'tiles', label: 'Tiles' },
];

// Mirror of list.badgePlacement (componentSpecs.js).
const BADGE_PLACEMENTS = [
    { value: 'meta', label: 'On the meta line' },
    { value: 'subtitle', label: 'On the subtitle line' },
];

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
                label="Source"
                value={props.source}
                onChange={(v) => patch({ source: v })}
                definition={definition}
                node={node}
                hint="An array of objects to render as cards."
                placeholder='[{"title":"…"}]'
                disabled={disabled}
            />

            <SelectField
                label="Look"
                value={props.look ?? 'rows'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />

            <FieldKeyField
                label="Title field"
                value={props.titleKey}
                onChange={(v) => patch({ titleKey: v })}
                source={props.source}
                placeholder="title"
                ariaLabel="Title field"
                disabled={disabled}
            />
            {fieldKey('subtitleKey', 'Subtitle field', 'Optional, e.g. subtitle')}
            {fieldKey('metaKey', 'Meta field', 'Optional', 'A third line, under the subtitle.')}
            {fieldKey('timestampKey', 'Time field', 'Optional', 'Shown on the right, as “2 h” or a date.')}
            {fieldKey('badgeKey', 'Badge field', 'Optional', 'Its value becomes the badge on each card.')}

            <FormField label="Badge colours" hint="Which value gets which colour. A value not listed here shows as neutral.">
                <SpecListField
                    label="Badge colours"
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

            {fieldKey('unreadKey', 'Unread field', 'Optional', 'A truthy value marks the card as unread.')}

            <SelectField
                label="Badge placement"
                value={props.badgePlacement ?? 'meta'}
                onChange={(v) => patch({ badgePlacement: v })}
                options={BADGE_PLACEMENTS}
                disabled={disabled}
            />

            <FormField label="Highlighted when" hint="A formula. The matching card is shown as selected — e.g. item.id == vars.openId.">
                <ExpressionInput
                    variant="inline"
                    value={props.selectedWhen || ''}
                    onChange={(v) => patch({ selectedWhen: v || null })}
                    definition={definition}
                    node={node}
                    ariaLabel="Highlighted when"
                    placeholder="e.g. item.id == vars.openId"
                    disabled={disabled}
                />
            </FormField>

            {fieldKey('selectedDetailKey', 'Selected detail field', 'Optional', 'An extra accent line, shown only on the selected card.')}

            {fieldKey('groupKey', 'Group by field', 'Optional', 'Rows are grouped under uppercase headers by this field.')}

            <FormField label="Group order" hint="Fixed order of group values; groups not listed follow in first-seen order.">
                <fieldset disabled={disabled} className="min-w-0">
                    <RepeatableList
                        label="Group order"
                        items={props.groupOrder || []}
                        onChange={(items) => patch({ groupOrder: items })}
                        makeNew={() => ''}
                        addLabel="Add group value"
                        itemLabel={(v) => v || '(empty)'}
                        renderItem={(value, update) => (
                            <input
                                type="text"
                                className={inputCls}
                                value={value || ''}
                                onChange={(e) => update(e.target.value)}
                                placeholder="Field value (e.g. action_needed)"
                                spellCheck={false}
                            />
                        )}
                    />
                </fieldset>
            </FormField>

            <FormField label="Group labels" hint="A readable header per group value. A value not listed shows its raw value.">
                <SpecListField
                    label="Group labels"
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
                label="Peek source"
                value={props.peekSource}
                onChange={(v) => patch({ peekSource: v })}
                definition={definition}
                node={node}
                hint="Records related to the rows — shown on hover, and counted into the badge. An aggregate keeps it small on a long table."
                placeholder='[{"thread_key":"…"}]'
                disabled={disabled}
            />
            {fieldKey('peekMatchKey', 'Peek match field', 'Optional', 'The field on the related record that must equal the row’s value.')}
            {fieldKey('peekRowKey', 'Peek row field', 'Same name', 'The field on the LIST row. Leave empty when both sides use the same name.')}
            {fieldKey('peekTitleKey', 'Peek title field', 'Optional', 'The main text of each related record in the panel.')}
            {fieldKey('peekTextKey', 'Peek text field', 'Optional', 'A second, muted line next to it.')}
            {fieldKey('peekGroupKey', 'Peek group field', 'Optional', 'Groups the panel, and its biggest group names the badge — “14 to check”.')}

            <FormField label="Peek group labels" hint="A readable label per group value, and the colour the badge takes when that group names it. A value not listed shows its raw value and keeps the row’s own colour.">
                <SpecListField
                    label="Peek group labels"
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

            {fieldKey('peekCountKey', 'Peek count field', 'Optional', 'Sum this field instead of counting rows — what an aggregate source needs.')}

            <NumberField
                label="Peek rows shown"
                value={props.peekLimit ?? 6}
                onChange={(v) => patch({ peekLimit: v == null ? 6 : Math.min(20, Math.max(1, Math.round(v))) })}
                hint="How many related records the panel lists (1–20) before it says how many more there are."
                disabled={disabled}
            />
            <TextField
                label="Peek title"
                value={props.peekTitle}
                onChange={(v) => patch({ peekTitle: v || null })}
                disabled={disabled}
            />
            <TextField
                label="Peek “more” text"
                value={props.peekMoreText}
                onChange={(v) => patch({ peekMoreText: v || null })}
                hint="Shown when the panel is cut short. Use {count} for the number left over."
                disabled={disabled}
            />
            <FormField label="Count in the badge" hint="Off: the badge keeps reading the badge field. On: it reads “14 to check”.">
                <Toggle
                    label="Count in the badge"
                    checked={!!props.peekBadge}
                    onChange={(v) => patch({ peekBadge: v })}
                    disabled={disabled}
                    size="sm"
                />
            </FormField>

            <IconField label="Icon" value={props.icon} onChange={(v) => patch({ icon: v })} disabled={disabled} />
            <TextField
                label="Empty text"
                value={props.emptyText}
                onChange={(v) => patch({ emptyText: v })}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('list', ListInspector);
