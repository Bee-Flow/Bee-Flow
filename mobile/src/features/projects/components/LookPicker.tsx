/**
 * The project's look: an icon from the web's emoji set and a colour from its
 * palette (model/form.ts). Two rows of taps, no free text — the web offers
 * exactly these, and a project made on the phone should look the same there.
 */

import React from 'react';
import { Pressable, ScrollView, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AppIcon, Icon, Text } from '@/shared/ui';

import { PROJECT_COLORS, PROJECT_ICONS } from '../model/form';

export function LookPicker({
    icon,
    color,
    onIcon,
    onColor,
}: {
    icon: string;
    color: string;
    onIcon: (next: string) => void;
    onColor: (next: string) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.block}>
            <Text variant="label" tone="secondary">
                {t('mobile.projects.field_icon', 'Icon')}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                {PROJECT_ICONS.map((choice) => (
                    <Pressable
                        key={choice}
                        onPress={() => onIcon(choice)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: choice === icon }}
                        accessibilityLabel={choice}
                        style={[styles.cell, choice === icon ? styles.selected : null]}
                    >
                        <AppIcon name={choice} size={20} />
                    </Pressable>
                ))}
            </ScrollView>
            <Text variant="label" tone="secondary">
                {t('mobile.projects.field_color', 'Colour')}
            </Text>
            <View style={styles.wrap}>
                {PROJECT_COLORS.map((choice) => (
                    <Pressable
                        key={choice}
                        onPress={() => onColor(choice)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: choice === color }}
                        accessibilityLabel={choice}
                        style={[styles.swatch, styles.swatchFill[choice]]}
                    >
                        {choice === color ? <Icon name="Check" size={16} color={styles.check.color} /> : null}
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    block: { gap: theme.spacing.sm } satisfies ViewStyle,
    row: { gap: theme.spacing.xs } satisfies ViewStyle,
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
    cell: {
        width: 44,
        height: 44,
        borderRadius: theme.radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'transparent',
    } satisfies ViewStyle,
    selected: { borderColor: theme.colors.accentPrimary, backgroundColor: theme.colors.bgTertiary } satisfies ViewStyle,
    swatch: { width: 36, height: 36, borderRadius: theme.radii.pill, alignItems: 'center', justifyContent: 'center' } satisfies ViewStyle,
    swatchFill: Object.fromEntries(PROJECT_COLORS.map((c) => [c, { backgroundColor: c }])) as Record<string, ViewStyle>,
    check: { color: '#ffffff' },
});
