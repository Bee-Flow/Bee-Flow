/**
 * "Collect answers in a table" — a yes/no on the trigger's form, saved the
 * way the questions are; the server makes (or keeps) the table on that save.
 * Stopping asks first: new answers stop landing, the table and its sharing
 * stay. A form that collects but has no table yet says so, with "Try again";
 * the last write that failed is named.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useProvisionAnswersTable } from '@/features/forms/hooks/mutations';
import type { QuestionsDraft } from '@/features/forms/hooks/useQuestionsDraft';
import { answersTablePath } from '@/features/forms/model/tableLink';
import type { FormDetail } from '@/features/forms/model/types';
import { Button, Card, ConfirmSheet, Section, Text, ToggleRow } from '@/shared/ui';

function Pending({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const retry = useProvisionAnswersTable(form.automationId);
    const said = form.answers?.lastWriteError?.message;
    return (
        <View style={styles.row} testID="form-collect-pending">
            <Text variant="caption" tone="warning" style={styles.grow}>
                {said || t('forms.settings.collect_pending', 'The table is not there yet — save the form once more, or try again.')}
            </Text>
            <Button size="sm" variant="ghost" label={t('forms.answers.retry', 'Try again')} loading={retry.isPending} onPress={() => retry.mutate()} />
        </View>
    );
}

/** Where the table stands: not made yet, its last failed write, a refused save, and the way to it. */
function TableState({ form, saveError }: { form: FormDetail; saveError: unknown }) {
    const t = useTranslation();
    const router = useRouter();
    const answers = form.answers;
    const tableId = answers?.datatableId ?? null;
    const failed = answers?.lastWriteError;
    const writeError = failed ? failed.message || failed.code || '' : '';
    return (
        <>
            {form.questions.collect && answers && !tableId ? <Pending form={form} /> : null}
            {writeError && tableId ? (
                <Text variant="caption" tone="error" testID="form-write-error">
                    {t('forms.settings.write_error', 'The last submission could not be written to the table: {message}', { message: writeError })}
                </Text>
            ) : null}
            {saveError ? (
                <Text variant="caption" tone="error">
                    {describeError(saveError).message}
                </Text>
            ) : null}
            {tableId ? <Button size="sm" variant="ghost" iconName="Table2" label={t('forms.share.open_table', 'Open the table')} onPress={() => router.push(answersTablePath(tableId))} testID="form-settings-open-table" /> : null}
        </>
    );
}

export function CollectCard({ form, questions }: { form: FormDetail; questions: QuestionsDraft }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [confirmStop, setConfirmStop] = useState(false);
    const [busy, setBusy] = useState(false);
    const collecting = form.questions.collect;
    const set = async (next: boolean) => {
        setBusy(true);
        try {
            await questions.patchSaved({ collect: next });
        } finally {
            setBusy(false);
        }
    };
    const description = collecting
        ? t('forms.settings.collect_on', 'On — every submission becomes a row in the answers table.')
        : t('forms.settings.collect_off_blurb', 'Switch on to create a table with one column per question. Earlier submissions are not imported; collecting starts with the next one.');
    return (
        <Section title={t('forms.settings.collect_title', 'Collect answers in a table')}>
            <Card>
                <View style={styles.body}>
                    <ToggleRow
                        label={t('forms.settings.collect_toggle', 'Collect answers in a table')}
                        description={description}
                        value={collecting}
                        onValueChange={(next) => (next ? void set(true) : setConfirmStop(true))}
                        disabled={busy || !questions.ready || questions.locked}
                        gutter={false}
                        testID="form-collect"
                    />
                    <TableState form={form} saveError={questions.saveError} />
                </View>
            </Card>
            <ConfirmSheet
                visible={confirmStop}
                title={t('forms.settings.stop_title', 'Stop collecting?')}
                message={t('forms.settings.stop_body', 'New submissions no longer land in the table. The table, its rows and its sharing stay as they are.')}
                confirmLabel={t('forms.settings.stop_confirm', 'Stop collecting')}
                onConfirm={() => {
                    setConfirmStop(false);
                    void set(false);
                }}
                onCancel={() => setConfirmStop(false)}
            />
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.sm } satisfies ViewStyle,
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    grow: { flex: 1 },
});
