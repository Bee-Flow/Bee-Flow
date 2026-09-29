/**
 * One recording that is still only on this phone.
 *
 * The visual weight here is deliberate — a queued recording is drawn as
 * prominently as a finished note, with a warning-toned border while it is
 * failed. This row is the difference between "the upload failed and I lost the
 * meeting" and "the upload failed and I tapped Retry": if it looked like a
 * quiet secondary item, people would swipe past it and later wonder where
 * their meeting went.
 *
 * Delete is never one tap. It destroys the only copy of the audio, so it is
 * behind a confirm, and its wording says exactly that.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { formatBytes } from '../../../lib/bytes';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { ProgressBar } from '../../../ui/Feedback';
import { Card } from '../../../ui/Surface';
import { Text } from '../../../ui/Text';
import { formatDuration, formatWhen } from '../format';
import type { PendingRecording } from '../types';

export function OutboxRow({
    item,
    onUpload,
    onCancel,
    onEdit,
    onDiscard,
}: {
    item: PendingRecording;
    onUpload: () => void;
    onCancel: () => void;
    onEdit: () => void;
    onDiscard: () => void;
}) {
    const theme = useTheme();
    const uploading = item.status === 'uploading';
    const failed = item.status === 'failed';
    const percent = Math.round(item.progress * 100);

    const confirmDiscard = () => {
        Alert.alert(
            'Delete this recording?',
            item.captureMode === 'recording'
                ? 'This is the only copy of the audio. It has not been uploaded, so deleting it cannot be undone.'
                : 'The imported audio will be removed from Bee Flow. The original file on your device is not touched.',
            [
                { text: 'Keep it', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: onDiscard },
            ],
        );
    };

    return (
        <Card
            style={
                failed
                    ? { borderColor: theme.colors.warning, borderWidth: StyleSheet.hairlineWidth }
                    : undefined
            }
        >
            <View style={{ gap: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}>
                    <View
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: theme.radii.md,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.colors.bgTertiary,
                        }}
                    >
                        <Feather
                            name={item.captureMode === 'recording' ? 'mic' : 'file-plus'}
                            size={18}
                            color={failed ? theme.colors.warning : theme.colors.textSecondary}
                        />
                    </View>
                    <View style={{ flex: 1, gap: 4 }}>
                        <Text variant="subheading" numberOfLines={2}>
                            {item.settings.title || item.fileName}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                            {formatDuration(item.durationSeconds)} · {formatBytes(item.sizeBytes) || '—'} ·{' '}
                            {formatWhen(item.createdAt)}
                        </Text>
                    </View>
                    <Badge
                        label={uploading ? 'Uploading' : failed ? 'Not uploaded' : 'On this phone'}
                        tone={uploading ? 'accent' : failed ? 'warning' : 'neutral'}
                    />
                </View>

                {uploading ? (
                    <View style={{ gap: theme.spacing.xs }} accessibilityLiveRegion="polite">
                        <ProgressBar
                            fraction={item.progress}
                            label={`Uploading ${item.settings.title || item.fileName}`}
                        />
                        <Text variant="caption" tone="tertiary">
                            {percent < 100
                                ? `Uploading — ${percent}%`
                                : 'Uploaded. Waiting for the server to accept it…'}
                        </Text>
                    </View>
                ) : null}

                {failed && item.error ? (
                    <View
                        style={{
                            flexDirection: 'row',
                            gap: theme.spacing.sm,
                            padding: theme.spacing.md,
                            borderRadius: theme.radii.md,
                            backgroundColor: theme.colors.bgTertiary,
                        }}
                    >
                        <Feather
                            name="alert-triangle"
                            size={14}
                            color={theme.colors.warning}
                            style={{ marginTop: 2 }}
                        />
                        <View style={{ flex: 1, gap: 2 }}>
                            <Text variant="caption" tone="secondary">
                                {item.error}
                            </Text>
                            <Text variant="caption" tone="tertiary">
                                The audio is safe on this phone. Nothing is lost by trying again.
                            </Text>
                        </View>
                    </View>
                ) : null}

                <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                    {uploading ? (
                        <Button label="Cancel upload" variant="secondary" onPress={onCancel} />
                    ) : (
                        <>
                            <Button
                                label={failed ? `Try again${item.attempts > 1 ? ` (${item.attempts})` : ''}` : 'Upload now'}
                                onPress={onUpload}
                                icon={
                                    <Feather
                                        name={failed ? 'refresh-cw' : 'upload-cloud'}
                                        size={16}
                                        color={theme.colors.accentPrimaryFg}
                                    />
                                }
                            />
                            <Button label="Details" variant="secondary" onPress={onEdit} />
                            <Button label="Delete" variant="ghost" onPress={confirmDiscard} />
                        </>
                    )}
                </View>
            </View>
        </Card>
    );
}
