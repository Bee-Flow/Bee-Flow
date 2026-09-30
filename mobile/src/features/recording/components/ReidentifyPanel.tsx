/**
 * "Let Bee Flow try again": re-read the transcript and re-assign names. Worth
 * almost nothing without a roster, which is why the roster field is right here
 * rather than hidden.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon, Text, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        panel: {
            gap: theme.spacing.sm,
            paddingTop: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.borderSubtle,
        },
    });

export function ReidentifyPanel({
    attendees,
    busy,
    onReidentify,
}: {
    attendees: string[];
    busy: boolean;
    onReidentify: (roster: string) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [roster, setRoster] = useState(attendees.join(', '));
    return (
        <View style={styles.panel}>
            <Text variant="subheading">Let Bee Flow try again</Text>
            <Text variant="caption" tone="tertiary">
                Re-reads the transcript and re-assigns names. It has almost nothing to go on
                without a list of who was there — so give it one.
            </Text>
            <TextField
                label="Who was in the meeting?"
                value={roster}
                onChangeText={setRoster}
                placeholder="Tom, Gerard, René"
                autoCapitalize="words"
            />
            <Button
                label="Re-identify speakers"
                variant="secondary"
                fullWidth
                loading={busy}
                onPress={() => onReidentify(roster)}
                icon={<Icon name="Users" size={16} color={theme.colors.textPrimary} />}
            />
        </View>
    );
}
