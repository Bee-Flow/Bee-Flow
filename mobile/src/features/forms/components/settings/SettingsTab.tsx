/**
 * Settings (the web's SettingsTab): live or not, collecting the answers in a
 * table or not, where the answers' retention lives, and the danger zone —
 * the automation goes, the answers table stays as an ordinary table.
 *
 * Going live IS arming the automation (activation validates the whole flow and
 * says what stops it). Collecting is a yes/no on the trigger's form, saved
 * like the questions are, and the table follows on that save.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { DeleteAutomationSheet } from '@/features/automations';
import { useSetFormLive } from '@/features/forms/hooks/mutations';
import type { QuestionsDraft } from '@/features/forms/hooks/useQuestionsDraft';
import { answersTablePath } from '@/features/forms/model/tableLink';
import type { FormDetail } from '@/features/forms/model/types';
import { Button, Card, Section, Text, ToggleRow } from '@/shared/ui';

import { CollectCard } from './CollectCard';

function LiveCard({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const [error, setError] = useState<string | null>(null);
    const live = useSetFormLive(form.automationId, {
        onSuccess: () => setError(null),
        onError: (err) => setError(describeError(err).message || t('forms.settings.live_failed', 'Could not switch the form on.')),
    });
    return (
        <Section title={t('forms.settings.live_title', 'Live')}>
            <Card>
                <ToggleRow
                    label={t('forms.settings.live_toggle', 'Form is live')}
                    description={
                        form.isActive
                            ? t('forms.status.live_hint', 'Colleagues in your organisation can fill this in after signing in.')
                            : t('forms.settings.live_off_blurb', 'Switched off: the link answers “not available” and nothing is collected.')
                    }
                    value={form.isActive}
                    onValueChange={(next) => live.mutate(next)}
                    disabled={live.isPending}
                    gutter={false}
                    testID="form-live"
                />
                {error ? (
                    <Text variant="caption" tone="error">
                        {error}
                    </Text>
                ) : null}
            </Card>
        </Section>
    );
}

function DangerZone({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const [deleting, setDeleting] = useState(false);
    return (
        <Section title={t('mobile.forms.danger_zone', 'Danger zone')}>
            <Card>
                <View style={styles.body}>
                    <Text variant="caption" tone="secondary">
                        {t(
                            'forms.settings.delete_notice',
                            'Deleting the form deletes the automation behind it. The answers table is not deleted — remove it under Datatables if the answers are no longer needed.',
                        )}
                    </Text>
                    <Button variant="danger" iconName="Trash2" label={t('forms.settings.delete_open', 'Delete this form')} onPress={() => setDeleting(true)} testID="form-delete" />
                </View>
            </Card>
            <DeleteAutomationSheet
                automation={deleting ? { id: form.automationId, title: form.title } : null}
                requireName
                onClose={() => setDeleting(false)}
                onDeleted={() => router.back()}
            />
        </Section>
    );
}

/** The window itself is set on the table's own Retention tab, which the answers share. */
function Retention({ datatableId }: { datatableId: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    return (
        <Section title={t('forms.settings.retention_title', 'How long answers are kept')}>
            <Card>
                <View style={styles.body}>
                    <Text variant="caption" tone="secondary">
                        {t('forms.settings.retention_blurb', 'Answers stay in the table until a retention window is set on it.')}
                    </Text>
                    <Button
                        size="sm"
                        variant="ghost"
                        iconName="Timer"
                        label={t('forms.settings.retention_open', 'Open the table’s retention settings')}
                        onPress={() => router.push(answersTablePath(datatableId, 'retention'))}
                        testID="form-retention-open"
                    />
                </View>
            </Card>
        </Section>
    );
}

export function SettingsTab({ form, questions }: { form: FormDetail; questions: QuestionsDraft }) {
    const styles = useThemedStyles(makeStyles);
    const datatableId = form.answers?.datatableId ?? null;
    return (
        <ScrollView contentContainerStyle={styles.content} testID="form-settings">
            <LiveCard form={form} />
            <CollectCard form={form} questions={questions} />
            {datatableId ? <Retention datatableId={datatableId} /> : null}
            <DangerZone form={form} />
        </ScrollView>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl } satisfies ViewStyle,
    body: { gap: theme.spacing.md } satisfies ViewStyle,
});
