/**
 * The details of one recording on the phone, asked BEFORE it is uploaded: the
 * roster is the one input that cannot be added late without a second run.
 * "Keep on this phone for now" leaves it in the outbox, untouched.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatBytes } from '@/shared/lib/bytes';
import { Button, Sheet } from '@/shared/ui';

import { CaptureSettingsForm } from './CaptureSettingsForm';
import type { CaptureSettings, PendingRecording } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ footer: { gap: theme.spacing.sm, paddingBottom: theme.spacing.sm } });

export function CaptureDetailsSheet({
    draft,
    fresh,
    onChange,
    onTranscribe,
    onClose,
}: {
    draft: PendingRecording | null;
    /** A recording that has just been made or imported, rather than one re-opened. */
    fresh: boolean;
    onChange: (patch: Partial<CaptureSettings>) => void;
    onTranscribe: () => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Sheet
            visible={Boolean(draft)}
            onClose={onClose}
            title={fresh ? t('mobile.recording.capture_before', 'Before we transcribe') : t('mobile.recording.capture_details', 'Recording details')}
            subtitle={draft ? `${draft.fileName} · ${formatBytes(draft.sizeBytes) || '—'}` : undefined}
            footer={
                draft ? (
                    <View style={styles.footer}>
                        <Button label={t('mobile.recording.capture_transcribe_now', 'Transcribe now')} fullWidth onPress={onTranscribe} />
                        <Button label={t('mobile.recording.capture_keep', 'Keep on this phone for now')} variant="ghost" fullWidth onPress={onClose} />
                    </View>
                ) : null
            }
        >
            {draft ? <CaptureSettingsForm value={draft.settings} onChange={onChange} /> : null}
        </Sheet>
    );
}
