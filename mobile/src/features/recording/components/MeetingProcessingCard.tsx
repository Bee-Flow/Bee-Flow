/**
 * A note the server is still working on. The upload answered 202 minutes ago
 * and the pipeline runs in the background, so this gets a real explanation
 * (and the screen polls), not a spinner.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme, useThemedStyles } from '@/core/theme/ThemeProvider';
import { Card, Icon, Text } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';

export function MeetingProcessingCard() {
    const theme = useTheme();
    const styles = useThemedStyles(makeMeetingStyles);
    return (
        <View style={styles.statusFrame}>
            <Card>
                <View style={styles.stackSm}>
                    <View style={styles.titleRow}>
                        <Icon name="Loader" size={18} color={theme.colors.accentPrimary} />
                        <Text variant="subheading">Working on it</Text>
                    </View>
                    <Text variant="body" tone="secondary">
                        The audio is safely on the server. It is being transcribed, split by
                        speaker and summarised — a few minutes for a short meeting, longer for a
                        long one.
                    </Text>
                    <Text variant="caption" tone="tertiary">
                        You can leave this screen. The Meeting Notes tab shows when it is ready.
                    </Text>
                </View>
            </Card>
        </View>
    );
}
