/** The API keys Bee Flow already holds — presence only, never the secret. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Group, NoteRow, Text } from '@/shared/ui';

import { keyBadges } from '../model/keyBadges';
import type { UserSettings } from '../model/types';

export function CredentialsGroup({ settings }: { settings: UserSettings | null | undefined }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Group title="Credentials Bee Flow already holds">
            <NoteRow>
                <View style={styles.note}>
                    <Text variant="caption" tone="tertiary">
                        Some tools need an API key rather than a sign-in. Bee Flow stores
                        them encrypted and never returns them — only whether one exists.
                    </Text>
                    <View style={styles.badges}>
                        {keyBadges(settings).map((badge) => (
                            <Badge
                                key={badge.label}
                                label={badge.label}
                                tone={badge.present ? 'success' : 'neutral'}
                            />
                        ))}
                    </View>
                    <Text variant="caption" tone="tertiary">
                        Adding or replacing one of these keys is done in the web app — they
                        are long secrets that are pasted, not typed.
                    </Text>
                </View>
            </NoteRow>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        note: { gap: theme.spacing.sm },
        badges: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });
