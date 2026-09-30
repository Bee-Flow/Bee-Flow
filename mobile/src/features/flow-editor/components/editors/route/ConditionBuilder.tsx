/**
 * The clickable condition editor — the web's ConditionBuilder
 * (Builder/mapping/ConditionBuilder.jsx), shared by the Condition node's
 * outputs and an approval stage's "only ask when": rows of [field] [test]
 * [value] joined by all / any, serialised to the restricted expression the
 * server evaluates. What the rows cannot say stays in raw mode, as text,
 * without losing a character; "Use visual builder" goes back when it can.
 *
 * An expression that changes from OUTSIDE (undo, the AI builder) re-opens
 * the rows; this editor's own writes do not.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';
import { emptyRow, serializeRows, type ConditionRow } from '@/features/flow-editor/model';
import { Button, Segmented, Text } from '@/shared/ui';

import { ConditionRowEditor } from './ConditionRowEditor';
import { canUseVisual, conditionState, hasWildcard, rowType, withoutRow, type ConditionState } from './conditionState';
import type { PickOption } from '../shared/FieldPicker';
import { patchAt } from '../shared/list';

export interface ConditionBuilderProps {
    value: string;
    onChange: (expr: string) => void;
    sampleRoot: unknown;
    /** 'filter' (per item) or 'condition' (the whole run): only the hints differ. */
    context?: 'filter' | 'condition';
    /** Pick fields by name; without it each field is bound like any value. */
    fieldOptions?: readonly PickOption[] | null;
    fieldBase?: string;
    disabled?: boolean;
}

function useConditionState(value: string) {
    const [state, setState] = useState<ConditionState>(() => conditionState(value));
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        const next = conditionState(value);
        // A value this editor cannot show as rows keeps the author in raw mode.
        setState(next.raw ? { ...state, raw: true } : next);
    }
    return { state, setState, setSeen };
}

/**
 * A key per row that stays with the row, so a row's own choices (a field
 * written as an expression rather than picked) never pass to the row that
 * moves up when one above it is removed. Rows replaced from outside (undo,
 * the AI builder) get fresh keys.
 */
function useRowKeys(count: number) {
    const [state, setKeys] = useState(() => ({ keys: Array.from({ length: count }, (_, i) => i), next: count }));
    let { keys } = state;
    if (keys.length !== count) {
        const fresh = { keys: Array.from({ length: count }, (_, i) => state.next + i), next: state.next + count };
        setKeys(fresh);
        keys = fresh.keys;
    }
    const removeAt = (index: number) => setKeys((s) => ({ ...s, keys: s.keys.filter((_, i) => i !== index) }));
    const append = () => setKeys((s) => ({ keys: [...s.keys, s.next], next: s.next + 1 }));
    return { keys, removeAt, append };
}

export function ConditionBuilder({ value, onChange, sampleRoot, context = 'condition', fieldOptions = null, fieldBase = 'item', disabled = false }: ConditionBuilderProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { state, setState, setSeen } = useConditionState(value);
    const emit = (rows: ConditionRow[], join: ConditionState['join']) => {
        const expr = serializeRows(rows, join);
        setState({ rows, join, raw: false });
        setSeen(expr);
        onChange(expr);
    };
    if (state.raw) {
        return (
            <View style={styles.box}>
                <BindingInput
                    mode="expression"
                    multiline
                    value={value}
                    onChange={(next) => {
                        setSeen(String(next));
                        onChange(String(next));
                    }}
                    label={t('mobile.flow.condition.expression', 'Expression')}
                    // The example as its pills will read: "‹Current row ▸ Amount› > 1000".
                    prompt={readableExample(context === 'filter' ? 'item.amount > 1000' : 'steps.step1.output.amount > 1000', true)}
                    disabled={disabled}
                />
                {canUseVisual(value) ? (
                    <Button size="sm" variant="ghost" label={t('mobile.flow.condition.use_visual', 'Use visual builder')} onPress={() => setState(conditionState(value))} />
                ) : null}
            </View>
        );
    }
    const { rows, join } = state;
    return (
        <RowList
            rows={rows}
            join={join}
            emit={emit}
            onRaw={() => setState({ ...state, raw: true })}
            {...{ sampleRoot, context, fieldOptions, fieldBase, disabled }}
        />
    );
}

interface RowListProps extends Required<Pick<ConditionBuilderProps, 'sampleRoot' | 'context' | 'fieldBase' | 'disabled'>> {
    rows: ConditionRow[];
    join: ConditionState['join'];
    emit: (rows: ConditionRow[], join: ConditionState['join']) => void;
    onRaw: () => void;
    fieldOptions: readonly PickOption[] | null;
}

function RowList({ rows, join, emit, onRaw, sampleRoot, context, fieldOptions, fieldBase, disabled }: RowListProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const keys = useRowKeys(rows.length);
    return (
        <View style={styles.box}>
            {rows.length > 1 ? (
                <Segmented
                    value={join}
                    onChange={(j) => emit(rows, j)}
                    options={[
                        { value: '&&', label: t('mobile.flow.condition.match_all', 'Match all of these') },
                        { value: '||', label: t('mobile.flow.condition.match_any', 'Match any of these') },
                    ]}
                    accessibilityLabel={t('mobile.flow.condition.join', 'How the conditions combine')}
                    fullWidth
                />
            ) : null}
            {rows.map((row, i) => (
                <ConditionRowEditor
                    key={keys.keys[i]}
                    row={row}
                    index={i}
                    type={rowType(row, sampleRoot)}
                    onChange={(patch) => emit(patchAt(rows, i, patch), join)}
                    onRemove={
                        rows.length > 1
                            ? () => {
                                  keys.removeAt(i);
                                  emit(withoutRow(rows, i), join);
                              }
                            : null
                    }
                    fieldOptions={fieldOptions}
                    fieldBase={fieldBase}
                    disabled={disabled}
                />
            ))}
            {hasWildcard(rows) ? (
                <Text variant="caption" tone="warning">
                    {context === 'filter'
                        ? t('mobile.flow.condition.wildcard_filter', 'Inside a filter the current element is bound as item — reference item.<field> instead of a list path with [*].')
                        : t('mobile.flow.condition.wildcard', 'This field points at a list (contains [*]). Add a Filter step to work through items one at a time.')}
                </Text>
            ) : null}
            <View style={styles.actions}>
                <Button size="sm" variant="ghost" iconName="Plus" label={t('mobile.flow.condition.add', 'Add condition')} onPress={() => {
                        keys.append();
                        emit([...rows, emptyRow()], join);
                    }} disabled={disabled} />
                <Button size="sm" variant="ghost" label={t('mobile.flow.condition.write_raw', 'Write raw expression')} onPress={onRaw} disabled={disabled} />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.md } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' } satisfies ViewStyle,
});
