import React from 'react';
import { QuestionBreakdown } from './QuestionBreakdowns';
import DashCard from '@/components/shared/dashboard/DashCard';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AnswersQuestion } from './useAnswersSummary';

interface QuestionCardProps {
    t: TranslateFn;
    q: AnswersQuestion;
    onSeeAll?: ((q: AnswersQuestion) => void) | null;
}

/** One question: its label, answered/skipped, and the breakdown its type earns. */
export default function QuestionCard({ t, q, onSeeAll }: QuestionCardProps) {
    const meta = [
        t('forms.answers.q_answered', '{n} answered', { n: q.answered }),
        q.skipped ? t('forms.answers.q_skipped', '{n} skipped', { n: q.skipped }) : null,
    ].filter(Boolean).join(' · ');
    return (
        <DashCard title={q.label} meta={meta} testId={`question-${q.key}`}>
            <QuestionBreakdown t={t} q={q} onSeeAll={onSeeAll ? () => onSeeAll(q) : null} />
        </DashCard>
    );
}
