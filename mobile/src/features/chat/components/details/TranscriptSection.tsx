/**
 * Share or export the transcript. Both reach for the OS, so they report
 * through the toast rather than the screen's error banner.
 */

import React from 'react';
import { Share } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { exportTranscript, transcriptMarkdown } from '@/features/chat/model/transcriptExport';
import type { Conversation } from '@/features/chat/model/types';
import { Button, Icon, Section, Text, useToast } from '@/shared/ui';

export function TranscriptSection({ conversation }: { conversation: Conversation }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const messages = conversation.messages ?? [];

    return (
        <Section
            title={t('mobile.chat.details.transcript', 'Transcript')}
            subtitle={
                messages.length === 1
                    ? t('mobile.chat.details.message_count_one', '1 message in this conversation.')
                    : t('mobile.chat.details.message_count', '{count} messages in this conversation.', { count: messages.length })
            }
        >
            <Button
                label={t('mobile.chat.details.share_transcript', 'Share transcript')}
                variant="secondary"
                icon={<Icon name="Share2" size={16} color={theme.colors.textPrimary} />}
                disabled={messages.length === 0}
                onPress={() => {
                    void Share.share({
                        title: conversation.title || t('mobile.chat.details.share_title', 'Bee Flow conversation'),
                        message: transcriptMarkdown(conversation.title, messages),
                    }).catch(() => toast(t('mobile.chat.details.share_cancelled', 'Sharing was cancelled')));
                }}
            />
            <Button
                label={t('mobile.chat.details.export_markdown', 'Export as Markdown')}
                variant="secondary"
                icon={<Icon name="Download" size={16} color={theme.colors.textPrimary} />}
                disabled={messages.length === 0}
                onPress={() => {
                    void exportTranscript(conversation.title, messages).catch((err) =>
                        toast(describeError(err).message, 'error'),
                    );
                }}
            />
            <Text variant="caption" tone="tertiary">
                {t(
                    'mobile.chat.details.export_note',
                    'The file is written to this phone’s cache and handed to the Android share sheet. Nothing is uploaded.',
                )}
            </Text>
        </Section>
    );
}
