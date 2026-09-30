/**
 * One question of the dashboard: its label, answered and skipped, and the
 * breakdown its type earns (the web's QuestionCard + QuestionBreakdowns) —
 * bars for choices and yes/no, four figures for numbers, answers per month
 * for dates, a count for files and the latest answers for text. A sentence
 * is not a bar.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { choiceScale, monthLabel, numberCell } from '@/features/forms/model/answersView';
import type { AnswerQuestion, Breakdown } from '@/features/forms/model/answerTypes';
import { BarChart, Button, Card, Meter, Stat, Text } from '@/shared/ui';


/** A choice question shows this many bars, then "{n} more". */
const SHOWN_CHOICES = 8;

type Kind<K extends Breakdown['kind']> = Extract<Breakdown, { kind: K }>;

function NoAnswers({ t }: { t: TranslateFn }) {
    return (
        <Text variant="caption" tone="tertiary">
            {t('forms.answers.q_none', 'No answers in this period.')}
        </Text>
    );
}

function Choices({ t, b }: { t: TranslateFn; b: Kind<'choice'> }) {
    if (!b.values.length) return <NoAnswers t={t} />;
    const scale = choiceScale(b.values);
    const rest = b.values.length - SHOWN_CHOICES;
    return (
        <>
            {b.values.slice(0, SHOWN_CHOICES).map((v) => (
                <Meter key={v.value} label={v.value} valueLabel={`${v.n} · ${v.pct}%`} fraction={v.n / scale} />
            ))}
            {rest > 0 ? (
                <Text variant="caption" tone="tertiary">
                    {t('forms.answers.q_more', '{n} more', { n: rest })}
                </Text>
            ) : null}
        </>
    );
}

function YesNo({ t, b }: { t: TranslateFn; b: Kind<'yesno'> }) {
    const total = b.yes + b.no;
    if (!total) return <NoAnswers t={t} />;
    return (
        <>
            <Meter label={t('forms.answers.q_yes', 'Yes')} valueLabel={String(b.yes)} fraction={b.yes / total} />
            <Meter label={t('forms.answers.q_no', 'No')} valueLabel={String(b.no)} fraction={b.no / total} />
        </>
    );
}

function Numbers({ t, b }: { t: TranslateFn; b: Kind<'number'> }) {
    const styles = useThemedStyles(makeStyles);
    if (b.avg === null) return <NoAnswers t={t} />;
    return (
        <View style={styles.grid}>
            <Stat label={t('forms.answers.q_avg', 'Average')} value={numberCell(b.avg)} />
            <Stat label={t('forms.answers.q_median', 'Median')} value={numberCell(b.p50)} />
            <Stat label={t('forms.answers.q_min', 'Lowest')} value={numberCell(b.min)} />
            <Stat label={t('forms.answers.q_max', 'Highest')} value={numberCell(b.max)} />
        </View>
    );
}

function TextAnswers({ t, b, onSeeAll }: { t: TranslateFn; b: Kind<'text'>; onSeeAll: () => void }) {
    const recent = b.recent.slice(0, 5);
    if (!recent.length) return <NoAnswers t={t} />;
    return (
        <>
            {recent.map((r) => (
                <Text key={r.rowId} variant="body" tone="secondary">
                    “{r.value}”{r.at ? `  ·  ${timeAgo(r.at)}` : ''}
                </Text>
            ))}
            <Button size="sm" variant="ghost" label={t('forms.answers.q_see_all', 'See all answers')} onPress={onSeeAll} />
        </>
    );
}

function Files({ t, b, onSeeAll }: { t: TranslateFn; b: Kind<'file'>; onSeeAll: () => void }) {
    return (
        <>
            <Text variant="body">
                {b.count === 1
                    ? t('forms.answers.q_files', '{count} file', { count: b.count })
                    : t('forms.answers.q_files_plural', '{count} files', { count: b.count })}
            </Text>
            {b.count > 0 ? <Button size="sm" variant="ghost" label={t('forms.answers.q_files_open', 'Open the rows')} onPress={onSeeAll} /> : null}
        </>
    );
}

function Body({ t, q, onSeeAll }: { t: TranslateFn; q: AnswerQuestion; onSeeAll: () => void }) {
    const b = q.breakdown;
    switch (b?.kind) {
        case 'choice':
            return <Choices t={t} b={b} />;
        case 'yesno':
            return <YesNo t={t} b={b} />;
        case 'number':
            return <Numbers t={t} b={b} />;
        case 'date':
            return b.buckets.length ? <BarChart columns={b.buckets.map((x) => ({ label: monthLabel(x.bucket), value: x.n }))} height={120} /> : <NoAnswers t={t} />;
        case 'file':
            return <Files t={t} b={b} onSeeAll={onSeeAll} />;
        case 'text':
            return <TextAnswers t={t} b={b} onSeeAll={onSeeAll} />;
        default:
            return <NoAnswers t={t} />;
    }
}

export function QuestionBreakdown({ q, onSeeAll }: { q: AnswerQuestion; onSeeAll: (q: AnswerQuestion) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const meta = [t('forms.answers.q_answered', '{n} answered', { n: q.answered }), q.skipped ? t('forms.answers.q_skipped', '{n} skipped', { n: q.skipped }) : null]
        .filter(Boolean)
        .join(' · ');
    return (
        <Card>
            <View style={styles.body} testID={`question-${q.key}`}>
                <Text variant="subheading">{q.label}</Text>
                <Text variant="caption" tone="tertiary">
                    {meta}
                </Text>
                <Body t={t} q={q} onSeeAll={() => onSeeAll(q)} />
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.sm } satisfies ViewStyle,
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md } satisfies ViewStyle,
});
