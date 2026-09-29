import { RotateCcw, Loader2, Sparkles, Play, ListChecks, Puzzle, Clock } from 'lucide-react';
import React, { useMemo } from 'react';
import { Card, Eyebrow, EmojiTile, PrimaryButton, SecondaryButton, shortDate, tOpt } from './bits';
import { getLesson } from '../../../components/onboarding/lessons';
import { deriveMistakes, deriveStaleReviewLessons, REVIEW_SESSION_SIZE, REVIEW_STALE_DAYS } from '../../../components/onboarding/reviewEngine';
import { STEP_TYPES } from '../../../components/onboarding/stepTypes';

/**
 * ReviewView — the "Herhalen" tab. The handoff gives it a tab and a rail row
 * but no artboard, so it borrows the hero's language: what is due (the
 * mistakes inventory and the lessons going stale), one button that starts
 * the mixed session, and the two lists underneath as tables in the same
 * shape as the course screen. Nothing here is a nag: with nothing due the
 * page says so and stops.
 */
export default function ReviewView({ t, locale, progressMap, reviewDue, reviewBuilding, practiceableIds, onStartReview, onPractice, onOpenLesson }) {
    const mistakes = useMemo(() => deriveMistakes(progressMap, getLesson), [progressMap]);
    const stale = useMemo(() => deriveStaleReviewLessons(progressMap, getLesson), [progressMap]);

    return (
        <div className="flex flex-col gap-4" style={{ padding: '22px 28px', fontSize: 13, color: 'var(--text-primary)' }} data-testid="review-view">
            <Card className="flex items-center gap-3.5" style={{ padding: '14px 16px' }}>
                <div className="grid place-items-center flex-shrink-0" style={{ width: 48, height: 48, borderRadius: 12, background: 'color-mix(in srgb, var(--accent-primary) 18%, transparent)', color: 'var(--accent-primary)' }}>
                    {reviewBuilding ? <Loader2 className="animate-spin" style={{ width: 22, height: 22 }} /> : <RotateCcw style={{ width: 22, height: 22 }} aria-hidden="true" />}
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
                    <Eyebrow accent>{t('learn.rail.review', 'Review')}</Eyebrow>
                    <div className="text-[16px] font-semibold leading-5">
                        {reviewDue?.due
                            ? t('learn.review.page_title', '{m} mistakes to clear · {s} lessons going stale').replace('{m}', String(reviewDue.mistakes)).replace('{s}', String(reviewDue.staleLessons))
                            : t('learn.hero.review_none', 'Nothing to review yet')}
                    </div>
                    <div className="text-[11px] leading-[15px]" style={{ color: 'var(--text-tertiary)', textWrap: 'pretty' }}>
                        {reviewDue?.due
                            ? t('learn.review.page_sub', 'A session mixes your mistakes first, then lessons older than {days} days, then fresh AI questions — about {n} items. A right answer here clears the mistake in the lesson itself; a clean re-proof turns the lesson gold.').replace('{days}', String(REVIEW_STALE_DAYS)).replace('{n}', String(REVIEW_SESSION_SIZE))
                            : t('learn.hero.review_none_sub', 'Mistakes and lessons older than two weeks land here — a short session keeps them stuck.')}
                    </div>
                </div>
                <PrimaryButton onClick={onStartReview} disabled={!reviewDue?.due || reviewBuilding} data-testid="review-start">
                    <RotateCcw style={{ width: 13, height: 13 }} aria-hidden="true" />
                    {reviewBuilding ? t('learn.review.building', 'Putting your session together…') : t('learn.hero.review_start', 'Start review')}
                </PrimaryButton>
            </Card>

            <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
                <Card className="overflow-hidden text-[12px]">
                    <div className="flex items-center gap-2" style={{ padding: '12px 14px' }}>
                        <ListChecks style={{ width: 15, height: 15, color: 'var(--text-secondary)' }} aria-hidden="true" />
                        <span className="font-semibold">{t('learn.review.mistakes_title', 'Mistakes to clear')}</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{mistakes.length}</span>
                    </div>
                    {mistakes.length === 0 ? (
                        <div className="text-[11px]" style={{ padding: '0 14px 14px', color: 'var(--text-tertiary)' }}>{t('learn.review.mistakes_none', 'No open mistakes — every quiz and simulation you answered is cleared.')}</div>
                    ) : mistakes.map((m) => {
                        const lesson = getLesson(m.lessonId);
                        const step = (lesson?.steps || []).find((s) => s.id === m.stepId);
                        return (
                            <div key={`${m.lessonId}:${m.stepId}`} className="grid items-center gap-3" style={{ gridTemplateColumns: '32px minmax(0,1fr) auto', padding: '8px 14px', borderTop: '1px solid var(--border-default)' }}>
                                <EmojiTile icon={lesson?.icon || '❓'} size={32} />
                                <div className="min-w-0">
                                    <div className="font-medium truncate">{tOpt(t, step?.titleKey, step?.titleFallback) || tOpt(t, step?.questionKey, step?.questionFallback) || tOpt(t, lesson?.titleKey, lesson?.titleFallback)}</div>
                                    <div className="text-[11px] truncate flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                                        {m.kind === STEP_TYPES.SIM ? <Puzzle style={{ width: 11, height: 11 }} aria-hidden="true" /> : <ListChecks style={{ width: 11, height: 11 }} aria-hidden="true" />}
                                        {tOpt(t, lesson?.titleKey, lesson?.titleFallback)}{m.at && <> · {shortDate(m.at, locale)}</>}
                                    </div>
                                </div>
                                <SecondaryButton small onClick={() => onOpenLesson(m.lessonId)}><Play style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.table.replay', 'Replay')}</SecondaryButton>
                            </div>
                        );
                    })}
                </Card>

                <Card className="overflow-hidden text-[12px]">
                    <div className="flex items-center gap-2" style={{ padding: '12px 14px' }}>
                        <Clock style={{ width: 15, height: 15, color: 'var(--text-secondary)' }} aria-hidden="true" />
                        <span className="font-semibold">{t('learn.review.stale_title', 'Going stale')}</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.review.stale_sub', 'complete, not mastered, older than {days} days').replace('{days}', String(REVIEW_STALE_DAYS))}</span>
                    </div>
                    {stale.length === 0 ? (
                        <div className="text-[11px]" style={{ padding: '0 14px 14px', color: 'var(--text-tertiary)' }}>{t('learn.review.stale_none', 'Nothing is going stale — mastered lessons never do.')}</div>
                    ) : stale.map((s) => {
                        const lesson = getLesson(s.lessonId);
                        return (
                            <div key={s.lessonId} className="grid items-center gap-3" style={{ gridTemplateColumns: '32px minmax(0,1fr) auto', padding: '8px 14px', borderTop: '1px solid var(--border-default)' }}>
                                <EmojiTile icon={lesson?.icon || '📘'} size={32} />
                                <div className="min-w-0">
                                    <div className="font-medium truncate">{tOpt(t, lesson?.titleKey, lesson?.titleFallback)}</div>
                                    <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{t('learn.table.completed_on', 'Completed on {date}').replace('{date}', shortDate(s.completedAt, locale))}</div>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    {practiceableIds.has(s.lessonId) && (
                                        <SecondaryButton small onClick={() => onPractice(s.lessonId)} disabled={reviewBuilding}><Sparkles style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.practice.button', 'Practice')}</SecondaryButton>
                                    )}
                                    <SecondaryButton small onClick={() => onOpenLesson(s.lessonId)}><Play style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.table.replay', 'Replay')}</SecondaryButton>
                                </div>
                            </div>
                        );
                    })}
                </Card>
            </div>
        </div>
    );
}
