import { Map, Footprints, Ellipsis, RotateCcw, Award } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { readLearningPath, mirrorLearningPath, saveLearningPath } from '../../api/learningPath';
import { orderCoursesForPath } from '../../components/onboarding/learningPaths';
import { fetchCatalog } from '../../api/catalogClient';
import { fetchAchievements, issueCertificate } from '../../api/achievements';
import { getActionCheck, runActionCheck, applicableCriteria } from '../../components/onboarding/actionChecks';
import LearningRail from './learning/LearningRail';
import LearningHeader, { HeaderTile, PathChip } from './learning/LearningHeader';
import OverviewView from './learning/OverviewView';
import CourseView from './learning/CourseView';
import AchievementsView from './learning/AchievementsView';
import ReviewView from './learning/ReviewView';
import CertificateDrawer from './learning/CertificateDrawer';
import { IconSquareButton, SecondaryButton } from './learning/bits';
import { splitCapstone, nextLessonIn, CAPSTONE_CHECK_ID } from './learning/curriculum';
import { LEARNING_NAVIGATE_EVENT, takePendingLearningNavigate } from './learning/learningEvents';
import { useLicenseContext } from '../../components/licensing/LicenseContext';
import {
    resolveCourses,
    courseLessons,
    isCourseComplete,
    completedCourseIds,
    courseLocked,
    earnedBadgesFromProgress,
    xpFromProgress,
    getCourse,
    getCertificate,
    applyServerCatalog,
    catalogVersion,
} from '../../components/onboarding/courses';
import {
    readLearningProgress,
    lessonEntryComplete,
    lessonEntryMastered,
    resetLearningProgress,
} from '../../components/onboarding/learningProgress';
import {
    LESSON_COMPLETE_EVENT,
    LESSON_PLAYER_OPEN_EVENT,
    registerServerLessons,
    registerEphemeralLesson,
    getLesson,
} from '../../components/onboarding/lessons';
import { generatePractice } from '../../components/onboarding/practiceClient';
import {
    countReviewDue,
    buildReviewSession,
    lessonPracticeSteps,
    practiceItemToQuizStep,
    PRACTICE_LESSON_IDS,
    REVIEW_SESSION_SIZE,
} from '../../components/onboarding/reviewEngine';
import { TOUR_START_EVENT } from '../../components/onboarding/tourSteps';
import AnchoredMenu from '../../components/shared/AnchoredMenu';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { ProgressMap, Course, PracticeItem, ServerLessonDoc } from '../../api/lessons.types';
import type { LocaleCoverage } from '../../components/admin/product-website/shell/LocaleMenu';
import type { SettingsUser } from './shell/settingsShellTypes';
import type { LearningNavTarget } from './learning/learning.types';
import type { StudioSectionHeaderTab } from '../../components/projects/workspace/studioParts';
import type { CertificateRecord, LearningCenterSectionProps } from './LearningCenterSection.types';
import { logger } from '../../utils/logger';
/**
 * LearningCenterSection — "Bee Flow Academy", redesigned (handoff "Learning
 * Center.dc.html", Sep 2026): the same shell as Compliance — a 300px rail, a
 * 48px header, tables, a drawer — in place of one 768px column.
 *
 *   overview      one hero with two actions (continue + review) and the
 *                 curriculum map: three path columns + the capstone
 *   course/<id>   a course as its own screen with the lessons as a table
 *   review        what is due and the two lists behind it
 *   achievements  level line, badges as rows, certificates with what is missing
 *
 * Data stays exactly what it was: per-lesson progress (server-authoritative,
 * mirrored locally), the server-overlayable catalog, the achievements
 * endpoint for certificates, the review engine for sessions. Only the
 * presentation changed — plus one addition: a lesson can be opened "beside
 * the app" straight from the hero and the table (LESSON_PLAYER_OPEN_EVENT
 * carries a `layout`).
 */

function computeCompletedMap(progressMap: ProgressMap) {
    const map: Record<string, boolean> = {};
    Object.keys(progressMap || {}).forEach((id) => { if (lessonEntryComplete(progressMap[id])) map[id] = true; });
    return map;
}
function computeMasteredMap(progressMap: ProgressMap) {
    const map: Record<string, boolean> = {};
    Object.keys(progressMap || {}).forEach((id) => { if (lessonEntryMastered(progressMap[id])) map[id] = true; });
    return map;
}
// How long we wait for AI practice items before starting a review without them.
const PRACTICE_SOFT_TIMEOUT_MS = 4000;

const TAB_VIEWS = ['overview', 'review', 'achievements'];

export default function LearningCenterSection({ user }: LearningCenterSectionProps) {
    const { t, locale } = useTranslation();
    const { hasFeature } = useLicenseContext();
    const [completedMap, setCompletedMap] = useState<Record<string, boolean>>({});
    const [masteredMap, setMasteredMap] = useState<Record<string, boolean>>({});
    const [progressMap, setProgressMap] = useState<ProgressMap>({});
    const [certificates, setCertificates] = useState<{ certificateId: string; title: string; level: string; eligible: boolean; issued: boolean; isPublic: boolean; progress: LocaleCoverage; courseIds: string[] }[]>([]);
    const [earnedBadges, setEarnedBadges] = useState([]);
    const [certModal, setCertModal] = useState<CertificateRecord | null>(null);
    const [busyCertId, setBusyCertId] = useState<string | null>(null);
    const [catVersion, setCatVersion] = useState(() => catalogVersion());
    const [path, setPath] = useState(() => readLearningPath(user));
    const [reviewBuilding, setReviewBuilding] = useState(false);
    const [practiceIds, setPracticeIds] = useState(() => new Set(PRACTICE_LESSON_IDS));
    const [nav, setNav] = useState<LearningNavTarget>(() => takePendingLearningNavigate() || { view: 'overview' });
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLButtonElement>(null);
    const reviewBusyRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    // Server catalog overlay (structure + org courses + practiceable ids).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const serverCatalog = await fetchCatalog();
            if (cancelled || !serverCatalog) return;
            const orgLessons = (serverCatalog.courses || [])
                .filter((c) => Array.isArray(c.lessons))
                .flatMap((c) => c.lessons as ServerLessonDoc[]);
            if (orgLessons.length) registerServerLessons(orgLessons);
            if (Array.isArray(serverCatalog.practiceLessonIds) && serverCatalog.practiceLessonIds.length) {
                setPracticeIds(new Set(serverCatalog.practiceLessonIds));
            }
            if (applyServerCatalog(serverCatalog)) setCatVersion(catalogVersion());
        })();
        return () => { cancelled = true; };
    }, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catVersion invalidates the module-level catalog
    const visibleCourses = useMemo(() => resolveCourses(user, { hasFeature }), [user, hasFeature, catVersion]);
    const courses = useMemo(() => orderCoursesForPath(visibleCourses, path), [visibleCourses, path]);
    const lessonsOf = useCallback((course: Course | null) => courseLessons(course, user, hasFeature), [user, hasFeature]);

    const loadAchievements = useCallback(async () => {
        const data = await fetchAchievements();
        if (data?.certificates) {
            // The panel says what is still missing per certificate: the courses
            // of its track, resolved from the client catalog.
            setCertificates(data.certificates.map((c: { certificateId: string; }) => {
                const def = getCertificate(c.certificateId);
                const courseIds = def?.track ? resolveCourses(user, { hasFeature }).filter((x) => x.track === def.track).map((x) => x.id) : [];
                return { ...c, courseIds };
            }));
        }
        if (Array.isArray(data?.badges)) setEarnedBadges(data.badges);
    }, [user, hasFeature]);

    const refreshLocalProgress = useCallback(() => {
        const progress = readLearningProgress(user);
        setProgressMap(progress);
        setCompletedMap(computeCompletedMap(progress));
        setMasteredMap(computeMasteredMap(progress));
    }, [user]);
    // Seed from the local mirror, then hydrate from the server (authoritative).
    // Once per user id: the seed and the mirror read the current user.
    const seedFromLocal = useEffectEvent(() => refreshLocalProgress());
    const mirrorPath = useEffectEvent((path: string) => mirrorLearningPath(user, path));
    useEffect(() => {
        let cancelled = false;
        seedFromLocal();
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/user-settings`);
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (cancelled) return;
                setProgressMap(data?.learningProgress || {});
                setCompletedMap(computeCompletedMap(data?.learningProgress));
                setMasteredMap(computeMasteredMap(data?.learningProgress));
                if (typeof data?.learningPath === 'string' && data.learningPath) {
                    mirrorPath(data.learningPath);
                    setPath(data.learningPath);
                }
            } catch (err) { logger.debug('keep the local seed', err); }
        })();
        return () => { cancelled = true; };
    }, [user?.id]);

    useEffect(() => { loadAchievements(); }, [user?.id, loadAchievements]);

    useEffect(() => {
        const onDone = () => { refreshLocalProgress(); loadAchievements(); };
        window.addEventListener(LESSON_COMPLETE_EVENT, onDone);
        return () => window.removeEventListener(LESSON_COMPLETE_EVENT, onDone);
    }, [refreshLocalProgress, loadAchievements]);
    // "Back to the course" from the player's completion screen.
    useEffect(() => {
        const onNav = (e: CustomEvent<LearningNavTarget>) => { if (e?.detail?.view) setNav(e.detail); };
        window.addEventListener(LEARNING_NAVIGATE_EVENT, onNav as EventListener);
        return () => window.removeEventListener(LEARNING_NAVIGATE_EVENT, onNav as EventListener);
    }, []);

    // A new screen starts at the top.
    useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [nav.view, nav.courseId]);

    /* eslint-disable react-hooks/exhaustive-deps -- catVersion invalidates the module-level catalog */
    const doneCourseIds = useMemo(() => completedCourseIds(completedMap, user, hasFeature), [completedMap, user, hasFeature, catVersion]);
    const earnedBadgeIds = useMemo(
        () => new Set(earnedBadgesFromProgress(completedMap, user, hasFeature).map((b) => b.id)),
        [completedMap, user, hasFeature, catVersion],
    );
    const levelInfo = useMemo(() => xpFromProgress(completedMap, user, hasFeature, masteredMap), [completedMap, masteredMap, user, hasFeature, catVersion]);
    /* eslint-enable react-hooks/exhaustive-deps */

    const reviewDue = useMemo(() => countReviewDue(progressMap, getLesson), [progressMap]);
    const isLocked = useCallback((course: Course | null) => courseLocked(course, doneCourseIds), [doneCourseIds]);
    const isComplete = useCallback((course: Course | null) => isCourseComplete(course, completedMap, user, hasFeature), [completedMap, user, hasFeature]);
    const lockedReasonFor = useCallback((course: Course) => {
        const blocker = (course.prereqCourseIds || []).map(getCourse).find((c) => c && !doneCourseIds.includes(c.id));
        return blocker ? t('learn.course.locked_reason', 'Complete {course} first').replace('{course}', t(blocker.titleKey, blocker.titleFallback)) : '';
    }, [doneCourseIds, t]);

    const startLesson = useCallback((lessonId: string, courseId: string | null, opts: { layout?: string } = {}) => {
        window.dispatchEvent(new CustomEvent(LESSON_PLAYER_OPEN_EVENT, { detail: { lessonId, courseId, layout: opts.layout || null } }));
    }, []);

    /* ── Review & practice sessions ──────────────────────────────────────── */

    const fetchPracticeItems = useCallback(async (lessonIds: string[], count: number) => {
        const wanted = lessonIds.filter((id) => practiceIds.has(id));
        if (!wanted.length || count <= 0) return { items: [], practiceId: null };
        const result = await Promise.race([
            generatePractice({ lessonIds: wanted, count, locale }),
            new Promise<null>((resolve) => { setTimeout(() => resolve(null), PRACTICE_SOFT_TIMEOUT_MS); }),
        ]);
        return result?.items?.length ? { items: result.items, practiceId: result.practiceId } : { items: [], practiceId: null };
    }, [practiceIds, locale]);

    const startReview = useCallback(async () => {
        if (reviewBusyRef.current) return;
        reviewBusyRef.current = true;
        setReviewBuilding(true);
        try {
            const progress = readLearningProgress(user);
            const dry = buildReviewSession({ progressMap: progress, getLessonFn: getLesson });
            const room = Math.max(0, REVIEW_SESSION_SIZE - dry.steps.length);
            const { items, practiceId } = await fetchPracticeItems(dry.sourceLessonIds, Math.min(room || 2, 3));
            const { steps } = buildReviewSession({ progressMap: progress, getLessonFn: getLesson, practiceItems: items, practiceId });
            if (!steps.length) return;
            const id = registerEphemeralLesson({
                titleFallback: t('learn.review.session_title', 'Review session'),
                icon: '🧠', kind: 'review', steps,
            });
            startLesson(id, null);
        } finally {
            reviewBusyRef.current = false;
            setReviewBuilding(false);
        }
    }, [user, fetchPracticeItems, startLesson, t]);

    const startPractice = useCallback(async (lessonId: string) => {
        if (reviewBusyRef.current) return;
        reviewBusyRef.current = true;
        setReviewBuilding(true);
        try {
            const lesson = getLesson(lessonId);
            if (!lesson) return;
            const { items, practiceId } = await fetchPracticeItems([lessonId], 3);
            const steps = items.length
                ? items.map((item: PracticeItem) => practiceItemToQuizStep(item, practiceId))
                : lessonPracticeSteps(lesson);
            if (!steps.length) return;
            const id = registerEphemeralLesson({
                titleFallback: t('learn.practice.session_title', 'Practice: {lesson}').replace('{lesson}', t(lesson.titleKey, lesson.titleFallback)),
                icon: '✨', kind: 'review', steps,
            });
            startLesson(id, null);
        } finally {
            reviewBusyRef.current = false;
            setReviewBuilding(false);
        }
    }, [fetchPracticeItems, startLesson, t]);

    /* ── Path, reset, certificates ───────────────────────────────────────── */

    const onPickPath = useCallback(async (pathId: string) => {
        setPath(pathId);
        try { await saveLearningPath(user, pathId); } catch (err) { logger.debug('mirrored locally', err); }
    }, [user]);

    const onReset = useCallback(async () => {
        setMenuOpen(false);
        setCompletedMap({});
        setMasteredMap({});
        setProgressMap({});
        try { await resetLearningProgress(user); } catch (err) { logger.debug('best-effort', err); }
        loadAchievements();
    }, [user, loadAchievements]);

    const onEarnCert = useCallback(async (cert: { certificateId: string }) => {
        setBusyCertId(cert.certificateId);
        try {
            const issued = await issueCertificate(cert.certificateId, { makePublic: false });
            setCertModal(issued);
            await loadAchievements();
        } catch (err) { logger.debug('surfaced by the disabled state; user can retry', err); }
        finally { setBusyCertId(null); }
    }, [loadAchievements]);

    const onViewCert = useCallback((cert: CertificateRecord) => setCertModal(cert), []);

    const onTogglePublic = useCallback(async (makePublic: boolean) => {
        if (!certModal) return;
        setBusyCertId(certModal.certificateId);
        try {
            const updated = await issueCertificate(certModal.certificateId, { makePublic });
            setCertModal(updated);
            await loadAchievements();
        } catch (err) { logger.debug('keep current modal state', err); }
        finally { setBusyCertId(null); }
    }, [certModal, loadAchievements]);

    /* ── Derived for the screens ─────────────────────────────────────────── */

    // "Continue where you left off" — the first not-complete lesson in the first
    // unlocked, incomplete course, in PATH order.
    const continueTarget = useMemo(() => {
        for (const course of courses) {
            if (isLocked(course) || isComplete(course)) continue;
            const lessons = lessonsOf(course);
            const next = nextLessonIn(lessons, completedMap);
            if (next) return { course, lesson: next.lesson, index: next.index, total: lessons.length };
        }
        return null;
    }, [courses, isLocked, isComplete, lessonsOf, completedMap]);

    const { capstone: capstoneCourse, rest: nonCapstone } = useMemo(() => splitCapstone(courses), [courses]);
    const capstone = useMemo(() => (capstoneCourse ? {
        course: capstoneCourse,
        doneCourses: nonCapstone.filter(isComplete).length,
        totalCourses: nonCapstone.length,
        locked: isLocked(capstoneCourse),
    } : null), [capstoneCourse, nonCapstone, isComplete, isLocked]);

    // The capstone's live checks, for the achievements table ("1/4 checks").
    const [capstoneChecks, setCapstoneChecks] = useState<{ done: number; total: number; } | null>(null);
    useEffect(() => {
        if (nav.view !== 'achievements' || !capstoneCourse) return undefined;
        let cancelled = false;
        (async () => {
            const check = getActionCheck(CAPSTONE_CHECK_ID);
            const ctx = { user, hasFeature };
            const criteria = applicableCriteria(check, ctx);
            const r = await runActionCheck(CAPSTONE_CHECK_ID, ctx);
            if (cancelled) return;
            const passed = criteria.filter((c) => r.passes?.[c.id]).length;
            setCapstoneChecks({ done: (isComplete(capstoneCourse) ? criteria.length : passed) + (nonCapstone.every(isComplete) ? 1 : 0), total: criteria.length + 1 });
        })();
        return () => { cancelled = true; };
    }, [nav.view, capstoneCourse, user, hasFeature, isComplete, nonCapstone]);

    const anyProgress = Object.keys(completedMap).length > 0;
    const goto = useCallback((next: LearningNavTarget | { view: string; }) => setNav(next), []);
    const openCourse = useCallback((courseId: string) => setNav({ view: 'course', courseId }), []);
    const openLesson = useCallback((lessonId: string) => {
        const course = courses.find((c) => lessonsOf(c).some((l) => l.id === lessonId)) || null;
        startLesson(lessonId, course?.id || null);
    }, [courses, lessonsOf, startLesson]);

    const tabs: StudioSectionHeaderTab[] = [
        { id: 'overview', label: t('learn.tabs.curriculum', 'Curriculum') },
        { id: 'review', label: t('learn.rail.review', 'Review'), count: reviewDue.due ? reviewDue.mistakes + reviewDue.staleLessons : undefined, tone: 'warning' },
        { id: 'achievements', label: t('learn.rail.achievements', 'Achievements') },
    ];

    const headerTitle = nav.view === 'review' ? t('learn.rail.review', 'Review')
        : nav.view === 'achievements' ? t('learn.rail.achievements', 'Achievements')
            : t('learn.rail.overview', 'Overview');
    const headerIcon = nav.view === 'review' ? RotateCcw : nav.view === 'achievements' ? Award : Map;

    const courseNav = nav.view === 'course' ? courses.find((c) => c.id === nav.courseId) : null;

    if (courses.length === 0) {
        return (
            <div className="h-full flex items-center justify-center p-8">
                <div className="rounded-xl border p-8 text-sm text-center border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-muted)]">
                    {t('settings.learning_empty', 'No lessons available for your account yet.')}
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 bg-[var(--bg-primary)]" data-testid="learning-center">
            <LearningRail
                t={t} courses={courses} lessonsOf={lessonsOf} completedMap={completedMap}
                isLocked={isLocked} isComplete={isComplete} path={path}
                view={nav.view} courseId={nav.courseId} reviewDue={reviewDue}
                levelInfo={levelInfo} capstone={capstone} onNavigate={goto}
            />

            <div className="flex-1 min-w-0 flex flex-col min-h-0">
                {courseNav ? (
                    <CourseView
                        t={t} locale={locale} course={courseNav} lessons={lessonsOf(courseNav)}
                        progressMap={progressMap} completedMap={completedMap} masteredMap={masteredMap}
                        locked={isLocked(courseNav)} lockedReason={lockedReasonFor(courseNav)}
                        practiceableIds={practiceIds} reviewBuilding={reviewBuilding}
                        onBack={() => goto({ view: 'overview' })}
                        onStartLesson={(lessonId: string, opts?: { layout: string }) => startLesson(lessonId, courseNav.id, opts)}
                        onPractice={startPractice}
                    />
                ) : (
                    <>
                        <LearningHeader
                            t={t}
                            tile={<HeaderTile icon={headerIcon} />}
                            title={headerTitle}
                            chips={<PathChip t={t} path={path === 'skipped' ? null : path} onPick={onPickPath} />}
                            tabs={tabs}
                            activeTab={TAB_VIEWS.includes(nav.view) ? nav.view : 'overview'}
                            onTab={(id) => goto({ view: id })}
                            actions={(
                                <>
                                    <SecondaryButton onClick={() => window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { returnTo: 'settings/learning' } }))} title={t('settings.learning_take_tour', 'Replay the welcome tour')}>
                                        <Footprints className="w-[13px] h-[13px]" aria-hidden="true" />{t('learn.tour_button', 'Tour')}
                                    </SecondaryButton>
                                    <IconSquareButton ref={menuRef} onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('learn.more', 'More')}>
                                        <Ellipsis className="w-[14px] h-[14px]" />
                                    </IconSquareButton>
                                    <AnchoredMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} align="right" width={220} role="menu" aria-label={t('learn.more', 'More')} className="py-1">
                                        <button type="button" role="menuitem" onClick={onReset} disabled={!anyProgress}
                                            className="w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 hover:bg-[var(--bg-secondary)] disabled:opacity-50 text-[var(--text-primary)]">
                                            <RotateCcw size={13} aria-hidden="true" />{t('settings.learning_reset', 'Reset progress')}
                                        </button>
                                    </AnchoredMenu>
                                </>
                            )}
                        />
                        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
                            {nav.view === 'review' ? (
                                <ReviewView t={t} locale={locale} progressMap={progressMap} reviewDue={reviewDue} reviewBuilding={reviewBuilding}
                                    practiceableIds={practiceIds} onStartReview={startReview} onPractice={startPractice} onOpenLesson={openLesson} />
                            ) : nav.view === 'achievements' ? (
                                <AchievementsView t={t} locale={locale} courses={courses} lessonsOf={lessonsOf}
                                    completedMap={completedMap} masteredMap={masteredMap} isLocked={isLocked} isComplete={isComplete} lockedReasonFor={lockedReasonFor}
                                    earnedBadges={earnedBadges.length ? earnedBadges : [...earnedBadgeIds].map((id) => ({ badgeId: id }))}
                                    certificates={certificates} levelInfo={levelInfo} busyCertId={busyCertId}
                                    onEarnCert={onEarnCert} onViewCert={onViewCert} onOpenCourse={openCourse} capstoneChecks={capstoneChecks} />
                            ) : (
                                <OverviewView t={t} user={user} hasFeature={hasFeature} courses={courses} lessonsOf={lessonsOf}
                                    completedMap={completedMap} isLocked={isLocked} isComplete={isComplete} lockedReasonFor={lockedReasonFor}
                                    path={path === 'skipped' ? null : path}
                                    continueTarget={continueTarget} reviewDue={reviewDue} reviewBuilding={reviewBuilding}
                                    onStartLesson={startLesson} onStartReview={startReview} onOpenCourse={openCourse} />
                            )}
                        </div>
                    </>
                )}
            </div>

            {certModal && (
                <CertificateDrawer cert={certModal} busy={busyCertId === certModal.certificateId}
                    onTogglePublic={onTogglePublic} onClose={() => setCertModal(null)} t={t} />
            )}
        </div>
    );
}
