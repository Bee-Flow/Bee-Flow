/**
 * "Table tools" — the web's SetOperationsEditor: one card per whole-table
 * operation, applied top to bottom AFTER the per-row fields. Order is
 * meaning (rename before keep, sort before number), so cards move up and
 * down rather than being deleted and re-added; each card's column choices
 * are the columns that exist AT THAT POINT (setModel.columnsAt).
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { NumberField, SelectField } from '@/features/flow-editor/components/fields';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { IconButton, Icon, OptionRow, Sheet, Text } from '@/shared/ui';

import { collisionOf, columnsAt, keyRows, opDef, SET_OP_DEFS, setKeyAt, type SetOp } from './setModel';
import { SuggestText } from '../declarative/rows/SuggestText';
import { say } from '../declarative/runtime';
import { AddButton } from '../shared/AddButton';
import { CommitText } from '../shared/CommitText';
import { moveAt, patchAt, removeAt } from '../shared/list';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';

/** Example column names in the empty boxes: identifiers, not copy. */
const ROW_ID_EXAMPLE = 'id';
const GROUP_ID_EXAMPLE = 'groupId';

function KeyList({ keys, options, onChange, addLabel, disabled }: { keys: unknown; options: readonly string[]; onChange: (next: string[]) => void; addLabel: string; disabled: boolean }) {
    const t = useTranslation();
    const rows = keyRows(keys);
    return (
        <>
            {rows.map((k, i) => (
                <React.Fragment key={i}>
                    <SuggestText value={k} onChange={(v) => onChange(setKeyAt(keys, i, v))} suggestions={options} label={t('automations.set_operations_editor.column_2', 'Column')} disabled={disabled} />
                    {rows.length > 1 && !disabled ? (
                        <IconButton icon={<Icon name="Trash2" size={14} />} accessibilityLabel={t('automations.set_operations_editor.remove_column', 'Remove column')} onPress={() => onChange(removeAt(rows, i))} />
                    ) : null}
                </React.Fragment>
            ))}
            <AddButton label={addLabel} onPress={() => onChange([...rows, ''])} disabled={disabled} />
        </>
    );
}

interface CardProps {
    op: SetOp;
    options: readonly string[];
    onChange: (patch: Record<string, unknown>) => void;
    disabled: boolean;
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

function OpBody({ op, options, onChange, disabled }: CardProps) {
    const t = useTranslation();
    const warn = (name: unknown) => {
        const m = collisionOf(name, options);
        return m ? say(t, m) : null;
    };
    const target = text(op.target);
    switch (op.op) {
        case 'rowId':
            return (
                <>
                    <CommitText label={t('automations.set_operations_editor.put_the_number_in', 'Put the number in')} value={target} onCommit={(v) => onChange({ target: v })} placeholder={ROW_ID_EXAMPLE} warning={warn(target)} disabled={disabled} />
                    <NumberField label={t('automations.set_operations_editor.start_at', 'Start at')} value={op.start ?? 1} onChange={(start) => onChange({ start })} allowBlank disabled={disabled} />
                </>
            );
        case 'groupId':
            return (
                <>
                    <Text variant="label" tone="tertiary">
                        {t('automations.set_operations_editor.rows_match_when_these_are_equal', 'Rows match when these are equal')}
                    </Text>
                    <KeyList keys={op.keys} options={options} onChange={(keys) => onChange({ keys })} addLabel={t('mobile.flow.set.add_another_column', 'Add another column')} disabled={disabled} />
                    <CommitText label={t('automations.set_operations_editor.put_the_shared_id_in', 'Put the shared ID in')} value={target} onCommit={(v) => onChange({ target: v })} placeholder={GROUP_ID_EXAMPLE} warning={warn(target)} disabled={disabled} />
                    <Note>{t('automations.set_operations_editor.rows_with_the_same_value_s', 'Rows with the same value(s) get the same number, in order of first appearance. Text matches ignore upper/lower case.')}</Note>
                </>
            );
        case 'rename':
            return (
                <>
                    <SuggestText value={text(op.from)} onChange={(from) => onChange({ from })} suggestions={options} label={t('mobile.flow.set.rename', 'Rename')} prompt={t('automations.set_operations_editor.current_name', 'current name')} disabled={disabled} />
                    <CommitText
                        value={text(op.to)}
                        onCommit={(to) => onChange({ to })}
                        placeholder={t('automations.set_operations_editor.new_name', 'new name')}
                        warning={op.to !== op.from ? warn(op.to) : null}
                        disabled={disabled}
                    />
                </>
            );
        case 'keep':
        case 'remove':
            return (
                <>
                    <Text variant="label" tone="tertiary">
                        {op.op === 'keep' ? t('mobile.flow.set.keep_only', 'Keep only these fields') : t('mobile.flow.set.remove_these', 'Remove these fields')}
                    </Text>
                    <KeyList keys={op.keys} options={options} onChange={(keys) => onChange({ keys })} addLabel={t('mobile.flow.set.add_a_column', 'Add a column')} disabled={disabled} />
                </>
            );
        case 'sort':
            return (
                <>
                    <SuggestText value={text(op.key)} onChange={(key) => onChange({ key })} suggestions={options} label={t('automations.set_operations_editor.sort_by', 'Sort by')} prompt={t('automations.set_operations_editor.column_to_sort_by', 'column to sort by')} disabled={disabled} />
                    <SelectField
                        value={op.direction === 'desc' ? 'desc' : 'asc'}
                        options={[
                            { value: 'asc', label: t('automations.set_operations_editor.a_z_low_high', 'A → Z / low → high') },
                            { value: 'desc', label: t('automations.set_operations_editor.z_a_high_low', 'Z → A / high → low') },
                        ]}
                        onChange={(direction) => onChange({ direction })}
                        disabled={disabled}
                    />
                </>
            );
        default:
            return null;
    }
}

export function SetOperationsEditor({ ops, onChange, baseColumns, disabled = false }: { ops: readonly SetOp[]; onChange: (next: SetOp[]) => void; baseColumns: readonly string[]; disabled?: boolean }) {
    const t = useTranslation();
    const [menu, setMenu] = useState(false);
    return (
        <>
            {ops.length === 0 ? <Note>{t('automations.set_operations_editor.nothing_yet_number_the_rows_give', 'Nothing yet — number the rows, give matching rows a shared ID, rename, keep/remove or sort.')}</Note> : null}
            {ops.map((op, i) => {
                const def = opDef(op.op);
                return (
                    <RowCard
                        key={i}
                        title={def ? say(t, def.title) : humanizeFieldKey(op.op)}
                        onMoveUp={i > 0 ? () => onChange(moveAt(ops, i, -1)) : null}
                        onMoveDown={i < ops.length - 1 ? () => onChange(moveAt(ops, i, 1)) : null}
                        onRemove={() => onChange(removeAt(ops, i))}
                        removeLabel={t('automations.set_operations_editor.remove_operation', 'Remove operation')}
                        disabled={disabled}
                        testID={`set-op-${i + 1}`}
                    >
                        <OpBody op={op} options={columnsAt(baseColumns, ops, i)} onChange={(patch) => onChange(patchAt(ops, i, patch))} disabled={disabled} />
                    </RowCard>
                );
            })}
            <AddButton label={t('automations.set_operations_editor.add_a_table_tool', 'Add a table tool')} onPress={() => setMenu(true)} disabled={disabled} testID="set-op-add" />
            <Sheet visible={menu} onClose={() => setMenu(false)} title={t('automations.set_operations_editor.add_a_table_tool', 'Add a table tool')}>
                {SET_OP_DEFS.map((def) => (
                    <OptionRow
                        key={def.op}
                        label={say(t, def.title)}
                        description={say(t, def.hint)}
                        selected={false}
                        onPress={() => {
                            setMenu(false);
                            onChange([...ops, def.makeDefault()]);
                        }}
                        testID={`set-op-add-${def.op}`}
                    />
                ))}
            </Sheet>
        </>
    );
}
