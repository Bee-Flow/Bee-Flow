/**
 * One person or group on a form's audience: a 28dp tile (initials, or the
 * group glyph), the name, what it is — and a × when it can be taken off.
 */

import React from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { initialsOf, type GranteeType } from '@/features/forms/model/audience';
import { Icon, IconButton, Text } from '@/shared/ui';


export function GranteeRow({
    type,
    name,
    detail,
    onPress,
    onRemove,
    disabled = false,
}: {
    type: GranteeType;
    name: string;
    detail?: string;
    onPress?: () => void;
    onRemove?: () => void;
    disabled?: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const what = type === 'group' ? t('forms.share.audience_group', 'A group — every member') : t('forms.share.audience_person', 'A person');
    return (
        <Pressable onPress={onPress} disabled={!onPress || disabled} accessibilityRole={onPress ? 'button' : undefined} style={styles.row}>
            <View style={styles.tile}>
                {type === 'group' ? <Icon name="Users" size={14} color={styles.initials.color} /> : <Text style={styles.initials}>{initialsOf(name)}</Text>}
            </View>
            <View style={styles.text}>
                <Text variant="body" weight="medium" numberOfLines={1}>
                    {name}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {detail || what}
                </Text>
            </View>
            {onRemove ? (
                <IconButton
                    icon={<Icon name="X" size={16} />}
                    accessibilityLabel={t('forms.share.audience_remove', 'Remove {name}', { name })}
                    onPress={onRemove}
                    disabled={disabled}
                />
            ) : null}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2.5], minHeight: theme.minTouch, paddingVertical: theme.spacing.xs } satisfies ViewStyle,
    tile: {
        width: 28,
        height: 28,
        borderRadius: theme.radii.sm,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.bgTertiary,
    } satisfies ViewStyle,
    initials: { fontSize: 11, fontWeight: '700', color: theme.colors.textSecondary } satisfies TextStyle,
    text: { flex: 1, minWidth: 0 } satisfies ViewStyle,
});
