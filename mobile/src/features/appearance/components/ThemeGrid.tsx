/**
 * The theme: "match my phone" first (Android's own light/dark switch
 * chooses), then Day and Night as miniatures, side by side. Those three are
 * the whole choice: the web's other themes are not offered on the phone.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme, type ThemePreference } from '@/core/theme/ThemeProvider';
import { PICKABLE_THEMES } from '@/core/theme/tokens';
import { Group, Icon, OptionRow, Text } from '@/shared/ui';

import { ThemePreview } from './ThemePreview';
import { themeHint, themeName } from '../model/themes';

export function ThemeGrid({
    saving,
    onChoose,
}: {
    saving: boolean;
    onChoose: (preference: ThemePreference) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const following = theme.preference === 'system';
    return (
        <View style={styles.grid}>
            <Group title={t('settings.theme', 'Theme')}>
                <OptionRow
                    label={t('mobile.appearance.match_phone', 'Match my phone')}
                    description={
                        following
                            ? t('mobile.appearance.showing', 'Showing {theme} now', { theme: themeName(theme.name) })
                            : t('mobile.appearance.match_phone_hint', "Light or dark, following Android's setting")
                    }
                    selected={following}
                    onPress={() => onChoose('system')}
                    leading={<Icon name="Smartphone" size={18} color={theme.colors.textSecondary} />}
                />
            </Group>

            <View accessibilityRole="radiogroup" style={styles.row}>
                {PICKABLE_THEMES.map((name) => (
                    <ThemePreview
                        key={name}
                        name={name}
                        label={themeName(name)}
                        description={themeHint(name)}
                        selected={theme.preference === name}
                        accentOverride={theme.branding.accentColor ?? null}
                        onPress={() => onChoose(name)}
                    />
                ))}
            </View>

            {saving ? (
                <Text variant="caption" tone="tertiary" center>
                    {t('common.saving', 'Saving…')}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        grid: { gap: theme.spacing.md },
        row: { flexDirection: 'row', gap: theme.spacing.md },
    });
