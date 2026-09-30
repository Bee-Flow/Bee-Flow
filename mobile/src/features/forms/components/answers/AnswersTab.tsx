/**
 * Answers — the dashboard of the form's answers table, for the owner and for
 * any colleague the table is shared with. A form that does not collect into
 * a table says so; its owner can still read what came in as the routine's
 * run history.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { publicFormUrl } from '@/features/forms/api/endpoints';
import type { FormDetail } from '@/features/forms/model/types';
import { Button, Card, Text } from '@/shared/ui';

import { AnswersDashboard } from './AnswersDashboard';

function NoTable({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    return (
        <Card>
            <View style={styles.none} testID="form-answers-none">
                <Text variant="subheading" center>
                    {t('forms.answers.no_table_title', 'No answers table')}
                </Text>
                <Text variant="caption" tone="secondary" center>
                    {t('forms.answers.no_table_body', 'This form starts a routine and does not collect answers in a table.')}
                </Text>
                {form.mine ? (
                    <Button size="sm" variant="secondary" iconName="History" label={t('routine_editor.run_history', 'Run history')} onPress={() => router.push(`/automations/${form.automationId}/runs`)} />
                ) : null}
            </View>
        </Card>
    );
}

export function AnswersTab({ form }: { form: FormDetail }) {
    const styles = useThemedStyles(makeStyles);
    const datatableId = form.answers?.datatableId ?? null;
    return (
        <ScrollView contentContainerStyle={styles.content}>
            {datatableId ? (
                <AnswersDashboard datatableId={datatableId} runsOf={form.mine ? form.automationId : null} link={publicFormUrl(form)} />
            ) : (
                <NoTable form={form} />
            )}
        </ScrollView>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl } satisfies ViewStyle,
    none: { alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
});
