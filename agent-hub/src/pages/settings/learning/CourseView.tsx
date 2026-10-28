import {
    Play, Sparkles, RotateCcw, ChevronDown, ChevronUp, CircleCheck, CircleDot, Circle,
    Lock, PanelRight, Loader2,
} from 'lucide-react';
import React, { useState } from 'react';
import { Card, StepKindIcon, stepKindLabel, PrimaryButton, SecondaryButton, shortDate, tOpt, type TFn } from './bits';
import CourseIcon from './courseIcons';
import { lessonStepKinds, lessonPlays, nextLessonIn, lessonsMinutes } from './curriculum';
import LearningHeader, { HeaderTile } from './LearningHeader';
import { filterAvailableSteps, hasVideoSteps, useLearnManifest } from '@/components/onboarding/learnMedia';
import { STEP_TYPES } from '@/components/onboarding/stepTypes';
import type { Course, LessonDoc, LessonProgressEntry, ProgressMap } from '@/api/lessons.types';

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
interface CourseViewProps {
    t: TFn;
    locale: string;
    course: Course;
    lessons: LessonDoc[];
    progressMap: ProgressMap;
    completedMap: Record<string, boolean>;
    masteredMap: Record<string, boolean>;
    locked: boolean;
    lockedReason: string;
    practiceableIds: Set<string>;
    reviewBuilding: boolean;
    onBack: () => void;
    onStartLesson: (lessonId: string, opts?: { layout: string }) => void;
    onPractice: (lessonId: string) => void;
}

export default function CourseView({
    t, locale, course, lessons, progressMap, completedMap, masteredMap, locked, lockedReason,
    practiceableIds, reviewBuilding, onBack, onStartLesson, onPractice,
}: CourseViewProps) {
    const [openId, setOpenId] = useState<string | null>(null);
    const done = lessons.filter((l) => !!completedMap[l.id]).length;
    const minutes = lessonsMinutes(lessons);
    const next = nextLessonIn(lessons, completedMap);
    const title = t(course.titleKey, course.titleFallback);

    return (
        <div className="flex flex-col h-full min-h-0 [font-size:13px] [color:var(--text-primary)]" data-testid="course-view">
            <LearningHeader
                t={t}
                onBack={onBack}
                backLabel={t('learn.course.back', 'Back to the overview')}
                tile={<HeaderTile icon={(props) => <CourseIcon courseId={course.id} size={15} {...props} />} />}
                title={title}
                chips={(
                    <span className="text-[12px] whitespace-nowrap flex-shrink-0 text-[var(--text-tertiary)]">
                        {t('learn.course.progress_chip', '{a} of {b} lessons · {min} min')
                            .replace('{a}', String(done)).replace('{b}', String(lessons.length)).replace('{min}', String(minutes))}
                    </span>
                )}
                actions={!locked && next && (
                    <PrimaryButton onClick={() => onStartLesson(next.lesson.id)} data-testid="course-continue">
                        <Play className="w-[13px] h-[13px]" aria-hidden="true" />
                        {t('learn.course.continue_with', 'Continue with lesson {n}').replace('{n}', String(next.index))}
                    </PrimaryButton>
                )}
            />

            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 text-[12px] [padding:28px]">
                {locked && (
                    <div className="flex items-center gap-2 rounded-[10px] text-[12px] [padding:10px_12px] [border:1px_dashed_var(--text-tertiary)] [color:var(--text-secondary)]!">
                        <Lock className="w-[13px] h-[13px] [flex-shrink:0]" aria-hidden="true" />{lockedReason}
                    </div>
                )}

                <p className="m-0 leading-[18px] text-[13px] max-w-[680px] [color:var(--text-secondary)]! [text-wrap:pretty]!">
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
interface StripeColorArgs {
    isMastered: boolean;
    isComplete: boolean;
    isNext: boolean;
}

function stripeColor({ isMastered, isComplete, isNext }: StripeColorArgs) {
    if (isMastered) return 'var(--learn-mastered)';
    if (isComplete) return 'var(--learn-complete)';
    if (isNext) return 'var(--accent-primary)';
    return 'var(--bg-tertiary)';
}

/** "Mastered on 12 Sep, first try" — nothing at all for an unfinished lesson. */
function completionStamp(t: TFn, locale: string | Intl.Locale | readonly (string | Intl.Locale)[], entry: LessonProgressEntry | undefined, { isMastered, isComplete }: { isMastered: boolean; isComplete: boolean }) {
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
interface LessonRowProps {
    t: TFn;
    entry?: LessonProgressEntry;
    onStart: (opts?: { layout: string }) => void;
    locale: string | Intl.Locale | readonly (string | Intl.Locale)[];
    lesson: LessonDoc;
    isComplete: boolean;
    isMastered: boolean;
    isNext: boolean;
    locked: boolean;
    open: boolean;
    onToggle: () => void;
    practiceable: boolean;
    reviewBuilding: boolean;
    onPractice: React.MouseEventHandler<HTMLButtonElement>;
}

function LessonRow({ t, locale, lesson, entry, isComplete, isMastered, isNext, locked, open, onToggle, practiceable, reviewBuilding, onStart, onPractice }: LessonRowProps) {
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
                    <div className="text-[11px] truncate text-[var(--text-tertiary)]">
                        {stamp && <>{stamp} · </>}{desc}
                    </div>
                </div>
                <span className="text-[var(--text-secondary)]">{t('learn.minutes', '{n} min').replace('{n}', String(lesson.estMinutes || 1))}</span>
                <div className="flex justify-end items-center gap-1.5">
                    <RowAction t={t} isComplete={isComplete} isNext={isNext} docked={docked} locked={locked} onStart={onStart} />
                    <button type="button" onClick={onToggle} aria-expanded={open} aria-label={t('learn.table.details', 'Lesson details')}
                        className="grid place-items-center rounded-md w-6 h-6 hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
                        {open ? <ChevronUp className="w-[14px] h-[14px]" /> : <ChevronDown className="w-[14px] h-[14px]" />}
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
interface RowActionProps {
    t: TFn;
    isComplete: boolean;
    isNext: boolean;
    docked: boolean;
    locked: boolean;
    onStart: (value?: { layout: string; }) => void;
}

function RowAction({ t, isComplete, isNext, docked, locked, onStart }: RowActionProps) {
    if (isComplete) {
        return (
            <SecondaryButton small onClick={() => onStart()} disabled={locked}>
                <RotateCcw className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.table.replay', 'Again')}
            </SecondaryButton>
        );
    }
    if (isNext) {
        return (
            <PrimaryButton small onClick={() => onStart()} disabled={locked}>
                <Play className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.play', 'Play')}
            </PrimaryButton>
        );
    }
    if (docked) {
        return (
            <SecondaryButton small onClick={() => onStart({ layout: 'docked' })} disabled={locked}>
                <PanelRight className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.beside_app', 'Beside the app')}
            </SecondaryButton>
        );
    }
    return (
        <SecondaryButton small onClick={() => onStart()} disabled={locked}>
            <Play className="w-[12px] h-[12px]" aria-hidden="true" />{t('learn.play', 'Play')}
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
interface LessonStepsProps {
    t: TFn;
    lesson: LessonDoc;
    stripe: string;
    showPractice: boolean;
    reviewBuilding: boolean;
    onPractice: React.MouseEventHandler<HTMLButtonElement>;
}

function LessonSteps({ t, lesson, stripe, showPractice, reviewBuilding, onPractice }: LessonStepsProps) {
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
                <div key={s.id || i} className="grid items-center gap-2 [grid-template-columns:14px_14px_minmax(0,1fr)]">
                    <span className="font-semibold text-[var(--text-primary)]">{i + 1}</span>
                    <StepKindIcon kind={kinds[i]} />
                    <span className="truncate">
                        <span className="capitalize">{stepKindLabel(t, kinds[i])}</span>
                        {' · '}{tOpt(t, s.titleKey, s.titleFallback) || tOpt(t, s.questionKey, s.questionFallback)}
                        {kinds[i] === STEP_TYPES.EXERCISE && <span className="text-[var(--text-tertiary)]"> · {t('learn.table.ai_coach', 'AI coach')}</span>}
                    </span>
                </div>
            ))}
            <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap text-[var(--text-tertiary)]">
                <span>{t('learn.table.what_counts_short', 'Mastered when every quiz is right first try and the exercise needs no hint.')}</span>
                {showPractice && (
                    <button type="button" onClick={onPractice} disabled={reviewBuilding}
                        title={t('learn.practice.button_title', 'A fresh round of AI-generated questions on this lesson')}
                        className="inline-flex items-center gap-1 font-medium transition hover:underline disabled:opacity-40 text-[var(--accent-primary)]">
                        {reviewBuilding
                            ? <Loader2 className="animate-spin w-[11px] h-[11px]" aria-hidden="true" />
                            : <Sparkles className="w-[11px] h-[11px]" aria-hidden="true" />}
                        {t('learn.practice.button', 'Practice')}
                    </button>
                )}
            </div>
        </div>
    );
}

interface StatusGlyphProps {
    t: TFn;
    isMastered: boolean;
    isComplete: boolean;
    isNext: boolean;
}

function StatusGlyph({ isMastered, isComplete, isNext, t }: StatusGlyphProps) {
    if (isMastered) return <CircleCheck className="w-[16px] h-[16px] [color:var(--learn-mastered)] [flex-shrink:0]" aria-label={t('learn.mastery.chip', 'Mastered')} />;
    if (isComplete) return <CircleCheck className="w-[16px] h-[16px] [color:var(--learn-complete)] [flex-shrink:0]" aria-label={t('learn.state.complete', 'complete')} />;
    if (isNext) return <CircleDot className="w-[16px] h-[16px] [color:var(--accent-primary)] [flex-shrink:0]" aria-label={t('learn.table.next', 'Next')} />;
    return <Circle className="w-[16px] h-[16px] [color:var(--text-tertiary)] [flex-shrink:0]" aria-hidden="true" />;
}
