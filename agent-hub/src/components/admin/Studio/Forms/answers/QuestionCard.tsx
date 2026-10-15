import React from 'react';
import { breakdownFor } from './QuestionBreakdowns';
import DashCard from '../../../../shared/dashboard/DashCard';

/** One question: its label, answered/skipped, and the breakdown its type earns. */
export default function QuestionCard({ t, q, onSeeAll }) {
    const Breakdown = breakdownFor(q);
    const meta = [
        t('forms.answers.q_answered', '{n} answered', { n: q.answered }),
        q.skipped ? t('forms.answers.q_skipped', '{n} skipped', { n: q.skipped }) : null,
    ].filter(Boolean).join(' · ');
    return (
        <DashCard title={q.label} meta={meta} testId={`question-${q.key}`}>
            <Breakdown t={t} q={q} onSeeAll={onSeeAll ? () => onSeeAll(q) : null} />
        </DashCard>
    );
}
