/**
 * What the meeting produced and how much of it someone can pick up: open
 * and unowned action items, deadlines, the work per person, decisions and
 * the questions nobody answered — agent-hub's insights/FollowUpTab.jsx.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { formatDuration } from '@/features/recording/model/format';
import type { InsightsModel } from '@/features/recording/model/insights/model';

import { Block, EmptyNote, MetricRow, TabBody, TabHeading } from './primitives';

export function FollowUpTab({ model, onSeek }: { model: InsightsModel; onSeek?: (seconds: number) => void }) {
    const t = useTranslation();
    const f = model.followUp;
    if (!f.total && !f.decisions && !f.openQuestions.length) {
        return (
            <EmptyNote>
                {t('meeting_notes.insights_followup_empty', 'No action items, decisions or open questions were detected for this meeting.')}
            </EmptyNote>
        );
    }
    const jump = t('meeting_notes.insights_jump', 'Jump to this moment');
    return (
        <TabBody>
            {f.total > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_actions', 'Action items')}</TabHeading>
                    <MetricRow label={t('meeting_notes.insights_actions_open', 'Open')} value={`${f.open} / ${f.total}`} />
                    <MetricRow
                        label={t('meeting_notes.insights_actions_unassigned', 'Without an owner')}
                        value={f.unassigned}
                        flagged={f.unassigned > 0}
                    />
                    <MetricRow
                        label={t('meeting_notes.insights_actions_with_due', 'With a deadline')}
                        value={`${f.withDue} / ${f.total}`}
                    />
                    {f.overdue > 0 ? (
                        <MetricRow label={t('meeting_notes.insights_actions_overdue', 'Past their deadline')} value={f.overdue} flagged />
                    ) : null}
                </Block>
            ) : null}
            {f.byAssignee && f.byAssignee.length > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_workload', 'Per person')}</TabHeading>
                    {f.byAssignee.map((row) => (
                        <MetricRow
                            key={row.assignee}
                            label={row.assignee}
                            detail={row.overdue > 0 ? t('meeting_notes.insights_n_overdue', '{n} overdue').replace('{n}', String(row.overdue)) : undefined}
                            value={`${row.open} / ${row.total}`}
                            flagged={row.overdue > 0}
                        />
                    ))}
                </Block>
            ) : null}
            {f.decisions > 0 ? (
                <MetricRow
                    label={t('meeting_notes.insights_decisions_made', 'Decisions made')}
                    detail={t('meeting_notes.insights_per_hour', '{n}/hour').replace('{n}', f.decisionsPerHour.toFixed(1))}
                    value={f.decisions}
                />
            ) : null}
            {f.openQuestions.length > 0 ? (
                <Block>
                    <TabHeading>{t('meeting_notes.insights_open_questions', 'Left unanswered')}</TabHeading>
                    {f.openQuestions.map((q, i) => (
                        <MetricRow
                            key={q.id ?? `q-${i}`}
                            label={q.text}
                            value={q.seconds !== null ? formatDuration(q.seconds) : '—'}
                            flagged={q.seconds !== null}
                            onPress={q.seconds !== null && onSeek ? () => onSeek(q.seconds as number) : undefined}
                            hint={jump}
                        />
                    ))}
                </Block>
            ) : null}
        </TabBody>
    );
}
