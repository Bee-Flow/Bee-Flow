/**
 * An ordered list of values, one per row, each able to take data — a deck's
 * slides, one Slide step reference per row. Rows move up and down, and a new
 * one starts empty (the step's patch drops blank rows on the way out, so an
 * unfinished row costs nothing).
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon, IconButton } from '@/shared/ui';

import { BindingInput } from './BindingInput';
import { FieldRow } from './FieldRow';

/** Move row `i` by `dir` (-1 up, +1 down); out of range is a no-op. */
export function moveRow<T>(rows: readonly T[], i: number, dir: -1 | 1): T[] {
    const j = i + dir;
    if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return rows.slice();
    const next = rows.slice();
    [next[i], next[j]] = [next[j] as T, next[i] as T];
    return next;
}

export function StringListField({
    value,
    onChange,
    label,
    hint,
    prompt,
    required,
    disabled,
    testID,
}: {
    value: readonly unknown[];
    onChange: (next: string[]) => void;
    label?: string;
    hint?: string | null;
    prompt?: string;
    required?: boolean;
    disabled?: boolean;
    testID?: string;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const rows = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
    const setRow = (i: number, text: string) => onChange(rows.map((r, k) => (k === i ? text : r)));
    const glyph = styles.glyph.color;
    return (
        <FieldRow label={label} hint={hint} required={required} testID={testID}>
            {rows.map((row, i) => (
                <View key={i} style={styles.row}>
                    <View style={styles.value}>
                        <BindingInput mode="template" value={row} onChange={(v) => setRow(i, String(v))} prompt={prompt} disabled={disabled} />
                    </View>
                    {disabled ? null : (
                        <View style={styles.tools}>
                            <IconButton icon={<Icon name="ChevronUp" size={16} color={glyph} />} accessibilityLabel={t('mobile.flow.list.up', 'Move up')} disabled={i === 0} onPress={() => onChange(moveRow(rows, i, -1))} />
                            <IconButton icon={<Icon name="ChevronDown" size={16} color={glyph} />} accessibilityLabel={t('mobile.flow.list.down', 'Move down')} disabled={i === rows.length - 1} onPress={() => onChange(moveRow(rows, i, 1))} />
                            <IconButton icon={<Icon name="Trash2" size={16} color={glyph} />} accessibilityLabel={t('common.remove', 'Remove')} onPress={() => onChange(rows.filter((_, k) => k !== i))} />
                        </View>
                    )}
                </View>
            ))}
            {disabled ? null : (
                <View style={styles.add}>
                    <Button size="sm" variant="secondary" iconName="Plus" label={t('common.add', 'Add')} onPress={() => onChange([...rows, ''])} />
                </View>
            )}
        </FieldRow>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs } satisfies ViewStyle,
    value: { flex: 1 } satisfies ViewStyle,
    tools: { flexDirection: 'row' } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
    add: { flexDirection: 'row' } satisfies ViewStyle,
});
