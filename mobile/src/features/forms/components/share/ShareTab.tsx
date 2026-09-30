/**
 * Share — the link, WHO CAN FILL IT IN (people and groups of the organisation,
 * or the whole organisation; never outside it), and WHO SEES THE ANSWERS,
 * which is the answers table's own sharing: sharing the table is what shares
 * the dashboard. The table's sharing is set where the table lives — its own
 * screen, one tap away.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { answersTablePath } from '@/features/forms/model/tableLink';
import type { FormDetail } from '@/features/forms/model/types';
import { Button, Card, Section, Text } from '@/shared/ui';

import { AudienceCard } from './AudienceCard';
import { LinkCard } from './LinkCard';

function AnswersSharing({ form }: { form: FormDetail }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const tableId = form.answers?.datatableId ?? null;
    return (
        <Section title={t('forms.share.answers_title', 'Who can see the answers')}>
            <Card>
                <View style={styles.body}>
                    <Text variant="caption" tone="secondary">
                        {tableId
                            ? t('forms.share.answers_blurb', 'The answers live in a table. Sharing the table is what shares the dashboard: whoever can read the table can open Answers here and the Dashboard tab on the table.')
                            : t('forms.share.no_table', 'This form does not collect answers in a table. Switch it on under Settings to share a dashboard.')}
                    </Text>
                    {tableId ? (
                        <View style={styles.row}>
                            <Button size="sm" variant="secondary" iconName="Table2" label={t('forms.share.open_table', 'Open the table')} onPress={() => router.push(answersTablePath(tableId))} testID="form-open-table" />
                        </View>
                    ) : null}
                </View>
            </Card>
        </Section>
    );
}

export function ShareTab({ form }: { form: FormDetail }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView contentContainerStyle={styles.content} testID="form-share">
            <LinkCard form={form} />
            {form.mine ? <AudienceCard form={form} /> : null}
            <AnswersSharing form={form} />
        </ScrollView>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl } satisfies ViewStyle,
    body: { gap: theme.spacing.md } satisfies ViewStyle,
    row: { flexDirection: 'row' } satisfies ViewStyle,
});
