/**
 * The details behind "How I got this answer": privacy protection (opening
 * its own sheet), the steps the server went through and how long each took,
 * and — where they may be shown — the sources with their passages.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import { hasPrivacyInfo } from '@/features/chat/model/answer';
import { traceSteps } from '@/features/chat/model/answerTrace';
import { privacyBadgeOf } from '@/features/chat/model/privacyPanel';
import type { ChatMessage } from '@/features/chat/model/types';
import { Icon, Sheet, Text } from '@/shared/ui';

import { TraceSources } from './TraceSources';

const makeStyles = (theme: Theme) => ({
    section: { marginBottom: theme.spacing.lg, gap: theme.spacing.xs },
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, minHeight: 44 },
    grow: { flex: 1 },
    step: { flexDirection: 'row' as const, gap: theme.spacing.sm, paddingVertical: theme.spacing.xxs },
});

export function AnswerTraceSheet({
    message,
    visible,
    onClose,
    onOpenPrivacy,
}: {
    message: ChatMessage;
    visible: boolean;
    onClose: () => void;
    onOpenPrivacy: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { showSources } = useTranscriptActions();
    const steps = traceSteps(message.phaseTrail, t);
    const badge = message.tokenisation ? privacyBadgeOf(message.tokenisation) : null;

    return (
        <Sheet visible={visible} onClose={onClose} title={t('chat.msg.how_i_got_this', 'How I got this answer')} tall>
            {hasPrivacyInfo(message) && badge ? (
                <Pressable onPress={onOpenPrivacy} accessibilityRole="button" style={[styles.row, styles.section]}>
                    <Icon name="Lock" size={14} color={theme.colors.textSecondary} />
                    <Text variant="body" weight="medium" style={styles.grow}>
                        {t('privacy.panel_title', 'Privacy protection')}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                        {t(badge.i18nKey, badge.en, { count: badge.count })}
                    </Text>
                    <Icon name="ChevronRight" size={14} color={theme.colors.textMuted} />
                </Pressable>
            ) : null}
            {steps.length ? (
                <View style={styles.section}>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.chat.trace_steps', 'Steps').toUpperCase()}
                    </Text>
                    {steps.map((step, index) => (
                        <View key={step.key} style={styles.step}>
                            <Text variant="caption" tone="tertiary">
                                {`${index + 1}.`}
                            </Text>
                            <Text variant="caption" style={styles.grow}>
                                {step.label}
                            </Text>
                            {step.duration ? (
                                <Text variant="caption" tone="tertiary">
                                    {step.duration}
                                </Text>
                            ) : null}
                        </View>
                    ))}
                </View>
            ) : null}
            {showSources && message.sources?.length ? <TraceSources sources={message.sources} /> : null}
        </Sheet>
    );
}
