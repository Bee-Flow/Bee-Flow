/**
 * The follow-up to a thumb (the web's feedback form under an answer): an
 * optional comment and, only when ticked, the conversation — so the person
 * rating decides whether their chat goes to the workspace's reviewers.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { sendFeedbackDetail } from '@/features/chat/hooks/ratings';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import type { FeedbackRating, FeedbackTarget } from '@/features/chat/model/feedback';
import { Button, CheckRow, TextField, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    box: {
        marginTop: theme.spacing.sm,
        padding: theme.spacing.md,
        gap: theme.spacing.sm,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgTertiary,
    },
    actions: { flexDirection: 'row' as const, gap: theme.spacing.sm },
});

export function FeedbackForm({
    target,
    rating,
    onDone,
}: {
    target: FeedbackTarget;
    rating: FeedbackRating;
    /** `sent`: the comment went; false: skipped. */
    onDone: (sent: boolean) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const { conversation } = useTranscriptActions();
    const [comment, setComment] = useState('');
    const [include, setInclude] = useState(false);

    const submit = () => {
        onDone(true);
        sendFeedbackDetail(target, rating, { comment, conversation: include && conversation ? conversation() : undefined }).catch(
            () => toast(t('mobile.chat.feedback_failed', 'Could not send that just now')),
        );
    };

    return (
        <View style={styles.box}>
            <TextField
                value={comment}
                onChangeText={setComment}
                multiline
                maxLines={4}
                placeholder={t('chat.msg.feedback_placeholder', 'Any additional feedback? (optional)')}
            />
            {conversation ? (
                <CheckRow
                    checked={include}
                    onToggle={() => setInclude((v) => !v)}
                    label={`${t('chat.msg.feedback_include', 'Include conversation')} ${t('chat.msg.feedback_include_hint', '— helps us reproduce the issue')}`}
                />
            ) : null}
            <View style={styles.actions}>
                <Button label={t('chat.msg.feedback_submit', 'Submit')} size="sm" onPress={submit} />
                <Button label={t('chat.msg.feedback_skip', 'Skip')} size="sm" variant="ghost" onPress={() => onDone(false)} />
            </View>
        </View>
    );
}
