import {
    Play, Sparkles, RotateCcw, ChevronDown, ChevronUp, CircleCheck, CircleDot, Circle,
    Lock, PanelRight, Loader2,
} from 'lucide-react';
import React, { useState } from 'react';
import { Card, StepKindIcon, stepKindLabel, PrimaryButton, SecondaryButton, shortDate, tOpt } from './bits';
import CourseIcon from './courseIcons';
import { lessonStepKinds, lessonPlays, nextLessonIn, lessonsMinutes } from './curriculum';
import LearningHeader, { HeaderTile } from './LearningHeader';
import { filterAvailableSteps, hasVideoSteps, useLearnManifest } from '../../../components/onboarding/learnMedia';
import { STEP_TYPES } from '../../../components/onboarding/stepTypes';

/**
 * CourseView — artboard 3b.
 *
 * Round 3 cut the course screen down to the only two things it owes a learner:
 * one sentence saying what the course is for, and the list of lessons.
 *
 * What went, and why:
 *   • THE SUMMARY CARD. Three columns of description, progress, XP, badge and
 *     certificate sat between the header and the lessons — so the list, which
 *     is the reason for the screen, started below the fold on a laptop. The
 *     description is now the intro line; the rewards moved to Achievements,
 *     where they are the content rather than an interruption.
 *   • THE LESSONS / ABOUT TABS. About repeated the card, which repeated the
 *     header.
 *   • THE "STEPS" AND "PLAYS" COLUMNS. Six columns for six lessons is a
 *     spreadsheet. The step mix belongs to someone deciding whether to open a
 *     lesson, which is what the expander is for; and where a lesson plays is
 *     now the BUTTON'S OWN TEXT — "Beside the app" both states the fact and
 *     does the thing, where the old chip only stated it.
 *
 * The status stripe and one glyph carry state: gold mastered, green complete,
 * accent the one you are on, grey untouched.
 */
export default function CourseView({
    t, locale, course, lessons, progressMap, completedMap, masteredMap, locked, lockedReason,
    practiceableIds, reviewBuilding, onBack, onStartLesson, onPractice,
}) {
    const [openId, setOpenId] = useState(null);
    const done = lessons.filter((l) => !!completedMap[l.id]).length;
    const minutes = lessonsMinutes(lessons);
    const next = nextLessonIn(lessons, completedMap);
    const title = t(course.titleKey, course.titleFallback);

    return (
        <div className="flex flex-col h-full min-h-0" style={{ fontSize: 13, color: 'var(--text-primary)' }} data-testid="course-view">
            <LearningHeader
                t={t}
                onBack={onBack}
                backLabel={t('learn.course.back', 'Back to the overview')}
                tile={<HeaderTile icon={(props) => <CourseIcon courseId={course.id} size={15} {...props} />} />}
                title={title}
                chips={(
                    <span className="text-[12px] whitespace-nowrap flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                        {t('learn.course.progress_chip', '{a} of {b} lessons · {min} min')
                            .replace('{a}', String(done)).replace('{b}', String(lessons.length)).replace('{min}', String(minutes))}
                    </span>
                )}
                actions={!locked && next && (
                    <PrimaryButton onClick={() => onStartLesson(next.lesson.id)} data-testid="course-continue">
                        <Play style={{ width: 13, height: 13 }} aria-hidden="true" />
                        {t('learn.course.continue_with', 'Continue with lesson {n}').replace('{n}', String(next.index))}
                    </PrimaryButton>
                )}
            />

            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 text-[12px]" style={{ padding: 28 }}>
                {locked && (
                    <div className="flex items-center gap-2 rounded-[10px] text-[12px]" style={{ padding: '10px 12px', border: '1px dashed var(--text-tertiary)', color: 'var(--text-secondary)' }}>
                        <Lock style={{ width: 13, height: 13, flexShrink: 0 }} aria-hidden="true" />{lockedReason}
                    </div>
                )}

                <p className="m-0 leading-[18px] text-[13px]" style={{ maxWidth: 680, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                    {t(course.descKey, course.descFallback)}
                </p>

                <Card className="overflow-hidden flex flex-col">
                    <div className="grid gap-3 uppercase font-semibold" style={{ gridTemplateColumns: ROW_COLS, padding: '8px 14px', fontSize: 10, letterSpacing: '.08em', color: 'var(--text-tertiary)' }}>
                        <span /><span>{t('learn.table.lesson', 'Lesson')}</span><span>{t('learn.table.duration', 'Duration')}</span><span />
                    </div>
                    {lessons.map((lesson) => (
                        <LessonRow key={lesson.id} t={t} locale={locale} lesson={lesson}
                            entry={progressMap[lesson.id]}
                            isComplete={!!completedMap[lesson.id]}
                            isMastered={!!completedMap[lesson.id] && !!masteredMap[lesson.id]}
                            isNext={next?.lesson.id === lesson.id} locked={locked}
                            open={openId === lesson.id} onToggle={() => setOpenId((id) => (id === lesson.id ? null : lesson.id))}
                            practiceable={practiceableIds.has(lesson.id)} reviewBuilding={reviewBuilding}
                            onStart={(opts) => onStartLesson(lesson.id, opts)} onPractice={() => onPractice(lesson.id)} />
                    ))}
                </Card>
            </div>
        </div>
    );
}

const ROW_COLS = '18px minmax(0,1fr) 70px 170px';

/** Gold mastered · green complete · accent the one you are on · grey untouched. */
function stripeColor({ isMastered, isComplete, isNext }) {
    if (isMastered) return 'var(--learn-mastered)';
    if (isComplete) return 'var(--learn-complete)';
    if (isNext) return 'var(--accent-primary)';
    return 'var(--bg-tertiary)';
}

/** "Mastered on 12 Sep, first try" — nothing at all for an unfinished lesson. */
function completionStamp(t, locale, entry, { isMastered, isComplete }) {
    if (isMastered && entry?.masteredAt) {
        return t('learn.table.mastered_on', 'Mastered on {date}, first try').replace('{date}', shortDate(entry.masteredAt, locale));
    }
    if (isComplete && entry?.completedAt) {
        return t('learn.table.completed_on', 'Completed on {date}').replace('{date}', shortDate(entry.completedAt, locale));
    }
    return '';
}

/**
 * One lesson row. The right-hand chip is the lesson's ONE action, and which
 * one it is says something the row would otherwise need a column for: a lesson
 * with action or tour steps offers "Beside the app", because that is how it
 * wants to be played.
 */
function LessonRow({ t, locale, lesson, entry, isComplete, isMastered, isNext, locked, open, onToggle, practiceable, reviewBuilding, onStart, onPractice }) {
    const docked = lessonPlays(lesson) === 'docked';
    const stripe = stripeColor({ isMastered, isComplete, isNext });
    const rowBg = isNext ? 'var(--bg-secondary)' : undefined;
    const desc = tOpt(t, lesson.descKey, lesson.descFallback);
    const stamp = completionStamp(t, locale, entry, { isMastered, isComplete });

    return (
        <>
            <div className="grid items-center gap-3" data-testid="lesson-row" data-lesson-id={lesson.id}
                style={{ gridTemplateColumns: ROW_COLS, padding: '11px 14px', borderTop: '1px solid var(--border-default)', boxShadow: `inset 3px 0 0 ${stripe}`, background: rowBg }}>
                <StatusGlyph isMastered={isMastered} isComplete={isComplete} isNext={isNext} t={t} />
                <div className="min-w-0">
                    <div className="font-medium truncate">{t(lesson.titleKey, lesson.titleFallback)}</div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                        {stamp && <>{stamp} · </>}{desc}
                    </div>
                </div>
                <span style={{ color: 'var(--text-secondary)' }}>{t('learn.minutes', '{n} min').replace('{n}', String(lesson.estMinutes || 1))}</span>
                <div className="flex justify-end items-center gap-1.5">
                    <RowAction t={t} isComplete={isComplete} isNext={isNext} docked={docked} locked={locked} onStart={onStart} />
                    <button type="button" onClick={onToggle} aria-expanded={open} aria-label={t('learn.table.details', 'Lesson details')}
                        className="grid place-items-center rounded-md w-6 h-6 hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-tertiary)' }}>
                        {open ? <ChevronUp style={{ width: 14, height: 14 }} /> : <ChevronDown style={{ width: 14, height: 14 }} />}
                    </button>
                </div>
            </div>
            {open && (
                <LessonSteps t={t} lesson={lesson} stripe={stripe}
                    showPractice={isComplete && practiceable} reviewBuilding={reviewBuilding} onPractice={onPractice} />
            )}
        </>
    );
}

/**
 * The row's one action, and which one it is carries information: a lesson with
 * action or tour steps offers "Beside the app" because that is how it wants to
 * be played — the old design spent a whole column saying the same thing without
 * being able to act on it.
 */
function RowAction({ t, isComplete, isNext, docked, locked, onStart }) {
    if (isComplete) {
        return (
            <SecondaryButton small onClick={() => onStart()} disabled={locked}>
                <RotateCcw style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.table.replay', 'Again')}
            </SecondaryButton>
        );
    }
    if (isNext) {
        return (
            <PrimaryButton small onClick={() => onStart()} disabled={locked}>
                <Play style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.play', 'Play')}
            </PrimaryButton>
        );
    }
    if (docked) {
        return (
            <SecondaryButton small onClick={() => onStart({ layout: 'docked' })} disabled={locked}>
                <PanelRight style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.beside_app', 'Beside the app')}
            </SecondaryButton>
        );
    }
    return (
        <SecondaryButton small onClick={() => onStart()} disabled={locked}>
            <Play style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.play', 'Play')}
        </SecondaryButton>
    );
}

/**
 * The expander: the steps, numbered, and one line on what mastery takes.
 *
 * Round 1 put three columns here — steps, mastery, "help on the way". The help
 * column described the tutor, the hint ladder and the skip rule identically for
 * every lesson in the product, which is a manual, not a detail of this lesson.
 * Practice lives here rather than in the row because it only exists for a
 * lesson already finished, and a button that is usually absent should not hold
 * width in every row.
 */
function LessonSteps({ t, lesson, stripe, showPractice, reviewBuilding, onPractice }) {
    // An optional video step is listed only when this deployment's media pack
    // has its clip: the same filter the player applies (learnMedia.ts), so the
    // list never promises a step the lesson will not show. A lesson without
    // video steps fetches nothing.
    const all = lesson.steps || [];
    const media = useLearnManifest(hasVideoSteps(all));
    const steps = filterAvailableSteps(all, media.status === 'ready' ? media.manifest : null);
    const kinds = lessonStepKinds({ steps });
    return (
        <div className="flex flex-col gap-[7px] leading-4" data-testid="lesson-steps"
            style={{ padding: '2px 14px 16px 44px', background: 'var(--bg-secondary)', boxShadow: `inset 3px 0 0 ${stripe}`, color: 'var(--text-secondary)', maxWidth: 760 }}>
            {steps.map((s, i) => (
                <div key={s.id || i} className="grid items-center gap-2" style={{ gridTemplateColumns: '14px 14px minmax(0,1fr)' }}>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{i + 1}</span>
                    <StepKindIcon kind={kinds[i]} />
                    <span className="truncate">
                        <span className="capitalize">{stepKindLabel(t, kinds[i])}</span>
                        {' · '}{tOpt(t, s.titleKey, s.titleFallback) || tOpt(t, s.questionKey, s.questionFallback)}
                        {kinds[i] === STEP_TYPES.EXERCISE && <span style={{ color: 'var(--text-tertiary)' }}> · {t('learn.table.ai_coach', 'AI coach')}</span>}
                    </span>
                </div>
            ))}
            <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-tertiary)' }}>
                <span>{t('learn.table.what_counts_short', 'Mastered when every quiz is right first try and the exercise needs no hint.')}</span>
                {showPractice && (
                    <button type="button" onClick={onPractice} disabled={reviewBuilding}
                        title={t('learn.practice.button_title', 'A fresh round of AI-generated questions on this lesson')}
                        className="inline-flex items-center gap-1 font-medium transition hover:underline disabled:opacity-40"
                        style={{ color: 'var(--accent-primary)' }}>
                        {reviewBuilding
                            ? <Loader2 className="animate-spin" style={{ width: 11, height: 11 }} aria-hidden="true" />
                            : <Sparkles style={{ width: 11, height: 11 }} aria-hidden="true" />}
                        {t('learn.practice.button', 'Practice')}
                    </button>
                )}
            </div>
        </div>
    );
}

function StatusGlyph({ isMastered, isComplete, isNext, t }) {
    if (isMastered) return <CircleCheck style={{ width: 16, height: 16, color: 'var(--learn-mastered)', flexShrink: 0 }} aria-label={t('learn.mastery.chip', 'Mastered')} />;
    if (isComplete) return <CircleCheck style={{ width: 16, height: 16, color: 'var(--learn-complete)', flexShrink: 0 }} aria-label={t('learn.state.complete', 'complete')} />;
    if (isNext) return <CircleDot style={{ width: 16, height: 16, color: 'var(--accent-primary)', flexShrink: 0 }} aria-label={t('learn.table.next', 'Next')} />;
    return <Circle style={{ width: 16, height: 16, color: 'var(--text-tertiary)', flexShrink: 0 }} aria-hidden="true" />;
}
