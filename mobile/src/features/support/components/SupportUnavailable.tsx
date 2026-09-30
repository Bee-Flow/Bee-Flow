/** A server without the support module: say so, and who to ask instead. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Group, NoteRow, Text } from '@/shared/ui';

export function SupportUnavailable() {
    const styles = useThemedStyles(makeStyles);
    return (
        <Group title="Support requests">
            <NoteRow>
                <View style={styles.note}>
                    <Text variant="body">Not enabled on this server</Text>
                    <Text variant="caption" tone="tertiary">
                        The support module is not installed here, so requests cannot be
                        filed from inside the app. Your administrator is the right
                        person to ask — or the documentation above may already cover it.
                    </Text>
                </View>
            </NoteRow>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        note: { gap: theme.spacing.xs },
    });
