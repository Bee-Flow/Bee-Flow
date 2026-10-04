import { Play, PanelRight, RotateCcw, Check, Lock, Loader2, Crown, ChevronDown, ChevronRight } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Card, EmojiTile, IconTile, PrimaryButton, SecondaryButton } from './bits';
import CourseIcon from './courseIcons';
import { buildCurriculumColumns, splitCapstone, courseState, lessonsMinutes, CAPSTONE_CHECK_ID } from './curriculum';
import { getActionCheck, runActionCheck, applicableCriteria } from '../../../components/onboarding/actionChecks';
import { getLearningPath } from '../../../components/onboarding/learningPaths';

/**
 * OverviewView — artboard 3a.
 *
 * Round 3 took things away, and the removals ARE the design:
 *
 *   • ONE status per course. A row used to carry a segmented bar, a count, a
 *     minute total, a badge emoji and a chevron. Five signals per row, times
 *     twenty rows, is not a summary — it is a second screen to read before you
 *     can pick. Each row now answers one question: done (a check), started
 *     (how far), untouched (how long), or locked (after what).
 *   • NO COLOURED TILES. Colour is reserved for state — green complete, gold
 *     mastered, accent current — so the course glyph sits in a neutral square.
 *   • XP, BADGES AND CERTIFICATES MOVED OUT, to Achievements. They are reward,
 *     not navigation, and on the overview they competed with the one thing this
 *     screen is for: choosing what to do next.
 *   • NO LEVEL FILTER, NO LEGEND. A filter over twenty rows in three columns
 *     that already fit on one screen is a control that costs more attention
 *     than it saves, and a legend is the tell that the encoding needed one.
 *
 * What is left is the hero (what you were doing, and three ways to act on it),
 * one large TILE per learning path, and the capstone as a single closing line.
 *
 * Round 4 (BFSF-473) collapsed the per-path course lists behind those tiles.
 * Three columns times six-plus course rows opened the screen as a wall of
 * twenty stations to read before choosing one; the paths themselves — the
 * three main categories — were drowned by their own content. Each path is now
 * one big button (icon, name, what it is for, how far along you are); the
 * course list of ONE path is expanded at a time, the learner's own path by
 * default. The map below the hero went from ~20 rows to 3 tiles.
 */
export default function OverviewView({
    t, user, hasFeature, courses, lessonsOf, completedMap, isLocked, isComplete, lockedReasonFor,
    path, continueTarget, reviewDue, reviewBuilding,
    onStartLesson, onStartReview, onOpenCourse,
}) {
    const { capstone, rest } = useMemo(() => splitCapstone(courses), [courses]);
    const columns = useMemo(() => buildCurriculumColumns(rest, path), [rest, path]);
    const colKey = (col) => col.pathId || 'other';
    // Accordion: one category open at a time (clicking the open tile closes
    // them all). The learner's own path is already the first column
    // (buildCurriculumColumns moves it there), so the default open tile is
    // simply the first one.
    const [pickedCol, setPickedCol] = useState(null);
    const openCol = pickedCol === null
        ? (columns.length ? colKey(columns[0]) : null)
        : (columns.some((c) => colKey(c) === pickedCol) ? pickedCol : null);

    return (
        <div className="flex flex-col gap-6" style={{ padding: 28, fontSize: 13, color: 'var(--text-primary)' }}>
            <ContinueHero t={t} target={continueTarget} reviewDue={reviewDue} reviewBuilding={reviewBuilding}
                onStartLesson={onStartLesson} onStartReview={onStartReview} />

            <div className="grid gap-4 items-start" style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }} data-testid="curriculum-map">
                {columns.map((col) => {
                    const pathDef = getLearningPath(col.pathId);
                    const done = col.courses.filter(isComplete).length;
                    const expanded = colKey(col) === openCol;
                    return (
                        <Card key={colKey(col)} className="overflow-hidden" data-testid="curriculum-column">
                            <button type="button" onClick={() => setPickedCol(expanded ? '_none_' : colKey(col))}
                                aria-expanded={expanded} data-testid="curriculum-tile"
                                className="w-full flex items-center gap-3 text-left transition hover:bg-[var(--bg-secondary)]"
                                style={{ padding: '14px' }}>
                                <EmojiTile icon={pathDef?.icon || '📚'} size={44} />
                                <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
                                    <span className="font-semibold truncate">
                                        {pathDef ? t(pathDef.titleKey, pathDef.titleFallback) : t('learn.rail.other_courses', 'Your organisation')}
                                    </span>
                                    <span className="text-[11px] leading-[15px] line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>
                                        {pathDef ? t(pathDef.descKey, pathDef.descFallback) : t('learn.curriculum.n_of_m_done', '{a} of {b} complete').replace('{a}', String(done)).replace('{b}', String(col.courses.length))}
                                    </span>
                                    {pathDef && (
                                        <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                                            {t('learn.curriculum.n_of_m_done', '{a} of {b} complete').replace('{a}', String(done)).replace('{b}', String(col.courses.length))}
                                        </span>
                                    )}
                                </span>
                                {expanded
                                    ? <ChevronDown style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--text-tertiary)' }} aria-hidden="true" />
                                    : <ChevronRight style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--text-tertiary)' }} aria-hidden="true" />}
                            </button>
                            {expanded && col.courses.map((course) => (
                                <CourseRow key={course.id} t={t} course={course} lessons={lessonsOf(course)}
                                    completedMap={completedMap} locked={isLocked(course)} complete={isComplete(course)}
                                    lockedReason={lockedReasonFor(course)} onOpen={() => onOpenCourse(course.id)} />
                            ))}
                            {expanded && !col.courses.length && (
                                <div className="text-[11px]" style={{ padding: '12px 14px', borderTop: '1px solid var(--border-default)', color: 'var(--text-tertiary)' }}>
                                    {t('learn.curriculum.no_courses', 'No courses on this path yet.')}
                                </div>
                            )}
                        </Card>
                    );
                })}
            </div>

            {capstone && (
                <CapstoneRow t={t} user={user} hasFeature={hasFeature} course={capstone}
                    isComplete={isComplete} locked={isLocked(capstone)} lockedReason={lockedReasonFor(capstone)}
                    onOpen={() => onOpenCourse(capstone.id)} />
            )}
        </div>
    );
}

/**
 * The hero: one line about where you were, and every way to resume it.
 *
 * Review became the third BUTTON here rather than the second half of a split
 * card. It is the same verb as the other two — resume something — and giving it
 * its own panel made the screen open on two competing invitations. With nothing
 * due, the button is simply absent.
 */
function ContinueHero({ t, target, reviewDue, reviewBuilding, onStartLesson, onStartReview }) {
    const reviewCount = (reviewDue?.mistakes || 0) + (reviewDue?.staleLessons || 0);
    return (
        <Card className="flex items-center gap-4" style={{ padding: '16px 18px' }} data-testid="learning-hero">
            <IconTile size={44}>
                <CourseIcon courseId={target ? target.course.id : 'course-hive-master'} size={20} />
            </IconTile>
            <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
                {target ? (
                    <>
                        <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.continue.label', 'Continue learning')}</div>
                        <div className="text-[16px] font-semibold leading-5 truncate">{t(target.lesson.titleKey, target.lesson.titleFallback)}</div>
                        <div className="text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>
                            {t(target.course.titleKey, target.course.titleFallback)}
                            {' · '}{t('learn.hero.lesson_n_of', 'lesson {n} of {total}').replace('{n}', String(target.index)).replace('{total}', String(target.total))}
                            {' · '}{t('learn.minutes', '{n} min').replace('{n}', String(target.lesson.estMinutes || 1))}
                        </div>
                    </>
                ) : (
                    <>
                        <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.continue.label', 'Continue learning')}</div>
                        <div className="text-[16px] font-semibold leading-5">{t('learn.hero.all_done', 'Everything you can see is complete')}</div>
                        <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{t('learn.hero.all_done_sub', 'Keep it fresh with a review, or open any course again.')}</div>
                    </>
                )}
            </div>
            <div className="flex gap-2 flex-shrink-0">
                {target && (
                    <>
                        <PrimaryButton onClick={() => onStartLesson(target.lesson.id, target.course.id)} data-testid="learning-continue">
                            <Play style={{ width: 13, height: 13 }} aria-hidden="true" />{t('learn.play', 'Play')}
                        </PrimaryButton>
                        <SecondaryButton onClick={() => onStartLesson(target.lesson.id, target.course.id, { layout: 'docked' })}
                            title={t('learn.player.dock_title', 'Dock to the side — use the app while you learn')}>
                            <PanelRight style={{ width: 13, height: 13 }} aria-hidden="true" />{t('learn.beside_app', 'Beside the app')}
                        </SecondaryButton>
                    </>
                )}
                {reviewDue?.due && (
                    <SecondaryButton onClick={onStartReview} disabled={reviewBuilding} data-testid="learning-start-review">
                        {reviewBuilding
                            ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} aria-hidden="true" />
                            : <RotateCcw style={{ width: 13, height: 13 }} aria-hidden="true" />}
                        {t('learn.hero.review_n', '{n} to review').replace('{n}', String(reviewCount))}
                    </SecondaryButton>
                )}
            </div>
        </Card>
    );
}

/**
 * One course, one line, one status.
 *
 * The status is chosen, never stacked: a complete course does not also need its
 * duration, and a locked one does not need its lesson count — what it needs is
 * the name of the thing standing in the way, which is why the lock reason is
 * text and the padlock is only its punctuation.
 */
export function CourseRow({ t, course, lessons, completedMap, locked, complete, lockedReason, onOpen }) {
    const state = courseState({ lessons, completedMap, locked, complete });
    const done = lessons.filter((l) => !!completedMap[l.id]).length;
    const title = t(course.titleKey, course.titleFallback);
    return (
        <button type="button" onClick={onOpen} data-testid="course-station" data-state={state}
            aria-label={locked ? `${title} — ${lockedReason}` : title}
            className="w-full flex items-center gap-2.5 text-left transition hover:bg-[var(--bg-secondary)]"
            style={{
                padding: '12px 14px', borderTop: '1px solid var(--border-default)',
                color: locked ? 'var(--text-tertiary)' : undefined,
            }}>
            <CourseIcon courseId={course.id} size={16} style={{ color: locked ? 'var(--text-tertiary)' : 'var(--text-secondary)' }} />
            <span className="flex-1 min-w-0 truncate font-medium">{title}</span>
            <span className="flex items-center gap-2 text-[11px] whitespace-nowrap flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                {complete ? (
                    <Check style={{ width: 15, height: 15, color: 'var(--learn-complete)' }} aria-label={t('learn.state.complete', 'complete')} />
                ) : locked ? (
                    <>{lockedReason}<Lock style={{ width: 12, height: 12, flexShrink: 0 }} aria-hidden="true" /></>
                ) : done > 0 ? (
                    t('learn.course.n_of_m', '{a} of {b}').replace('{a}', String(done)).replace('{b}', String(lessons.length))
                ) : (
                    t('learn.minutes', '{n} min').replace('{n}', String(lessonsMinutes(lessons)))
                )}
            </span>
        </button>
    );
}

/**
 * The capstone as the closing line of the screen — no lessons, so no list and
 * no progress: what it needs to say is that the proof happens in the learner's
 * own workspace, and what still stands in the way.
 *
 * It still runs its real checks, because "am I there yet" is the only question
 * worth asking of a capstone, and the answer lives in the workspace rather than
 * in the progress blob. With the course locked the run is skipped entirely —
 * there is nothing to report and no reason to spend the calls.
 */
function CapstoneRow({ t, user, hasFeature, course, isComplete, locked, lockedReason, onOpen }) {
    const check = getActionCheck(CAPSTONE_CHECK_ID);
    const ctx = useMemo(() => ({ user, hasFeature }), [user, hasFeature]);
    const criteria = useMemo(() => applicableCriteria(check, ctx), [check, ctx]);
    const complete = isComplete(course);
    const [passes, setPasses] = useState(null);

    useEffect(() => {
        if (locked || complete) return undefined;
        let cancelled = false;
        (async () => {
            const r = await runActionCheck(CAPSTONE_CHECK_ID, ctx);
            if (!cancelled) setPasses(r.error ? {} : r.passes);
        })();
        return () => { cancelled = true; };
    }, [ctx, locked, complete]);

    const passed = complete ? criteria.length : criteria.filter((c) => passes?.[c.id]).length;
    const title = t('learn.capstone.title', '{course} — capstone').replace('{course}', t(course.titleKey, course.titleFallback));
    return (
        <button type="button" onClick={onOpen} data-testid="capstone-station"
            aria-label={locked ? `${title} — ${lockedReason}` : title}
            className="w-full flex items-center gap-2.5 text-left rounded-xl transition hover:bg-[var(--bg-secondary)]"
            style={{
                padding: '12px 14px', color: 'var(--text-tertiary)',
                background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)',
            }}>
                <Crown style={{ width: 16, height: 16, flexShrink: 0 }} aria-hidden="true" />
                <span className="font-medium flex-shrink-0" style={{ color: 'var(--text-primary)' }}>{title}</span>
                <span className="text-[12px] truncate">{t('learn.capstone.short', 'No lessons — prove it in your own workspace.')}</span>
                <span className="ml-auto flex items-center gap-2 text-[11px] whitespace-nowrap flex-shrink-0">
                    {complete ? (
                        <Check style={{ width: 15, height: 15, color: 'var(--learn-complete)' }} aria-label={t('learn.state.complete', 'complete')} />
                    ) : locked ? (
                        <>{lockedReason}<Lock style={{ width: 12, height: 12, flexShrink: 0 }} aria-hidden="true" /></>
                    ) : (
                        <>
                            {passes === null
                                ? <Loader2 className="animate-spin" style={{ width: 11, height: 11 }} aria-hidden="true" />
                                : t('learn.capstone.checks_n', '{a} of {b} checks passed').replace('{a}', String(passed)).replace('{b}', String(criteria.length))}
                        </>
                    )}
                </span>
        </button>
    );
}
