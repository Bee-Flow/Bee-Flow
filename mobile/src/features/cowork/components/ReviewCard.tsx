/**
 * The question a run stopped at, on top of its detail screen: why it stopped,
 * what the agent asks, and the three ways the owner can handle it, as on the
 * web (CoworkReviewQueue): answer (the agent continues), "I did it myself",
 * "Not needed". The screen owns the write; this card only collects the answer.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Text, TextField } from '@/shared/ui';

import { actionLabel, canSubmit } from '../model/review';
import type { CoworkReview, ReviewAction } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { gap: theme.spacing.md },
        field: { gap: theme.spacing.xs },
        actions: { gap: theme.spacing.sm },
    });

function Line({ label, children }: { label: string; children: string | null }) {
    const styles = useThemedStyles(makeStyles);
    if (!children) return null;
    return (
        <View style={styles.field}>
            <Text variant="label" tone="tertiary">
                {label}
            </Text>
            <Text variant="body" selectable>
                {children}
            </Text>
        </View>
    );
}

export function ReviewCard({
    review,
    pending,
    onAct,
}: {
    review: CoworkReview;
    /** The action being sent, so its button spins and the others wait. */
    pending: ReviewAction | null;
    onAct: (action: ReviewAction, answer: string) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [answer, setAnswer] = useState('');
    const busy = pending !== null;
    const act = (action: ReviewAction) => onAct(action, answer.trim());
    return (
        <Card testID="cowork-review-card">
            <View style={styles.root}>
                <Text variant="heading" accessibilityRole="header">
                    {t('cowork_review.queue.heading', 'To review')}
                </Text>
                <Line label={t('cowork_review.queue.reason', 'Why it stopped')}>{review.reason}</Line>
                <Line label={t('cowork_review.queue.question', 'The agent asks')}>{review.question}</Line>
                <Line label={t('cowork_review.queue.summary', 'What it already did')}>{review.summary}</Line>
                <TextField
                    label={t('cowork_review.queue.answer_label', 'Your answer or instruction')}
                    placeholder={t(
                        'cowork_review.queue.answer_placeholder',
                        'For example: make the draft anyway, with the discount we agreed on the phone.',
                    )}
                    value={answer}
                    onChangeText={setAnswer}
                    multiline
                    editable={!busy}
                    testID="cowork-review-answer"
                />
                <View style={styles.actions}>
                    <Button
                        label={actionLabel('answer', t)}
                        onPress={() => act('answer')}
                        disabled={busy || !canSubmit('answer', answer)}
                        loading={pending === 'answer'}
                        testID="cowork-review-send"
                    />
                    <Button
                        label={actionLabel('done_myself', t)}
                        variant="secondary"
                        onPress={() => act('done_myself')}
                        disabled={busy}
                        loading={pending === 'done_myself'}
                        testID="cowork-review-done"
                    />
                    <Button
                        label={actionLabel('not_needed', t)}
                        variant="secondary"
                        onPress={() => act('not_needed')}
                        disabled={busy}
                        loading={pending === 'not_needed'}
                        testID="cowork-review-not-needed"
                    />
                </View>
            </View>
        </Card>
    );
}
