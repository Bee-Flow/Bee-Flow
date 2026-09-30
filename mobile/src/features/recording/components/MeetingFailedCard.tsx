/**
 * A note whose pipeline failed.
 *
 * The pipeline writes its reason into `summary` because the 202 was sent long
 * before it failed — that field is the ONLY channel it has, so the reason is
 * shown, and Try again re-runs from the saved audio when there is any. "Upload
 * it again" is always wrong for a room recording: those bytes never existed
 * anywhere else.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme, useThemedStyles } from '@/core/theme/ThemeProvider';
import { Button, Card, Icon, Text } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';
import type { Transcription } from '../model/types';

export function MeetingFailedCard({
    meeting,
    retrying,
    onRetry,
}: {
    meeting: Transcription;
    retrying: boolean;
    onRetry: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeMeetingStyles);
    const reason = meeting.summary?.replace(/^Transcription failed:\s*/i, '').trim();
    return (
        <View style={styles.statusFrame}>
            <Card>
                <View style={styles.stackMd}>
                    <View style={styles.titleRow}>
                        <Icon name="TriangleAlert" size={18} color={theme.colors.error} />
                        <Text variant="subheading">Transcription failed</Text>
                    </View>
                    {reason ? (
                        <Text variant="body" tone="secondary">
                            {reason}
                        </Text>
                    ) : null}
                    {meeting.audio.available ? (
                        <Text variant="caption" tone="tertiary">
                            The recording itself is still saved, so this can be run again.
                        </Text>
                    ) : (
                        <Text variant="caption" tone="warning">
                            {meeting.audio.capture === 'recording'
                                ? 'The audio is no longer available and there was never another copy.'
                                : 'The saved audio is no longer available. Import the original file again.'}
                        </Text>
                    )}
                    {meeting.isOwner && meeting.audio.available ? (
                        <Button label="Try again" loading={retrying} onPress={onRetry} fullWidth />
                    ) : null}
                </View>
            </Card>
        </View>
    );
}
