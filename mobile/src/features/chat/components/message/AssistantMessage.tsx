/**
 * The assistant's answer, in the web's order (MessageItem): the reasoning,
 * what it did (tools), anything it wanted to do and was held from, the drafts
 * and maps it prepared, the answer itself, what it made (images, audio,
 * video, files), where the answer came from, how it got there, and the
 * actions under it.
 *
 * Full width with no background: the answer is the content of the screen.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AnswerCards } from '@/features/chat/components/cards/AnswerCards';
import { ToolConfirmCard } from '@/features/chat/components/cards/ToolConfirmCard';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import { answerText } from '@/features/chat/model/answer';
import type { ChatMessage } from '@/features/chat/model/types';
import { Text, useToast } from '@/shared/ui';

import { ActivityCard } from './ActivityCard';
import { AnswerBody } from './AnswerBody';
import { AnswerChips } from './AnswerChips';
import { AnswerTrace } from './AnswerTrace';
import { MessageActions } from './MessageActions';
import { ThinkingPanel } from './ThinkingPanel';

const makeStyles = (theme: Theme) => ({
    answer: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm },
    stopped: { marginTop: theme.spacing.sm },
});

export function AssistantMessage({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const { onRetry, onToolDecision, toolDecisions } = useTranscriptActions();

    const copy = () => {
        void Clipboard.setStringAsync(answerText(message));
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        toast(t('mobile.chat.copied', 'Copied'));
    };

    return (
        <View style={styles.answer}>
            <ThinkingPanel message={message} />
            <ActivityCard message={message} />
            {message.pendingToolCalls?.length ? (
                <ToolConfirmCard calls={message.pendingToolCalls} onDecide={onToolDecision} decided={toolDecisions} />
            ) : null}
            <AnswerBody message={message} onRetry={onRetry ? () => onRetry(message) : undefined} onLongPress={copy} />
            <AnswerCards message={message} />
            {message.interrupted ? (
                <Text variant="label" tone="warning" style={styles.stopped}>
                    {t('mobile.chat.stopped_early', 'Answer stopped early')}
                </Text>
            ) : null}
            <AnswerChips message={message} />
            <AnswerTrace message={message} />
            {message.streaming ? null : <MessageActions message={message} />}
        </View>
    );
}
