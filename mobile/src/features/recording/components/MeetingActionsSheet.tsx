/**
 * The meeting's "more" menu. Rename, re-transcribe and delete are the owner's;
 * sharing and copying are anyone's who can read the note.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles } from '@/core/theme/ThemeProvider';
import { Divider, Icon, ListRow, Sheet, type IconName } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';
import type { Transcription } from '../model/types';

export interface MeetingActionsSheetProps {
    visible: boolean;
    meeting: Transcription;
    onClose: () => void;
    onRename: () => void;
    onShare: () => void;
    onCopy: () => void;
    onRetranscribe: () => void;
    onDelete: () => void;
}

export function MeetingActionsSheet({
    visible,
    meeting,
    onClose,
    onRename,
    onShare,
    onCopy,
    onRetranscribe,
    onDelete,
}: MeetingActionsSheetProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeMeetingStyles);
    const icon = (name: IconName, color = theme.colors.textSecondary) => (
        <Icon name={name} size={18} color={color} />
    );
    return (
        <Sheet visible={visible} onClose={onClose} title={meeting.title || t('mobile.recording.meeting', 'Meeting')} scroll={false}>
            <View style={styles.sheetList}>
                {meeting.isOwner ? <ListRow title={t('studio.header.rename', 'Rename')} leading={icon('Pen')} onPress={onRename} /> : null}
                <ListRow
                    title={t('mobile.recording.share_notes', 'Share notes')}
                    subtitle={t('mobile.recording.share_notes_hint', 'Markdown with the summary, action items and transcript')}
                    leading={icon('Share2')}
                    onPress={onShare}
                />
                <ListRow title={t('mobile.recording.copy_transcript', 'Copy transcript')} leading={icon('Copy')} onPress={onCopy} />
                {meeting.isOwner ? (
                    <>
                        <Divider />
                        <ListRow
                            title={t('mobile.recording.retranscribe', 'Re-transcribe from the audio')}
                            subtitle={t('mobile.recording.retranscribe_hint', 'Runs the whole pipeline again on the saved recording')}
                            leading={icon('RefreshCw')}
                            onPress={onRetranscribe}
                        />
                        <ListRow
                            title={t('mobile.recording.delete', 'Delete meeting')}
                            leading={icon('Trash2', theme.colors.error)}
                            onPress={onDelete}
                        />
                    </>
                ) : null}
            </View>
        </Sheet>
    );
}
