/**
 * The answers dashboard (the web's AnswersDashboard): a period, four numbers,
 * responses over time, one card per question, the recent responses — each
 * opening its response — and every response, with the CSV export. Refreshed
 * every 30 seconds while it is on screen.
 */

import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useAnswersSummary, useExportAnswers } from '@/features/forms/hooks/answers';
import { defaultRange } from '@/features/forms/model/answersRange';
import { bucketLabel, completionPercent, isMultiPage, splitQuestions } from '@/features/forms/model/answersView';
import type { AnswerQuestion, AnswersSummary } from '@/features/forms/model/answerTypes';
import { answersTablePath } from '@/features/forms/model/tableLink';
import { BarChart, Button, Card, EmptyState, ErrorState, ListSkeleton, Section, Stat, useToast } from '@/shared/ui';

import { AllResponsesSheet } from './AllResponsesSheet';
import { QuestionBreakdown } from './QuestionBreakdown';
import { RangeBar } from './RangeBar';
import { RecentResponses } from './RecentResponses';
import { ResponseSheet, type OpenResponse } from './ResponseSheet';

function Kpis({ summary }: { summary: AnswersSummary }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { totals } = summary;
    const last = totals.lastAt ? timeAgo(totals.lastAt, { suffix: true }) : t('forms.answers.kpi_never', 'None yet');
    return (
        <Card>
            <View style={styles.grid} testID="answers-kpis">
                <Stat label={t('forms.answers.kpi_in_range', 'Responses in this period')} value={String(totals.inRange)} />
                <Stat label={t('forms.answers.kpi_all', 'All time')} value={String(totals.all)} />
            </View>
            <View style={styles.grid}>
                <Stat label={t('forms.answers.kpi_today', 'Today')} value={String(totals.today)} />
                {isMultiPage(summary) ? (
                    <Stat label={t('forms.answers.kpi_completion', 'Completed all pages')} value={completionPercent(totals) ?? '—'} caption={`${totals.completed} / ${totals.inRange}`} />
                ) : (
                    <Stat label={t('forms.answers.kpi_last', 'Last response')} value={last} />
                )}
            </View>
        </Card>
    );
}

function Timeline({ summary }: { summary: AnswersSummary }) {
    const t = useTranslation();
    const per = { day: t('forms.answers.timeline_day', 'per day'), week: t('forms.answers.timeline_week', 'per week'), month: t('forms.answers.timeline_month', 'per month') }[summary.range.bucket];
    return (
        <Section title={t('forms.answers.timeline_title', 'Responses over time')} subtitle={per}>
            <Card>
                <BarChart columns={summary.timeline.map((b) => ({ label: bucketLabel(b.bucket, summary.range.bucket), value: b.n }))} />
            </Card>
        </Section>
    );
}

function Questions({ summary, onSeeAll }: { summary: AnswersSummary; onSeeAll: (q: AnswerQuestion) => void }) {
    const t = useTranslation();
    const [showRetired, setShowRetired] = useState(false);
    const { live, retired } = splitQuestions(summary.questions);
    return (
        <>
            {live.map((q) => (
                <QuestionBreakdown key={q.fieldId || q.key} q={q} onSeeAll={onSeeAll} />
            ))}
            {retired.length ? (
                <Section title={`${t('forms.answers.retired_title', 'No longer on the form')} (${retired.length})`} subtitle={t('forms.answers.retired_hint', 'Questions removed from the form. Their answers are still in the table.')}>
                    <Button size="sm" variant="ghost" iconName={showRetired ? 'ChevronUp' : 'ChevronDown'} label={showRetired ? t('mobile.forms.hide', 'Hide') : t('mobile.forms.show', 'Show')} onPress={() => setShowRetired((v) => !v)} />
                    {showRetired ? retired.map((q) => <QuestionBreakdown key={q.fieldId || q.key} q={q} onSeeAll={onSeeAll} />) : null}
                </Section>
            ) : null}
        </>
    );
}

export interface AnswersDashboardProps {
    datatableId: string;
    /** The routine whose runs the owner may open; null for a colleague. */
    runsOf: string | null;
    /** The form's address, for "Copy the link" when nothing has come in yet. */
    link: string | null;
}

export function AnswersDashboard({ datatableId, runsOf, link }: AnswersDashboardProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const router = useRouter();
    const [range, setRange] = useState(defaultRange);
    const [open, setOpen] = useState<OpenResponse | null>(null);
    const [all, setAll] = useState<{ focus: AnswerQuestion | null } | null>(null);
    const summary = useAnswersSummary(datatableId, range);
    const exporter = useExportAnswers(datatableId, { onError: (err) => toast(describeError(err).message || t('forms.answers.export_failed', 'Could not export the responses.'), 'error') });
    const data = summary.data;
    if (summary.isLoading && !data) return <ListSkeleton rows={4} />;
    if (!data) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
    const updated = summary.dataUpdatedAt ? t('forms.answers.updated', 'Updated {when}', { when: timeAgo(new Date(summary.dataUpdatedAt).toISOString(), { suffix: true }) }) : null;
    const copyLink = link
        ? () => void Clipboard.setStringAsync(link).then(() => toast(t('forms.studio.copied', 'Link copied'), 'success'))
        : undefined;
    return (
        <View style={styles.column} testID="form-answers">
            <RangeBar range={range} onChange={setRange} updated={updated} />
            {data.totals.all === 0 ? (
                <EmptyState
                    illustration="empty-inbox"
                    title={t('forms.answers.empty_title', 'No responses yet')}
                    message={t('forms.answers.empty_body', 'Share the link — the first answer shows up here the moment it is submitted.')}
                    actionLabel={copyLink ? t('forms.answers.empty_cta', 'Copy the link') : undefined}
                    onAction={copyLink}
                />
            ) : (
                <>
                    <Kpis summary={data} />
                    <Timeline summary={data} />
                    <Questions summary={data} onSeeAll={(q) => setAll({ focus: q })} />
                    <Section title={t('forms.answers.recent_title', 'Recent responses')}>
                        <RecentResponses recent={data.recent} onOpen={setOpen} />
                    </Section>
                </>
            )}
            <Section title={t('forms.answers.all_title', 'All responses')}>
                <View style={styles.actions}>
                    <Button size="sm" variant="secondary" iconName="ListChecks" label={t('forms.answers.all_title', 'All responses')} onPress={() => setAll({ focus: null })} testID="answers-all" />
                    <Button size="sm" variant="secondary" iconName="Download" label={t('forms.answers.all_export', 'Export (CSV)')} loading={exporter.isPending} onPress={() => exporter.mutate(data.table.name)} testID="answers-export" />
                    <Button size="sm" variant="ghost" iconName="Table2" label={t('forms.answers.all_open_table', 'Open the table')} onPress={() => router.push(answersTablePath(datatableId))} testID="answers-open-table" />
                </View>
            </Section>
            <AllResponsesSheet
                datatableId={datatableId}
                visible={all !== null}
                focus={all?.focus ?? null}
                questions={data.questions}
                onClearFocus={() => setAll({ focus: null })}
                onClose={() => setAll(null)}
                onOpen={(r) => {
                    setAll(null);
                    setOpen(r);
                }}
            />
            <ResponseSheet datatableId={datatableId} response={open} questions={data.questions} runsOf={runsOf} onClose={() => setOpen(null)} />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    column: { gap: theme.spacing.xl } satisfies ViewStyle,
    grid: { flexDirection: 'row', gap: theme.spacing.md } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
});
