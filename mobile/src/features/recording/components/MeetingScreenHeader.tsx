/**
 * The meeting screen's header: title, when and how long, and the two actions.
 * Rendered in every state, so the back button is there while the note loads.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, ScreenHeader } from '@/shared/ui';

import { formatDuration, formatWhen } from '../model/format';
import type { Transcription } from '../model/types';

export function MeetingScreenHeader({
    meeting,
    onAsk,
    onMore,
}: {
    meeting: Transcription | null;
    onAsk: () => void;
    onMore: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const subtitle = meeting
        ? [formatWhen(meeting.createdAt), formatDuration(meeting.durationSeconds)].filter(Boolean).join(' · ')
        : undefined;
    return (
        <ScreenHeader
            title={meeting?.title || t('mobile.recording.meeting', 'Meeting')}
            subtitle={subtitle}
            actions={
                <>
                    {meeting?.status === 'completed' ? (
                        <IconButton
                            icon={<Icon name="MessageCircle" size={20} color={theme.colors.textSecondary} />}
                            accessibilityLabel={t('mobile.recording.ask', 'Ask about this meeting')}
                            onPress={onAsk}
                        />
                    ) : null}
                    <IconButton
                        icon={<Icon name="EllipsisVertical" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.recording.more_actions', 'More actions')}
                        onPress={onMore}
                        disabled={!meeting}
                    />
                </>
            }
        />
    );
}
