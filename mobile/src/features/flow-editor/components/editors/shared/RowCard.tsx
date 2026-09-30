/**
 * One row of an editable list — a rule, a stage, a question, a table tool —
 * as the web's `cardClass()` card: a header naming the row, the up/down and
 * remove buttons, and the row's fields under it. Up and down move whole rows
 * (what they carry — a stage key, a case name — travels with them), so no
 * list here re-derives anything from a position.
 */

import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

export interface RowCardProps {
    title?: string | null;
    /** Where the row sits, for the move buttons' names ("Move … up"). */
    name?: string;
    onMoveUp?: (() => void) | null;
    onMoveDown?: (() => void) | null;
    onRemove?: (() => void) | null;
    removeLabel?: string;
    disabled?: boolean;
    children?: ReactNode;
    testID?: string;
}

export function RowCard({ title, name, onMoveUp, onMoveDown, onRemove, removeLabel, disabled = false, children, testID }: RowCardProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const what = name ?? title ?? '';
    return (
        <View style={styles.card} testID={testID}>
            <View style={styles.head}>
                <Text variant="caption" weight="semibold" numberOfLines={1} style={styles.title}>
                    {title ?? ''}
                </Text>
                {onMoveUp !== undefined ? (
                    <IconButton
                        icon={<Icon name="ChevronUp" size={16} color={styles.glyph.color} />}
                        onPress={() => onMoveUp?.()}
                        disabled={disabled || !onMoveUp}
                        accessibilityLabel={t('mobile.flow.row.move_up', 'Move {name} up', { name: what })}
                    />
                ) : null}
                {onMoveDown !== undefined ? (
                    <IconButton
                        icon={<Icon name="ChevronDown" size={16} color={styles.glyph.color} />}
                        onPress={() => onMoveDown?.()}
                        disabled={disabled || !onMoveDown}
                        accessibilityLabel={t('mobile.flow.row.move_down', 'Move {name} down', { name: what })}
                    />
                ) : null}
                {onRemove ? (
                    <IconButton
                        tone="danger"
                        icon={<Icon name="Trash2" size={16} color={styles.glyph.color} />}
                        onPress={onRemove}
                        disabled={disabled}
                        accessibilityLabel={removeLabel ?? t('mobile.flow.row.remove', 'Remove {name}', { name: what })}
                    />
                ) : null}
            </View>
            {children}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    title: { flex: 1 },
    glyph: { color: theme.colors.textTertiary },
});
