/**
 * "How I got this answer" (the web's HowIGotThisAnswer.jsx): one line under a
 * finished answer with its tally — tools and their time, sources, the tier
 * Auto picked, what the shield replaced — that opens the details: the
 * privacy protection, the steps the server went through with their
 * durations, and the sources.
 *
 * The steps are this app's addition. The web keeps its phase trail for the
 * builder's trace panel; a phone has no side panel, and "why did that take
 * twelve seconds" is the question this sheet is for.
 */

import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { PrivacySheet } from '@/features/chat/components/privacy/PrivacySheet';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import { hasAnswerTrace } from '@/features/chat/model/answer';
import { traceSummary } from '@/features/chat/model/answerTrace';
import type { ChatMessage } from '@/features/chat/model/types';
import { Icon, Text } from '@/shared/ui';

import { AnswerTraceSheet } from './AnswerTraceSheet';

const makeStyles = (theme: Theme) => ({
    line: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        alignItems: 'center' as const,
        gap: theme.spacing[1.5],
        minHeight: 40,
        marginTop: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
    },
    pill: { paddingHorizontal: theme.spacing[1.5], paddingVertical: theme.spacing.xxs, borderRadius: theme.radii.pill, backgroundColor: theme.colors.bgTertiary },
    grow: { flexGrow: 1 },
});

export function AnswerTrace({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { showSources, tiers } = useTranscriptActions();
    const [open, setOpen] = useState<'trace' | 'privacy' | null>(null);
    if (message.streaming || !message.content || !hasAnswerTrace({ ...message, sources: showSources ? message.sources : undefined })) {
        return null;
    }

    const pills = traceSummary(message, { showSources: showSources === true, tiers, t });
    return (
        <>
            <Pressable onPress={() => setOpen('trace')} accessibilityRole="button" style={styles.line}>
                <Icon name="Brain" size={14} color={theme.colors.textSecondary} />
                <Text variant="caption" weight="medium">
                    {t('chat.msg.how_i_got_this', 'How I got this answer')}
                </Text>
                {pills.map((pill) => (
                    <View key={pill} style={styles.pill}>
                        <Text variant="label" tone="secondary">
                            {pill}
                        </Text>
                    </View>
                ))}
                <View style={styles.grow} />
                <Icon name="ChevronRight" size={12} color={theme.colors.textMuted} />
            </Pressable>
            <AnswerTraceSheet
                message={message}
                visible={open === 'trace'}
                onClose={() => setOpen(null)}
                onOpenPrivacy={() => setOpen('privacy')}
            />
            <PrivacySheet message={message} visible={open === 'privacy'} onClose={() => setOpen(null)} />
        </>
    );
}
