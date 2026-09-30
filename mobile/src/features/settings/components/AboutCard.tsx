/** The product in one card, flagged when this is not a production build. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Card, Icon, Text } from '@/shared/ui';

export function AboutCard({ profile }: { profile: string }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.mark}>
                    <Icon name="Hexagon" size={26} color={theme.colors.accentPrimaryFg} />
                </View>
                <Text variant="heading" center>
                    Bee Flow
                </Text>
                <Text variant="caption" tone="tertiary" center>
                    A self-hosted, zero-knowledge AI workspace. Your data stays on your
                    server; nobody at Bee Flow can read it.
                </Text>
                {profile !== 'production' ? (
                    <Badge label={profile.toUpperCase()} tone="warning" />
                ) : null}
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { alignItems: 'center', gap: theme.spacing.sm },
        mark: {
            width: 56,
            height: 56,
            borderRadius: theme.radii.lg,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.accentPrimary,
        },
    });
