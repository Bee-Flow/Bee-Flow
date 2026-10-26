import { ANNEX_III_CATEGORIES, ANNEX_III_ARTICLES, ANNEX_III_FROM, type DomainAnswers } from '../ladderOutcome';
import { type TranslateParams } from '@/hooks/useTranslation';
import { TONES } from '@/components/shared/statusTone';
import { formatCalDate } from '../../shared/calendarMath';
import type { AnnexQuestionsProps } from '../AiActLadderModal.types';
import { tint, Step } from './LadderModalViewStep2';

export function LadderModalViewStep({ verdict, t, locale, annexAnswered, legacyYes, annexOrder, annexAnswers, annexHints, answerAnnex, annexArticles }: { verdict: { applies: boolean; articles: string[]; prohibited: boolean; highRisk: boolean; step1: { answered: boolean; ok: boolean; }; step2: { ok: boolean; failures: ("disclosure" | "marking")[]; checks: number; passed: number; }; step3: { answered: boolean; ok: boolean; }; outcomeCode: string; }; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; locale: string; annexAnswered: number; legacyYes: boolean; annexOrder: { id: string; key: string; en: string; }[]; annexAnswers: DomainAnswers; annexHints: Set<string>; answerAnnex: (id: string, value: string) => void; annexArticles: string[]; }) {
    return <Step
        n={3}
        state={verdict.step3.ok ? 'done' : 'open'}
        title={t('compliance.ladder_step3_title', 'Annex III — high-risk?')}
        meta={t('compliance.ladder_step3_meta', 'from {date} — but what you build now falls under it then', { date: formatCalDate(ANNEX_III_FROM, { locale }) })}
        verdict={verdict.step3.answered
            ? (verdict.step3.ok ? t('compliance.ladder_no', 'No') : t('compliance.ladder_yes', 'Yes'))
            // An unanswered step says how far along it is rather
            // than nothing: "4 of 10" is the difference between
            // "not high risk" and "not asked yet", and conflating
            // those two is the bug this step was rebuilt for.
            : t('compliance.ladder_annex_progress', '{answered} of {total} answered', {
                answered: annexAnswered, total: ANNEX_III_CATEGORIES.length,
            })}
        testId="ladder-step-3"
    >
        {legacyYes && (
            <p data-testid="ladder-legacy-yes-note" className="text-[11px] mb-2 font-medium text-[var(--warning-ink)]">
                {t('compliance.ladder_legacy_yes_note', 'Declared high-risk earlier — pick the area(s) to confirm')}
            </p>
        )}
        <AnnexQuestions
            questions={annexOrder}
            answers={annexAnswers}
            hints={annexHints}
            onAnswer={answerAnnex}
            t={t} />
        {annexArticles.length > 0 && (
            <p data-testid="ladder-annex-articles" className="text-[11px] mt-2 font-medium" style={{ color: TONES.error.ink }}>
                {t('compliance.ladder_annex_high_risk_points', 'High risk under {points}.', { points: annexArticles.join(', ') })}
            </p>
        )}
        <p className="text-[11px] text-[var(--text-tertiary)] mt-2">
            {t('compliance.ladder_step3_note', 'If this does become high-risk later: risk management, technical documentation and human oversight are 12–18 months of work, not a quarter.')}
        </p>
    </Step>;
}

function AnnexQuestions({ questions, answers, hints, onAnswer, t }: AnnexQuestionsProps) {
    return (
        <div className="flex flex-col gap-1" role="group">
            {questions.map((q) => {
                const value = answers[q.id] === 'yes' || answers[q.id] === 'no' ? answers[q.id] : null;
                return (
                    <div
                        key={q.id}
                        data-testid="ladder-annex-question"
                        data-domain={q.id}
                        data-answer={value || 'open'}
                        className="flex items-center justify-between gap-3 py-1"
                    >
                        <div className="min-w-0">
                            <div className="text-[12px] text-[var(--text-secondary)]">{t(q.key, q.en)}</div>
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                {ANNEX_III_ARTICLES[q.id]}
                                {hints.has(q.id) && (
                                    <span data-testid="ladder-annex-hint" className="ml-1.5 text-[var(--text-secondary)]">
                                        · {t('compliance.ladder_annex_mentioned', 'this automation’s wording mentions it')}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                            {['no', 'yes'].map((v) => {
                                const on = value === v;
                                const tone = v === 'yes' ? TONES.error : TONES.success;
                                return (
                                    <button
                                        key={v}
                                        type="button"
                                        data-testid={`ladder-annex-${v}`}
                                        data-domain={q.id}
                                        aria-pressed={on}
                                        onClick={() => onAnswer(q.id, v)}
                                        className="text-[11px] px-2 py-0.5 rounded-full border transition"
                                        style={on
                                            ? { borderColor: tone.raw, background: tint(tone.raw), color: tone.ink }
                                            : { borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                                    >
                                        {v === 'yes' ? t('compliance.ladder_yes', 'Yes') : t('compliance.ladder_no', 'No')}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
