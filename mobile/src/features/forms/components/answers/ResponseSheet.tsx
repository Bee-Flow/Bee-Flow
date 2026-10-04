/**
 * One response, every question → answer, in the form's order (retired last,
 * flagged) — the web's ResponseDrawer. The row itself is read, because the
 * summary carries a preview only. The owner can go on to the run the
 * submission started.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useAnswerRow } from '@/features/forms/hooks/answers';
import { answerText, isAnswered } from '@/features/forms/model/answersView';
import type { AnswerQuestion } from '@/features/forms/model/answerTypes';
import { Button, ErrorState, LoadingState, Sheet, Text } from '@/shared/ui';


export interface OpenResponse {
    rowId: string;
    submittedAt: string | null;
    runId: string | null;
    by: string | null;
}

function Answers({ datatableId, rowId, questions }: { datatableId: string; rowId: string; questions: readonly AnswerQuestion[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const row = useAnswerRow(datatableId, rowId);
    if (row.isLoading) return <LoadingState />;
    if (row.isError || !row.data) return <ErrorState error={row.error} onRetry={() => void row.refetch()} />;
    const words = { yes: t('forms.answers.q_yes', 'Yes'), no: t('forms.answers.q_no', 'No') };
    return (
        <View style={styles.list} testID="response-answers">
            {questions.map((q) => {
                const value = row.data?.[q.key];
                return (
                    <View key={q.key} style={styles.answer}>
                        <Text variant="label" tone="tertiary">
                            {q.retired ? `${q.label} · ${t('forms.answers.retired_title', 'No longer on the form')}` : q.label}
                        </Text>
                        <Text variant="body" tone={isAnswered(value) ? 'primary' : 'tertiary'} selectable>
                            {isAnswered(value) ? answerText(value, q.columnType, words) : t('forms.answers.drawer_unanswered', 'Not answered')}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
}

export function ResponseSheet({
    datatableId,
    response,
    questions,
    runsOf,
    onClose,
}: {
    datatableId: string;
    response: OpenResponse | null;
    questions: readonly AnswerQuestion[];
    /** The automation whose runs the owner may open; null for a colleague. */
    runsOf: string | null;
    onClose: () => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const when = response?.submittedAt ? timeAgo(response.submittedAt, { suffix: true }) : '';
    const subtitle = [
        when ? t('forms.answers.drawer_submitted', 'Submitted {when}', { when }) : null,
        response?.by ? t('forms.answers.drawer_by', 'by {name}', { name: response.by }) : t('forms.answers.anonymous', 'Anonymous'),
    ]
        .filter(Boolean)
        .join(' · ');
    const runId = response?.runId ?? null;
    const footer =
        runsOf && runId ? (
            <Button
                variant="secondary"
                iconName="Workflow"
                label={t('forms.answers.drawer_open_run', 'Open the run')}
                onPress={() => {
                    onClose();
                    router.push(`/automations/${runsOf}/runs?runId=${encodeURIComponent(runId)}`);
                }}
                testID="drawer-open-run"
            />
        ) : undefined;
    return (
        <Sheet visible={response !== null} onClose={onClose} title={t('forms.answers.drawer_title', 'Response')} subtitle={subtitle} footer={footer} tall>
            {response ? <Answers datatableId={datatableId} rowId={response.rowId} questions={questions} /> : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.lg } satisfies ViewStyle,
    answer: { gap: theme.spacing.xxs } satisfies ViewStyle,
});
