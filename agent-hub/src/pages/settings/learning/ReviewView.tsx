import { RotateCcw, Loader2, Sparkles, Play, ListChecks, Puzzle, Clock } from 'lucide-react';
import { useMemo } from 'react';
import { Card, Eyebrow, EmojiTile, PrimaryButton, SecondaryButton, shortDate, tOpt } from './bits';
import { getLesson } from '../../../components/onboarding/lessons';
import { deriveMistakes, deriveStaleReviewLessons, REVIEW_SESSION_SIZE, REVIEW_STALE_DAYS } from '../../../components/onboarding/reviewEngine';
import { STEP_TYPES } from '../../../components/onboarding/stepTypes';
import type { TranslateParams } from '../../../hooks/useTranslation';

/**
 * ReviewView — the "Herhalen" tab. The handoff gives it a tab and a rail row
 * but no artboard, so it borrows the hero's language: what is due (the
 * mistakes inventory and the lessons going stale), one button that starts
 * the mixed session, and the two lists underneath as tables in the same
 * shape as the course screen. Nothing here is a nag: with nothing due the
 * page says so and stops.
 */
interface ReviewViewProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    locale: string;
    progressMap: {};
    reviewDue: { mistakes: number; staleLessons: number; due: boolean; };
    reviewBuilding: boolean;
    practiceableIds: Set<string>;
    onStartReview: () => Promise<void>;
    onPractice: (value: string) => void;
    onOpenLesson: (value: string) => void;
}

export default function ReviewView({ t, locale, progressMap, reviewDue, reviewBuilding, practiceableIds, onStartReview, onPractice, onOpenLesson }: ReviewViewProps) {
    const mistakes = useMemo(() => deriveMistakes(progressMap, getLesson), [progressMap]);
    const stale = useMemo(() => deriveStaleReviewLessons(progressMap, getLesson), [progressMap]);

    return (
        <div className="flex flex-col gap-4 [padding:22px_28px] [font-size:13px] [color:var(--text-primary)]" data-testid="review-view">
            <Card className="flex items-center gap-3.5 [padding:14px_16px]!">
                <div className="grid place-items-center flex-shrink-0 w-[48px] h-[48px] [border-radius:12px] [background:color-mix(in_srgb,var(--accent-primary)_18%,transparent)] [color:var(--accent-primary)]">
                    {reviewBuilding ? <Loader2 className="animate-spin w-[22px] h-[22px]" /> : <RotateCcw className="w-[22px] h-[22px]" aria-hidden="true" />}
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
                    <Eyebrow accent>{t('learn.rail.review', 'Review')}</Eyebrow>
                    <div className="text-[16px] font-semibold leading-5">
                        {reviewDue?.due
                            ? t('learn.review.page_title', '{m} mistakes to clear · {s} lessons going stale').replace('{m}', String(reviewDue.mistakes)).replace('{s}', String(reviewDue.staleLessons))
                            : t('learn.hero.review_none', 'Nothing to review yet')}
                    </div>
                    <div className="text-[11px] leading-[15px] [color:var(--text-tertiary)]! [text-wrap:pretty]!">
                        {reviewDue?.due
                            ? t('learn.review.page_sub', 'A session mixes your mistakes first, then lessons older than {days} days, then fresh AI questions — about {n} items. A right answer here clears the mistake in the lesson itself; a clean re-proof turns the lesson gold.').replace('{days}', String(REVIEW_STALE_DAYS)).replace('{n}', String(REVIEW_SESSION_SIZE))
                            : t('learn.hero.review_none_sub', 'Mistakes and lessons older than two weeks land here — a short session keeps them stuck.')}
                    </div>
                </div>
                <PrimaryButton onClick={onStartReview} disabled={!reviewDue?.due || reviewBuilding} data-testid="review-start">
                    <RotateCcw className="w-[13px] h-[13px]" aria-hidden="true" />
                    {reviewBuilding ? t('learn.review.building', 'Putting your session together…') : t('learn.hero.review_start', 'Start review')}
                </PrimaryButton>
            </Card>

            <div className="grid gap-4 [grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
                <Card className="overflow-hidden text-[12px]">
                    <div className="flex items-center gap-2 [padding:12px_14px]">
                        <ListChecks className="w-[15px] h-[15px] [color:var(--text-secondary)]" aria-hidden="true" />
                        <span className="font-semibold">{t('learn.review.mistakes_title', 'Mistakes to clear')}</span>
                        <span className="text-[11px] text-[var(--text-tertiary)]">{mistakes.length}</span>
                    </div>
                    {mistakes.length === 0 ? (
                        <div className="text-[11px] [padding:0_14px_14px] [color:var(--text-tertiary)]!">{t('learn.review.mistakes_none', 'No open mistakes — every quiz and simulation you answered is cleared.')}</div>
                    ) : mistakes.map((m) => {
                        const lesson = getLesson(m.lessonId);
                        const step = (lesson?.steps || []).find((s) => s.id === m.stepId);
                        return (
                            <div key={`${m.lessonId}:${m.stepId}`} className="grid items-center gap-3 [grid-template-columns:32px_minmax(0,1fr)_auto] [padding:8px_14px] [border-top:1px_solid_var(--border-default)]">
                                <EmojiTile icon={lesson?.icon || '❓'} size={32} />
                                <div className="min-w-0">
                                    <div className="font-medium truncate">{tOpt(t, step?.titleKey, step?.titleFallback) || tOpt(t, step?.questionKey, step?.questionFallback) || tOpt(t, lesson?.titleKey, lesson?.titleFallback)}</div>
                                    <div className="text-[11px] truncate flex items-center gap-1 text-[var(--text-tertiary)]">
                                        {m.kind === STEP_TYPES.SIM ? <Puzzle className="w-[11px] h-[11px]" aria-hidden="true" /> : <ListChecks className="w-[11px] h-[11px]" aria-hidden="true" />}
                                        {tOpt(t, lesson?.titleKey, lesson?.titleFallback)}{m.at && <> · {shortDate(m.at, locale)}</>}
                                    </div>
                                </div>
                                <SecondaryButton small onClick={() => onOpenLesson(m.lessonId)}><Play className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.table.replay', 'Replay')}</SecondaryButton>
                            </div>
                        );
                    })}
                </Card>

                <Card className="overflow-hidden text-[12px]">
                    <div className="flex items-center gap-2 [padding:12px_14px]">
                        <Clock className="w-[15px] h-[15px] [color:var(--text-secondary)]" aria-hidden="true" />
                        <span className="font-semibold">{t('learn.review.stale_title', 'Going stale')}</span>
                        <span className="text-[11px] text-[var(--text-tertiary)]">{t('learn.review.stale_sub', 'complete, not mastered, older than {days} days').replace('{days}', String(REVIEW_STALE_DAYS))}</span>
                    </div>
                    {stale.length === 0 ? (
                        <div className="text-[11px] [padding:0_14px_14px] [color:var(--text-tertiary)]!">{t('learn.review.stale_none', 'Nothing is going stale — mastered lessons never do.')}</div>
                    ) : stale.map((s) => {
                        const lesson = getLesson(s.lessonId);
                        return (
                            <div key={s.lessonId} className="grid items-center gap-3 [grid-template-columns:32px_minmax(0,1fr)_auto] [padding:8px_14px] [border-top:1px_solid_var(--border-default)]">
                                <EmojiTile icon={lesson?.icon || '📘'} size={32} />
                                <div className="min-w-0">
                                    <div className="font-medium truncate">{tOpt(t, lesson?.titleKey, lesson?.titleFallback)}</div>
                                    <div className="text-[11px] truncate text-[var(--text-tertiary)]">{t('learn.table.completed_on', 'Completed on {date}').replace('{date}', shortDate(s.completedAt, locale))}</div>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    {practiceableIds.has(s.lessonId) && (
                                        <SecondaryButton small onClick={() => onPractice(s.lessonId)} disabled={reviewBuilding}><Sparkles className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.practice.button', 'Practice')}</SecondaryButton>
                                    )}
                                    <SecondaryButton small onClick={() => onOpenLesson(s.lessonId)}><Play className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.table.replay', 'Replay')}</SecondaryButton>
                                </div>
                            </div>
                        );
                    })}
                </Card>
            </div>
        </div>
    );
}
