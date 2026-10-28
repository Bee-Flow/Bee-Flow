import { GraduationCap, Search, Map, RotateCcw, Award, Lock, Check } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { Course, LessonDoc } from '@/api/lessons.types';
import type { CapstoneInfo, LearningNavTarget, LevelInfo, ReviewDue } from './learning.types';
import CourseIcon from './courseIcons';
import { buildCurriculumColumns, splitCapstone } from './curriculum';
import { getLearningPath } from '@/components/onboarding/learningPaths';

interface LearningRailProps {
    t: TranslateFn;
    courses: Course[];
    lessonsOf: (course: Course) => LessonDoc[];
    completedMap: Record<string, boolean>;
    isLocked: (course: Course) => boolean;
    isComplete: (course: Course) => boolean;
    path?: string | null;
    view: string;
    courseId?: string | null;
    reviewDue?: ReviewDue | null;
    levelInfo?: LevelInfo | null;
    capstone?: CapstoneInfo | null;
    onNavigate: (target: LearningNavTarget) => void;
}

/**
 * LearningRail — the 300px rail of the redesigned Learning Center (handoff
 * "Learning Rail.dc.html"). Header tile + counts, a search field, an
 * Alles/Beschikbaar filter, the three fixed rows (Overview / Review /
 * Achievements), then one section per learning path with a row per course
 * carrying a 36px mini-bar, the capstone as its own section, and the level
 * line in the footer.
 *
 * Active row = raised card (bg-card + shadow-sm), the StudioRail convention
 * for a rail that sits against its own border. Locked rows stay clickable —
 * the course screen explains the prerequisite — but read tertiary.
 *
 * Props
 *   courses, lessonsOf(course)      the visible catalog + its lesson resolver
 *   completedMap                     progress
 *   isLocked(course), isComplete(course)
 *   path                             active learning path id
 *   view, courseId                   what is open
 *   reviewDue                        { mistakes, staleLessons, due }
 *   levelInfo                        xpFromProgress result
 *   capstone                         { course, doneCourses, totalCourses, locked }
 *   onNavigate({ view, courseId })
 */
export default function LearningRail({
    t, courses, lessonsOf, completedMap, isLocked, isComplete, path,
    view, courseId, reviewDue, levelInfo, capstone, onNavigate,
}: LearningRailProps) {
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<string>('all'); // 'all' | 'available'

    const { rest } = useMemo(() => splitCapstone(courses), [courses]);
    const columns = useMemo(() => buildCurriculumColumns(rest, path), [rest, path]);
    const totalLessons = useMemo(() => rest.reduce((n, c) => n + lessonsOf(c).length, 0) + (capstone?.course ? lessonsOf(capstone.course).length : 0), [rest, lessonsOf, capstone]);

    const q = query.trim().toLowerCase();
    const matches = (course: Course) => {
        if (filter === 'available' && (isLocked(course) || isComplete(course))) return false;
        if (!q) return true;
        const hay = [t(course.titleKey, course.titleFallback), t(course.badge?.titleKey, course.badge?.titleFallback)]
            .concat(lessonsOf(course).map((l) => t(l.titleKey, l.titleFallback)))
            .join(' ').toLowerCase();
        return hay.includes(q);
    };
    const availableCount = rest.filter((c) => !isLocked(c) && !isComplete(c)).length;

    const rowStyle = (on: boolean, muted?: boolean): CSSProperties => ({
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, minWidth: 0, width: '100%', textAlign: 'left',
        color: on ? 'var(--text-primary)' : (muted ? 'var(--text-tertiary)' : 'var(--text-secondary)'),
        background: on ? 'var(--bg-card)' : 'transparent',
        boxShadow: on ? 'var(--shadow-sm)' : 'none',
        fontWeight: on ? 500 : 400,
    });

    const lvl = levelInfo?.level;
    const next = levelInfo?.next;
    const xp = levelInfo?.xp || 0;
    const spanStart = lvl?.min || 0;
    const spanEnd = next?.min ?? (spanStart + 1);
    const pct = next ? Math.max(0, Math.min(1, (xp - spanStart) / (spanEnd - spanStart))) : 1;

    return (
        <aside
            className="flex-shrink-0 flex flex-col min-h-0 h-full w-[300px] [border-right:1px_solid_var(--border-default)] [font-size:13px] [color:var(--text-primary)] [background:var(--bg-primary)]"
            data-testid="learning-rail"
        >
            {/* Header */}
            <div className="flex items-center gap-2 flex-shrink-0 px-3.5 h-[48px] [border-bottom:1px_solid_var(--border-default)]">
                <div className="grid place-items-center flex-shrink-0 w-[28px] h-[28px] [border-radius:8px] [background:color-mix(in_srgb,var(--accent-primary)_18%,transparent)] [color:var(--accent-primary)]">
                    <GraduationCap className="w-[15px] h-[15px]" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <div className="font-semibold leading-4 text-[14px]">{t('settings.learning_center', 'Learning Center')}</div>
                    <div className="text-[11px] leading-[14px] truncate text-[var(--text-tertiary)]">
                        {t('learn.rail.subtitle', 'Bee Flow Academy · {courses} courses · {lessons} lessons')
                            .replace('{courses}', String(courses.length)).replace('{lessons}', String(totalLessons))}
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 text-[12px] [padding:10px_12px]">
                {/* Search */}
                <label className="flex items-center gap-2 rounded-lg [padding:6px_8px] [border:1px_solid_var(--border-default)] [background:var(--bg-card)] [color:var(--text-tertiary)]">
                    <Search className="w-[13px] h-[13px] [flex-shrink:0]" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('learn.rail.search', 'Search lesson, course or badge…')}
                        aria-label={t('learn.rail.search', 'Search lesson, course or badge…')}
                        className="flex-1 min-w-0 bg-transparent outline-none text-[12px] [color:var(--text-primary)]!"
                    />
                </label>

                {/* All / Available */}
                <div role="radiogroup" aria-label={t('learn.rail.filter', 'Filter courses')} className="flex font-medium [background:var(--bg-tertiary)] [border-radius:8px] [padding:2px] [gap:2px]">
                    {([['all', t('learn.rail.filter_all', 'All'), null], ['available', t('learn.rail.filter_available', 'Available'), availableCount]] as const).map(([id, label, count]) => {
                        const on = filter === id;
                        return (
                            <button key={id} type="button" role="radio" aria-checked={on} onClick={() => setFilter(id)}
                                className="flex-1 text-center rounded-md transition"
                                style={{ padding: '4px 8px', background: on ? 'var(--bg-card)' : 'transparent', boxShadow: on ? 'var(--shadow-sm)' : 'none', color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                {label}{count != null && <> <span className="font-semibold text-[var(--text-primary)]">{count}</span></>}
                            </button>
                        );
                    })}
                </div>

                <nav className="flex flex-col gap-[2px] mt-[2px]" aria-label={t('settings.learning_center', 'Learning Center')}>
                    <button type="button" onClick={() => onNavigate({ view: 'overview' })} style={rowStyle(view === 'overview')} aria-current={view === 'overview' ? 'page' : undefined}>
                        <Map className="w-[14px] h-[14px]" aria-hidden="true" />
                        {t('learn.rail.overview', 'Overview')}
                    </button>
                    <button type="button" onClick={() => onNavigate({ view: 'review' })} style={rowStyle(view === 'review')} aria-current={view === 'review' ? 'page' : undefined}>
                        <RotateCcw className="w-[14px] h-[14px]" aria-hidden="true" />
                        {t('learn.rail.review', 'Review')}
                        {reviewDue?.due ? (
                            <span className="ml-auto text-[11px] font-semibold tabular-nums text-[var(--accent-primary)]">
                                {reviewDue.mistakes + reviewDue.staleLessons}
                            </span>
                        ) : null}
                    </button>
                    <button type="button" onClick={() => onNavigate({ view: 'achievements' })} style={rowStyle(view === 'achievements')} aria-current={view === 'achievements' ? 'page' : undefined}>
                        <Award className="w-[14px] h-[14px]" aria-hidden="true" />
                        {t('learn.rail.achievements', 'Achievements')}
                    </button>

                    {columns.map((col) => {
                        const list = col.courses.filter(matches);
                        if (!list.length) return null;
                        const pathDef = getLearningPath(col.pathId);
                        const heading = pathDef ? t(pathDef.titleKey, pathDef.titleFallback) : t('learn.rail.other_courses', 'Your organisation');
                        return (
                            <React.Fragment key={col.pathId || 'other'}>
                                <SectionHeading>{heading}</SectionHeading>
                                {list.map((course) => {
                                    const lessons = lessonsOf(course);
                                    const locked = isLocked(course);
                                    const on = view === 'course' && courseId === course.id;
                                    const done = lessons.filter((l) => !!completedMap[l.id]).length;
                                    return (
                                        <button key={course.id} type="button" onClick={() => onNavigate({ view: 'course', courseId: course.id })}
                                            style={rowStyle(on, locked)} aria-current={on ? 'page' : undefined}
                                            title={t(course.titleKey, course.titleFallback)}>
                                            <CourseIcon courseId={course.id} size={14} style={{ color: locked ? 'var(--text-tertiary)' : undefined }} />
                                            <span className="truncate">{t(course.titleKey, course.titleFallback)}</span>
                                            <span className="ml-auto inline-flex items-center flex-shrink-0 text-[11px] text-[var(--text-tertiary)]" title={`${done}/${lessons.length}`}>
                                                <RailStatus t={t} locked={locked} complete={isComplete(course)} done={done} total={lessons.length} />
                                            </span>
                                        </button>
                                    );
                                })}
                            </React.Fragment>
                        );
                    })}

                    {capstone?.course && matches(capstone.course) && (
                        <>
                            <SectionHeading>{t('learn.rail.capstone', 'Capstone')}</SectionHeading>
                            <button type="button" onClick={() => onNavigate({ view: 'course', courseId: capstone.course.id })}
                                style={rowStyle(view === 'course' && courseId === capstone.course.id, capstone.locked)}
                                aria-current={view === 'course' && courseId === capstone.course.id ? 'page' : undefined}>
                                <CourseIcon courseId={capstone.course.id} size={14} style={{ color: capstone.locked ? 'var(--text-tertiary)' : undefined }} />
                                <span className="truncate">{t(capstone.course.titleKey, capstone.course.titleFallback)}</span>
                                <span className="ml-auto inline-flex items-center flex-shrink-0 text-[11px] text-[var(--text-tertiary)]"
                                    title={t('learn.rail.capstone_progress', '{a}/{b} courses').replace('{a}', String(capstone.doneCourses)).replace('{b}', String(capstone.totalCourses))}>
                                    <RailStatus t={t} locked={capstone.locked} complete={isComplete(capstone.course)}
                                        done={capstone.doneCourses} total={capstone.totalCourses} />
                                </span>
                            </button>
                        </>
                    )}
                </nav>
            </div>

            {/* Footer: level line */}
            {lvl && (
                <div className="flex-shrink-0 flex flex-col gap-[5px] text-[11px] [padding:10px_14px] [border-top:1px_solid_var(--border-default)] [color:var(--text-tertiary)]!">
                    <div className="flex items-center gap-1.5">
                        <span className="text-[12px]" aria-hidden="true">🐝</span>
                        <span className="font-semibold text-[var(--text-primary)]">{t(`learn.level.${lvl.key}`, lvl.titleFallback)}</span>
                        <span className="ml-auto truncate">
                            {next
                                ? t('learn.xp.to_next', '{xp} XP · {n} to {level}').replace('{xp}', String(xp)).replace('{n}', String(spanEnd - xp)).replace('{level}', t(`learn.level.${next.key}`, next.titleFallback))
                                : t('learn.xp.max', '{xp} XP · top level!').replace('{xp}', String(xp))}
                        </span>
                    </div>
                    <div className="overflow-hidden h-[4px] [border-radius:2px] [background:var(--bg-tertiary)]">
                        <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: 'var(--accent-primary)' }} />
                    </div>
                </div>
            )}
        </aside>
    );
}

function SectionHeading({ children }: { children?: ReactNode }) {
    return (
        <div className="uppercase font-semibold [font-size:10px] [letter-spacing:.08em] [color:var(--text-tertiary)] [padding:10px_8px_4px]">
            {children}
        </div>
    );
}

interface RailStatusProps {
    t: TranslateFn;
    locked: boolean;
    complete: boolean;
    done: number;
    total: number;
}

/**
 * The rail's one status per row — the same vocabulary as the overview, so a
 * course does not report its progress one way in the rail and another in the
 * list beside it. A 36px segmented bar was readable on a card; at rail width,
 * next to a truncated title, it was texture.
 */
function RailStatus({ t, locked, complete, done, total }: RailStatusProps) {
    if (complete) return <Check className="w-[14px] h-[14px] [color:var(--learn-complete)]" aria-label={t('learn.state.complete', 'complete')} />;
    if (locked) return <Lock className="w-[12px] h-[12px]" aria-hidden="true" />;
    if (done > 0) return <>{t('learn.course.n_of_m', '{a} of {b}').replace('{a}', String(done)).replace('{b}', String(total))}</>;
    return null;
}
