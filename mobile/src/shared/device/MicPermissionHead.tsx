/**
 * The top of a card that asks for the microphone before the system does (see
 * useMicPermission): a microphone glyph — struck through, in the warning
 * colour, once the permission is blocked — beside what the microphone is for,
 * or what is missing now. The recorder and voice mode each word it their way.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

export function MicPermissionHead({ blocked, title, body }: { blocked: boolean; title: string; body: string }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <View style={styles.tile}>
                <Icon name={blocked ? 'MicOff' : 'Mic'} size={20} color={blocked ? theme.colors.warning : theme.colors.accentPrimary} />
            </View>
            <View style={styles.titles}>
                <Text variant="subheading">{title}</Text>
                <Text variant="caption" tone="tertiary">
                    {body}
                </Text>
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
        tile: {
            width: 44,
            height: 44,
            borderRadius: theme.radii.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bgTertiary,
        },
        titles: { flex: 1, gap: 2 },
    });
