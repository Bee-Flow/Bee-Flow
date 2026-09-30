/**
 * The row under a finished answer (the web's MessageActionsRow): Copy, with
 * Copy as Markdown and Share behind "more"; the thumbs, which open a comment
 * form; Retry, and Retry with another model; and on the right, what went
 * wrong (in words) and when.
 *
 * `xl` gaps rather than `lg`: the actions carry a widened hit target, and at
 * a 16px gap two adjacent targets would overlap — on Android the wrong one
 * then wins the tap.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useState } from 'react';
import { Share, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import { answerText, plainTextOf } from '@/features/chat/model/answer';
import { errorKindOf } from '@/features/chat/model/errorKind';
import type { FeedbackRating } from '@/features/chat/model/feedback';
import type { ChatMessage } from '@/features/chat/model/types';
import { ActionMenu, Text, useToast } from '@/shared/ui';

import { FeedbackForm } from './FeedbackForm';
import { MessageAction } from './MessageAction';
import { RetryTierSheet } from './RetryTierSheet';
import { Thumbs } from './Thumbs';

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.xl, marginTop: theme.spacing.sm },
    end: { marginLeft: 'auto' as const },
});

function statusOf(message: ChatMessage): { i18nKey: string; en: string; tone: 'warning' | 'error' } | null {
    if (!message.error) return null;
    return errorKindOf(message.error).limit
        ? { i18nKey: 'chat.msg.usage_limit', en: 'Usage limit reached', tone: 'warning' }
        : { i18nKey: 'chat.msg.send_failed', en: 'Failed to send', tone: 'error' };
}

export function MessageActions({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const { feedback, onRetry, tiers } = useTranscriptActions();
    const [menu, setMenu] = useState<'copy' | 'retry' | null>(null);
    const [form, setForm] = useState<FeedbackRating | null>(null);
    const [thanked, setThanked] = useState(false);
    const text = answerText(message);
    const status = statusOf(message);
    const target = feedback ? { ...feedback, messageId: message.id } : null;

    const copy = (value: string) => {
        void Clipboard.setStringAsync(value);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        toast(t('mobile.chat.copied', 'Copied'));
    };
    const copyItems = [
        { id: 'copy', label: t('chat.copy', 'Copy'), icon: 'Copy' as const, onPress: () => copy(plainTextOf(text)) },
        { id: 'md', label: t('chat.copy_markdown', 'Copy as Markdown'), icon: 'FileText' as const, onPress: () => copy(text) },
        { id: 'share', label: t('mobile.chat.share_answer', 'Share answer'), icon: 'Share2' as const, onPress: () => void Share.share({ message: plainTextOf(text) }) },
    ];

    return (
        <View>
            <View style={styles.row}>
                {text ? <MessageAction icon="Copy" label={t('chat.copy', 'Copy')} onPress={() => copy(plainTextOf(text))} /> : null}
                {text ? <MessageAction icon="ChevronDown" label={t('chat.msg.more_export', 'More export options')} onPress={() => setMenu('copy')} /> : null}
                {target ? <Thumbs target={target} onRated={(rating) => { setThanked(false); setForm(rating); }} /> : null}
                {thanked ? (
                    <Text variant="label" tone="success">
                        {t('chat.msg.feedback_thanks', 'Thanks!')}
                    </Text>
                ) : null}
                {onRetry ? <MessageAction icon="RefreshCw" label={t('chat.msg.retry', 'Retry response')} onPress={() => onRetry(message)} /> : null}
                {onRetry && tiers ? (
                    <MessageAction icon="ChevronDown" label={t('chat.msg.retry_other_model', 'Retry with different model')} onPress={() => setMenu('retry')} />
                ) : null}
                {status ? (
                    <Text variant="label" tone={status.tone} style={styles.end}>
                        {t(status.i18nKey, status.en)}
                    </Text>
                ) : null}
            </View>
            {form && target ? (
                <FeedbackForm target={target} rating={form} onDone={(sent) => { setForm(null); setThanked(sent); }} />
            ) : null}
            <ActionMenu visible={menu === 'copy'} onClose={() => setMenu(null)} items={copyItems} />
            {onRetry && tiers ? (
                <RetryTierSheet visible={menu === 'retry'} tiers={tiers} onClose={() => setMenu(null)} onPick={(tier) => onRetry(message, tier)} />
            ) : null}
        </View>
    );
}
