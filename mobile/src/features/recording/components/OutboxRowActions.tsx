/**
 * An outbox row's buttons: cancel while it uploads, otherwise upload (or try
 * again), details and delete.
 *
 * Delete is never one tap. It destroys the only copy of the audio, so it is
 * behind a confirm whose wording says exactly that — and whose cancel says
 * "Keep it", which is why this is still the system dialog.
 */

import React from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon } from '@/shared/ui';

import type { PendingRecording } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ row: { flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' } });

export function OutboxRowActions({
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
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const failed = item.status === 'failed';

    const confirmDiscard = () => {
        Alert.alert(
            t('mobile.recording.outbox_delete_title', 'Delete this recording?'),
            item.captureMode === 'recording'
                ? t(
                    'mobile.recording.outbox_delete_recorded',
                    'This is the only copy of the audio. It has not been uploaded, so deleting it cannot be undone.',
                )
                : t(
                    'mobile.recording.outbox_delete_imported',
                    'The imported audio will be removed from Bee Flow. The original file on your device is not touched.',
                ),
            [
                { text: t('mobile.recording.outbox_keep', 'Keep it'), style: 'cancel' },
                { text: t('common.delete', 'Delete'), style: 'destructive', onPress: onDiscard },
            ],
        );
    };

    if (item.status === 'uploading') {
        return (
            <View style={styles.row}>
                <Button label={t('mobile.recording.outbox_cancel_upload', 'Cancel upload')} variant="secondary" onPress={onCancel} />
            </View>
        );
    }

    return (
        <View style={styles.row}>
            <Button
                label={failed
                    ? `${t('mobile.error.retry', 'Try again')}${item.attempts > 1 ? ` (${item.attempts})` : ''}`
                    : t('mobile.recording.outbox_upload_now', 'Upload now')}
                onPress={onUpload}
                icon={
                    <Icon
                        name={failed ? 'RefreshCw' : 'CloudUpload'}
                        size={16}
                        color={theme.colors.accentPrimaryFg}
                    />
                }
            />
            <Button label={t('mobile.recording.outbox_details', 'Details')} variant="secondary" onPress={onEdit} />
            <Button label={t('common.delete', 'Delete')} variant="ghost" onPress={confirmDiscard} />
        </View>
    );
}
