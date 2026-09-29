import { X, ArrowLeft, ArrowRight, Check, Lock, PartyPopper, Sparkles, Minus, PanelRight, Maximize2, AppWindow, CircleCheck, Loader2, Award, Play } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../../hooks/useTranslation';
import { StepKindIcon, stepKindLabel } from '../../../pages/settings/learning/bits';
import { requestLearningNavigate } from '../../../pages/settings/learning/learningEvents';
import { useLicenseContext } from '../../licensing/LicenseContext';
import { PRIMARY_ACTION_STYLE } from '../../shared/StudioSectionHeader';
import { getCourse, courseLessons } from '../courses';
import {
    markLessonComplete, markLessonMastered, saveStepState, readStepState,
    readLearningProgress, recordReviewOutcome,
} from '../learningProgress';
import {
    getLesson,
    resolveLessonPlayerSteps,
    registerEphemeralTour,
    clearEphemeralTour,
    clearEphemeralLesson,
    isEphemeralLessonId,
    TOUR_START_EVENT,
    LESSON_COMPLETE_EVENT,
    LESSON_PLAYER_OPEN_EVENT,
} from '../lessons';
import { lessonRunWasClean, reviewMasteryUpdates, deriveOutcomeWrite } from '../reviewEngine';
import { stepType, STEP_TYPES, stepIsRequired, stepStatusSatisfies } from '../stepTypes';
import ActionStep from './ActionStep';
import ExerciseStep from './ExerciseStep';
import {
    LAYOUTS, resolveInitialLayout, readDockPref, saveDockPref, isMobileViewport,
} from './playerLayout';
import QuizStep from './QuizStep';
import SimStep from './SimStep';
import SlideStep from './SlideStep';
import TutorPanel from './TutorPanel';

/**
 * LessonPlayer — the focused surface for a rich lesson (slides / quizzes /
 * AI-graded exercises / interactive sims / verified hands-on actions).
 *
 * Live-app "tour" steps are NOT rendered here: the player slices the contiguous
 * run of tour steps, registers it as an ephemeral tour, hands off to the
 * existing OnboardingTour engine (TOUR_START_EVENT), renders nothing while the
 * spotlight runs, and resumes when the engine fires LESSON_COMPLETE_EVENT for
 * that ephemeral id. This keeps OnboardingTour.jsx unchanged.
 *
 * v2 additions on top of resume/tutor/minimize:
 *   • LAYOUTS — beside the classic centered modal the player can DOCK as a
 *     420px right-side panel with the app interactive next to it (the
 *     "learn-along" mode). Preference persists per user; lessons with
 *     action/tour steps dock by default; mobile is always modal.
 *   • REVIEW SESSIONS — an ephemeral lesson (kind 'review') built by
 *     reviewEngine replays real quiz/sim items. Answers write back to each
 *     item's ORIGIN step (a first-try pass clears the mistake there), and
 *     finishing runs the mastery math for the source lessons.
 *   • MASTERY — finishing a real lesson with every quiz/sim passed first-try
 *     stamps masteredAt beside completedAt (gold state + bonus XP).
 *
 * Props:
 *   lessonId, courseId — what to play
 *   user               — current user (gates Studio-only steps, scopes progress)
 *   modelTier          — tier for the AI coach (default 'fast')
 *   onNavigate         — App's navigateToPage (used by action-step launch)
 *   onClose()          — dismiss the player (progress already saved per step)
 *   onComplete(id) -> Promise<{ newBadges, courseComplete, courseTitle }|void>
 */
export default function LessonPlayer({ lessonId, courseId = null, initialLayout = null, user, modelTier = 'fast', onNavigate, onClose, onComplete }) {
    const { t } = useTranslation();
    const { hasFeature } = useLicenseContext();
    const lesson = useMemo(() => getLesson(lessonId), [lessonId]);
    const steps = useMemo(() => resolveLessonPlayerSteps(lessonId, user), [lessonId, user]);
    const isReview = lesson?.kind === 'review';

    const [statusMap, setStatusMap] = useState(() => readStepState(user, lessonId));
    const statusMapRef = useRef(statusMap);
    useEffect(() => { statusMapRef.current = statusMap; }, [statusMap]);

    // Resume where the learner left off — reopening a half-done lesson (e.g.
    // after leaving to do a hands-on task) must not restart from the top. We
    // resume at the first required step without a passing state, but never jump
    // past steps the learner hasn't seen: the furthest step with any saved
    // state bounds the resume point (slides/tours record nothing, so +1 lets
    // the learner continue from just after their last graded step). A lesson
    // with no saved state, or one that is fully satisfied (a replay), starts
    // from the top.
    const [stepIndex, setStepIndex] = useState(() => {
        const saved = readStepState(user, lessonId);
        const savedIndexes = steps
            .map((s, i) => (saved[s.id] ? i : -1))
            .filter((i) => i !== -1);
        if (!savedIndexes.length) return 0;
        const firstUnsatisfied = steps.findIndex(
            (s) => stepIsRequired(s) && !stepStatusSatisfies(s, saved[s.id]?.status),
        );
        if (firstUnsatisfied === -1) return 0; // everything satisfied → replay
        return Math.min(firstUnsatisfied, Math.max(...savedIndexes) + 1, steps.length - 1);
    });
    const [handoff, setHandoff] = useState(null); // { ephemeralId, resumeIndex }
    const [finished, setFinished] = useState(false);
    const [celebration, setCelebration] = useState(null);
    const [minimized, setMinimized] = useState(false);
    const [tutorOpen, setTutorOpen] = useState(false);

    // Learn-along layout: docked panel vs centered modal (playerLayout.js).
    const [mobile] = useState(() => isMobileViewport());
    // An explicit "Beside the app" / "Play" from the Learning Center wins over
    // the stored preference for this opening (and becomes the preference).
    const [layout, setLayoutState] = useState(() => {
        if (initialLayout === LAYOUTS.DOCKED || initialLayout === LAYOUTS.MODAL) {
            saveDockPref(user, initialLayout);
            return resolveInitialLayout(steps, initialLayout, isMobileViewport());
        }
        return resolveInitialLayout(steps, readDockPref(user), isMobileViewport());
    });
    const docked = layout === LAYOUTS.DOCKED;
    const switchLayout = useCallback((next) => {
        setLayoutState(next);
        saveDockPref(user, next);
    }, [user]);

    const handoffRef = useRef(null);
    useEffect(() => { handoffRef.current = handoff; }, [handoff]);

    // Review sessions are throwaway lessons — drop the registry entry when the
    // player unmounts so the map stays bounded.
    useEffect(() => () => { if (isEphemeralLessonId(lessonId)) clearEphemeralLesson(lessonId); }, [lessonId]);

    const step = steps[stepIndex] || null;
    const total = steps.length;

    const recordStatus = useCallback((stepId, state) => {
        setStatusMap((prev) => ({ ...prev, [stepId]: state }));
        saveStepState(user, lessonId, stepId, state); // no-ops for ephemeral ids
        // Review answers persist at their ORIGIN step: a first-try pass clears
        // the mistake there, a wrong answer refreshes it. Incremental, so an
        // abandoned session keeps its partial wins.
        if (isEphemeralLessonId(lessonId)) {
            const stepDoc = steps.find((s) => s.id === stepId);
            const outcome = stepDoc ? deriveOutcomeWrite(stepDoc, state) : null;
            if (outcome) recordReviewOutcome(user, stepDoc.origin, outcome.write);
        }
    }, [user, lessonId, steps]);

    // Whether the learner may advance past the current step.
    const canAdvance = useCallback((s) => {
        if (!s) return false;
        if (!stepIsRequired(s)) return true;
        return stepStatusSatisfies(s, statusMap[s.id]?.status);
    }, [statusMap]);

    const finishLesson = useCallback(async () => {
        setFinished(true);
        setMinimized(false);
        const stateMap = statusMapRef.current;

        if (isReview) {
            // Mastery math for the source lessons — against the progress map as
            // it stands AFTER this session's incremental write-backs.
            let masteredTitles = [];
            try {
                const progressMap = readLearningProgress(user);
                const masteredIds = reviewMasteryUpdates({
                    sessionSteps: steps, statusMap: stateMap, progressMap, getLessonFn: getLesson,
                });
                for (const id of masteredIds) {
                    try { await markLessonMastered(user, id); } catch (_) { /* best-effort */ }
                }
                masteredTitles = masteredIds
                    .map((id) => { const l = getLesson(id); return l ? t(l.titleKey, l.titleFallback) : null; })
                    .filter(Boolean);
            } catch (_) { /* celebration only — never block the finish */ }
            setCelebration({ review: true, masteredTitles });
            try { window.dispatchEvent(new CustomEvent(LESSON_COMPLETE_EVENT, { detail: { lessonId } })); } catch (_) { /* ignore */ }
            return;
        }

        let mastered = false;
        try { await markLessonComplete(user, lessonId); } catch (_) { /* best-effort */ }
        try {
            if (lessonRunWasClean(steps, stateMap)) {
                await markLessonMastered(user, lessonId);
                mastered = true;
            }
        } catch (_) { /* mastery is a bonus — never block completion */ }
        try { window.dispatchEvent(new CustomEvent(LESSON_COMPLETE_EVENT, { detail: { lessonId } })); } catch (_) { /* ignore */ }
        try {
            const info = onComplete ? await onComplete(lessonId) : null;
            setCelebration({ ...(info || {}), mastered });
        } catch (_) {
            setCelebration({ mastered });
        }
    }, [user, lessonId, onComplete, isReview, steps, t]);

    const goToIndex = useCallback((idx) => {
        if (idx >= total) { finishLesson(); return; }
        setStepIndex(Math.max(0, idx));
    }, [total, finishLesson]);

    const advance = useCallback(() => {
        if (!canAdvance(step)) return;
        goToIndex(stepIndex + 1);
    }, [canAdvance, step, goToIndex, stepIndex]);

    const back = useCallback(() => {
        if (handoff) return;
        setStepIndex((i) => Math.max(0, i - 1));
    }, [handoff]);

    // Action-step launch: take the learner to the real surface. In modal mode
    // the player collapses to the floating pill; docked mode is the whole point
    // of working beside the panel, so it stays put.
    const launchAction = useCallback((navigateTo) => {
        if (!docked) setMinimized(true);
        try { onNavigate?.(navigateTo); } catch (_) { /* ignore */ }
    }, [onNavigate, docked]);

    // When the current step is a live tour step, gather the contiguous run and
    // hand it off to the engine.
    useEffect(() => {
        if (finished || handoff) return;
        const cur = steps[stepIndex];
        if (!cur || stepType(cur) !== STEP_TYPES.TOUR) return;
        let end = stepIndex;
        while (end < steps.length && stepType(steps[end]) === STEP_TYPES.TOUR) end += 1;
        const run = steps.slice(stepIndex, end);
        const ephemeralId = registerEphemeralTour(run);
        setHandoff({ ephemeralId, resumeIndex: end });
    }, [stepIndex, steps, handoff, finished]);

    // Dispatch the handoff AFTER our chrome unmounts (render returns null while
    // handoff is set), so the spotlight isn't hidden behind the player backdrop.
    useEffect(() => {
        if (!handoff) return undefined;
        const raf = requestAnimationFrame(() => {
            try { window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { lessonId: handoff.ephemeralId } })); } catch (_) { /* ignore */ }
        });
        return () => cancelAnimationFrame(raf);
    }, [handoff]);

    // Resume when the engine finishes our ephemeral tour segment.
    useEffect(() => {
        const onDone = (e) => {
            const id = e?.detail?.lessonId;
            const h = handoffRef.current;
            if (h && id === h.ephemeralId) {
                clearEphemeralTour(id);
                setHandoff(null);
                goToIndex(h.resumeIndex);
            }
        };
        window.addEventListener(LESSON_COMPLETE_EVENT, onDone);
        return () => window.removeEventListener(LESSON_COMPLETE_EVENT, onDone);
    }, [goToIndex]);

    // Escape closes the player (per-step progress is already persisted) — but
    // only in modal mode: docked or minimized, the app underneath owns Escape.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape' && !handoff && !minimized && !docked) { e.preventDefault(); onClose?.(); } };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose, handoff, minimized, docked]);

    // While a tour segment runs, the player gets out of the way entirely (the
    // spotlight needs the whole screen — in either layout).
    if (handoff) return null;

    const title = lesson ? t(lesson.titleKey, lesson.titleFallback) : '';
    const isLast = stepIndex === total - 1;
    const advanceable = canAdvance(step);
    const isAction = step && stepType(step) === STEP_TYPES.ACTION;
    const course = courseId ? getCourse(courseId) : null;
    const courseTitle = course ? t(course.titleKey, course.titleFallback) : null;
    const eyebrow = isReview
        ? t('learn.review.chrome_label', 'Review')
        : (courseTitle ? `${t('settings.learning_center', 'Learning Center')} · ${courseTitle}` : t('settings.learning_center', 'Learning Center'));
    // "lesson 2 of 4 · 25 min" — the lesson's place in its course, for the meta line.
    const coursePos = (() => {
        if (!course) return null;
        const list = courseLessons(course, user, hasFeature);
        const i = list.findIndex((l) => l.id === lessonId);
        if (i === -1) return null;
        const minutes = list.reduce((n, l) => n + (Number(l.estMinutes) || 0), 0);
        return { index: i + 1, total: list.length, minutes: Math.max(1, Math.round(minutes)) };
    })();
    const stepKind = step ? stepType(step) : null;
    const stepCounter = t('tour.step_counter', 'Step {n} of {total}').replace('{n}', String(stepIndex + 1)).replace('{total}', String(total));

    const iconBtn = 'grid place-items-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] flex-shrink-0';

    // Minimized: a floating pill (artboard 1f) so the learner can work in the
    // real app while an action step's checklist keeps verifying underneath.
    // Turns green the moment the step passes and offers "Continue" right there.
    const pill = minimized ? (
        <div className="fixed bottom-5 right-5 z-[1000] inline-flex items-center gap-2.5 rounded-full"
            style={{
                padding: advanceable ? '8px 8px 8px 12px' : '8px 10px 8px 12px',
                background: 'var(--bg-card)', boxShadow: 'var(--shadow-popover)',
                border: `1px solid ${advanceable ? 'var(--learn-complete)' : 'var(--border-default)'}`,
            }}
            data-testid="lesson-player-pill">
            {advanceable
                ? <CircleCheck style={{ width: 16, height: 16, color: 'var(--learn-complete)' }} aria-hidden="true" />
                : <span className="text-[15px] leading-none" aria-hidden="true">{lesson?.icon || '🎓'}</span>}
            <button type="button" onClick={() => setMinimized(false)} className="flex flex-col gap-[1px] text-left min-w-0"
                title={t('learn.player.pill_working', 'Lesson in progress — click to return')}>
                <span className="text-[12px] font-semibold leading-[14px] truncate max-w-[220px]" style={{ color: advanceable ? 'var(--learn-complete-ink)' : 'var(--text-primary)' }}>
                    {advanceable ? t('learn.player.pill_passed', 'Step passed') : title}
                </span>
                <span className="text-[11px] leading-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                    {advanceable
                        ? t('learn.player.pill_passed_sub', 'every check passed · {time}').replace('{time}', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                        : `${stepCounter.toLowerCase()} · ${isAction ? t('learn.player.pill_checking', 'check running') : t('learn.player.pill_paused', 'paused')}`}
                </span>
            </button>
            {advanceable ? (
                <button type="button" onClick={() => { setMinimized(false); advance(); }}
                    className="inline-flex items-center gap-[5px] h-[26px] px-2.5 rounded-full text-[12px] font-semibold"
                    style={PRIMARY_ACTION_STYLE}>
                    {t('learn.player.pill_continue', 'Continue')}<ArrowRight style={{ width: 12, height: 12 }} aria-hidden="true" />
                </button>
            ) : (
                <>
                    {isAction && <Loader2 className="animate-spin" style={{ width: 14, height: 14, color: 'var(--accent-primary)' }} aria-hidden="true" />}
                    <button type="button" onClick={() => setMinimized(false)} aria-label={t('learn.player.restore', 'Open the lesson again')}
                        className="grid place-items-center rounded-full" style={{ width: 24, height: 24, border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                        <Maximize2 style={{ width: 12, height: 12 }} />
                    </button>
                </>
            )}
        </div>
    ) : null;

    const chrome = (
        <>
            {/* Header — 48px (artboard 1c) */}
            <div className="flex items-center gap-1.5 flex-shrink-0" style={{ height: 48, padding: '0 10px 0 14px', borderBottom: '1px solid var(--border-default)' }}>
                <div className="min-w-0 flex-1">
                    <div className="uppercase font-semibold leading-3 truncate" style={{ fontSize: 10, letterSpacing: '.08em', color: 'var(--accent-primary)' }}>{eyebrow}</div>
                    <h2 className="text-[14px] font-semibold leading-[18px] truncate" style={{ color: 'var(--text-primary)' }}>{title}</h2>
                </div>
                {!finished && (
                    <button type="button" onClick={() => setTutorOpen((o) => !o)} aria-pressed={tutorOpen}
                        className={iconBtn}
                        style={tutorOpen
                            ? { background: 'color-mix(in srgb, var(--accent-primary) 18%, transparent)', color: 'var(--accent-primary)' }
                            : { color: 'var(--text-secondary)' }}
                        title={t('learn.tutor.toggle_title', 'Stuck? Ask the AI coach about this step')} aria-label={t('learn.tutor.toggle', 'Ask AI')}>
                        <Sparkles style={{ width: 14, height: 14 }} />
                    </button>
                )}
                {!finished && !mobile && (
                    <button type="button" onClick={() => switchLayout(docked ? LAYOUTS.MODAL : LAYOUTS.DOCKED)}
                        aria-label={docked ? t('learn.player.undock', 'Expand to a centered window') : t('learn.player.dock', 'Dock to the side')}
                        title={docked
                            ? t('learn.player.undock_title', 'Expand — focus on the lesson')
                            : t('learn.player.dock_title', 'Dock to the side — use the app while you learn')}
                        className={iconBtn} style={{ color: 'var(--text-secondary)' }}>
                        {docked ? <AppWindow style={{ width: 14, height: 14 }} /> : <PanelRight style={{ width: 14, height: 14 }} />}
                    </button>
                )}
                {(isAction || docked) && !finished && (
                    <button type="button" onClick={() => setMinimized(true)}
                        aria-label={t('learn.player.minimize', 'Minimize')}
                        title={t('learn.player.minimize_title', 'Collapse the lesson while you work — it keeps checking')}
                        className={iconBtn} style={{ color: 'var(--text-secondary)' }}>
                        <Minus style={{ width: 14, height: 14 }} />
                    </button>
                )}
                <button type="button" onClick={() => onClose?.()} aria-label={t('common.close', 'Close')}
                    className={iconBtn} style={{ color: 'var(--text-secondary)' }}>
                    <X style={{ width: 14, height: 14 }} />
                </button>
            </div>

            {/* Progress — 4px segments: done = ink, current = accent, rest = tertiary */}
            {!finished && (
                <div className="flex flex-col gap-1.5 flex-shrink-0" style={{ padding: '12px 14px 0' }}>
                    <div className="flex" style={{ gap: 3 }} aria-hidden="true">
                        {steps.map((s, i) => (
                            <span key={s.id || i} className="flex-1 transition-colors"
                                style={{ height: 4, borderRadius: 2, background: i < stepIndex ? 'var(--text-primary)' : (i === stepIndex ? 'var(--accent-primary)' : 'var(--bg-tertiary)') }} />
                        ))}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        <span>{stepCounter}</span>
                        {stepKind && (
                            <>·<span className="inline-flex items-center gap-[3px] font-medium" style={{ color: stepKind === STEP_TYPES.ACTION ? 'var(--accent-primary)' : undefined }}>
                                <StepKindIcon kind={stepKind} size={11} />
                                {stepKindLabel(t, stepKind)}{stepKind === STEP_TYPES.ACTION && <> · {t('learn.player.do_it_for_real', 'do it for real')}</>}
                            </span></>
                        )}
                        {coursePos && (
                            <span className="ml-auto whitespace-nowrap">
                                {t('learn.player.lesson_pos', 'lesson {n} of {total} · {min} min').replace('{n}', String(coursePos.index)).replace('{total}', String(coursePos.total)).replace('{min}', String(coursePos.minutes))}
                            </span>
                        )}
                    </div>
                </div>
            )}

            {/* Body */}
            <div className={`overflow-y-auto flex flex-col gap-3 text-[12px] ${docked ? 'flex-1 min-h-0' : ''}`} style={{ padding: 14 }}>
                {finished ? (
                    <CompletionScreen t={t} celebration={celebration} lesson={lesson} steps={steps} onClose={onClose} onNavigate={onNavigate} courseId={courseId} />
                ) : (
                    <StepBody
                        step={step}
                        lessonId={lessonId}
                        user={user}
                        statusMap={statusMap}
                        modelTier={modelTier}
                        recordStatus={recordStatus}
                        onLaunch={launchAction}
                    />
                )}
                {/* Ask-AI tutor — available on every step */}
                {!finished && tutorOpen && (
                    <TutorPanel lessonId={lessonId} step={step} modelTier={modelTier} onClose={() => setTutorOpen(false)} />
                )}
                {!finished && !advanceable && stepIsRequired(step) && (
                    <div className="mt-auto flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        <Lock style={{ width: 11, height: 11 }} aria-hidden="true" />
                        {isAction
                            ? t('learn.player.next_unlocks_checks', '"Next" unlocks once every check passes.')
                            : t('learn.player.complete_to_continue', 'Complete this step to continue')}
                    </div>
                )}
            </div>

            {/* Footer — 56px */}
            {!finished && (
                <div className="flex items-center gap-2 flex-shrink-0" style={{ height: 56, padding: '0 14px', borderTop: '1px solid var(--border-default)' }}>
                    <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{stepCounter}</span>
                    <div className="flex-1" />
                    {stepIndex > 0 && (
                        <button type="button" onClick={back}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-[var(--bg-tertiary)]"
                            style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                            <ArrowLeft style={{ width: 13, height: 13 }} aria-hidden="true" /> {t('tour.back', 'Back')}
                        </button>
                    )}
                    <button type="button" onClick={advance} disabled={!advanceable}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-semibold whitespace-nowrap transition-opacity disabled:opacity-45"
                        style={PRIMARY_ACTION_STYLE}
                        title={!advanceable ? t('learn.player.complete_to_continue', 'Complete this step to continue') : undefined}>
                        {isLast
                            ? (isReview ? t('learn.review.finish', 'Finish review') : t('learn.player.finish', 'Finish lesson'))
                            : t('tour.next', 'Next')}
                        {advanceable
                            ? <ArrowRight style={{ width: 13, height: 13 }} aria-hidden="true" />
                            : stepIsRequired(step) && <Lock style={{ width: 13, height: 13 }} aria-hidden="true" />}
                    </button>
                </div>
            )}
        </>
    );

    return createPortal(
        <>
            {pill}
            {docked ? (
                // Learn-along panel: the app stays interactive to the left. No
                // backdrop, no Escape-close — the panel is a co-worker, not a
                // modal. Same z as the modal (below the tour's 9997+).
                <div className={`fixed inset-y-0 right-0 z-[1000] w-[420px] max-w-full border-l flex flex-col ${minimized ? 'hidden' : ''}`}
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', boxShadow: '-8px 0 24px rgba(0,0,0,.06)', fontSize: 13, color: 'var(--text-primary)' }}
                    role="complementary" aria-label={title} aria-live="polite" aria-hidden={minimized || undefined}>
                    {chrome}
                </div>
            ) : (
                <div className={`fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4 ${minimized ? 'hidden' : ''}`}
                    onMouseDown={(e) => { if (e.target === e.currentTarget && !finished) onClose?.(); }}
                    aria-live="polite" aria-hidden={minimized || undefined}>
                    <div className="w-full max-w-3xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
                        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', fontSize: 13, color: 'var(--text-primary)' }}>
                        {chrome}
                    </div>
                </div>
            )}
        </>,
        document.body,
    );
}

function StepBody({ step, lessonId, user, statusMap, modelTier, recordStatus, onLaunch }) {
    if (!step) return null;
    switch (stepType(step)) {
        case STEP_TYPES.QUIZ:
            return <QuizStep step={step} lessonId={lessonId} saved={statusMap[step.id]} onState={(s) => recordStatus(step.id, s)} />;
        case STEP_TYPES.EXERCISE:
            return <ExerciseStep step={step} saved={statusMap[step.id]} modelTier={modelTier} onState={(s) => recordStatus(step.id, s)} />;
        case STEP_TYPES.SIM:
            return <SimStep step={step} saved={statusMap[step.id]} onState={(s) => recordStatus(step.id, s)} />;
        case STEP_TYPES.ACTION:
            return <ActionStep step={step} user={user} saved={statusMap[step.id]} onState={(s) => recordStatus(step.id, s)} onLaunch={onLaunch} />;
        case STEP_TYPES.SLIDE:
        default:
            return <SlideStep step={step} />;
    }
}

/**
 * The end screen (artboard 1f): 🎉, the XP line, the gold "Mastered" panel
 * only on a clean run, the badge panel on the last lesson of a course, and
 * two ways on — the next lesson (beside the app when it has real-app steps)
 * and back to the course.
 */
function CompletionScreen({ t, celebration, lesson, steps, onClose, onNavigate, courseId }) {
    const newBadges = celebration?.newBadges || [];
    const isReview = !!celebration?.review;
    const masteredTitles = celebration?.masteredTitles || [];
    const xp = celebration?.xp || null;
    const next = celebration?.nextLesson || null;
    const openNext = () => {
        onClose?.();
        try {
            window.dispatchEvent(new CustomEvent(LESSON_PLAYER_OPEN_EVENT, { detail: { lessonId: next.id, courseId: next.courseId, layout: next.docked ? LAYOUTS.DOCKED : null } }));
        } catch (_) { /* ignore */ }
    };
    const backToCourse = () => {
        onClose?.();
        requestLearningNavigate(courseId ? { view: 'course', courseId } : { view: 'overview' });
        try { onNavigate?.('settings/learning'); } catch (_) { /* ignore */ }
    };
    return (
        <div className="flex flex-col items-center gap-3.5 text-center" style={{ padding: '12px 2px 4px' }} data-testid="lesson-complete">
            <div className="text-[34px] leading-none" aria-hidden="true">{isReview ? '🧠' : '🎉'}</div>
            <div className="flex flex-col gap-1">
                <div className="text-[18px] font-bold leading-[22px]" style={{ color: 'var(--text-primary)' }}>
                    {isReview ? t('learn.review.complete', 'Review complete!') : t('learn.player.lesson_complete', 'Lesson complete!')}
                </div>
                <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {isReview
                        ? t('learn.review.complete_sub', 'Refreshed and re-proven — this is how it sticks.')
                        : (
                            <>
                                {t('learn.player.steps_done', '{a} of {b} steps').replace('{a}', String((steps || []).length)).replace('{b}', String((steps || []).length))}
                                {xp && <> · <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>+{xp.gained} XP</span> · {t(`learn.level.${xp.level.key}`, xp.level.titleFallback)} {xp.total} XP{xp.next && <> · {t('learn.player.to_next_level', '{n} to {level}').replace('{n}', String(xp.next.min - xp.total)).replace('{level}', t(`learn.level.${xp.next.key}`, xp.next.titleFallback))}</>}</>}
                                {!xp && t('learn.player.lesson_complete_sub', 'Nice work. Your progress is saved.')}
                            </>
                        )}
                </div>
            </div>

            {/* Mastery — gold, only on a clean run (or lessons re-proven in review) */}
            {(celebration?.mastered || masteredTitles.length > 0) && (
                <div className="w-full flex items-center gap-3 rounded-[10px] text-left" style={{ padding: '12px 14px', border: '1px solid var(--learn-mastered)', background: 'color-mix(in srgb, var(--learn-mastered) 10%, transparent)' }}>
                    <div className="grid place-items-center flex-shrink-0" style={{ width: 36, height: 36, borderRadius: 10, background: 'color-mix(in srgb, var(--learn-mastered) 18%, transparent)', color: 'var(--learn-mastered-ink)' }}>
                        <Award style={{ width: 18, height: 18 }} aria-hidden="true" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="font-semibold" style={{ color: 'var(--learn-mastered-ink)' }}>{t('learn.mastery.earned', 'Mastered')}</div>
                        <div className="text-[11px] leading-[15px]" style={{ color: 'var(--text-secondary)' }}>
                            {celebration?.mastered ? t('learn.mastery.clean_run_body', 'Every quiz and simulation first try, the exercise without a hint. Nothing revealed.') : masteredTitles.join(' · ')}
                        </div>
                    </div>
                    {celebration?.mastered && <span className="font-semibold whitespace-nowrap" style={{ color: 'var(--learn-mastered-ink)' }}>+{xp?.masteryBonus ?? 50} XP</span>}
                </div>
            )}

            {newBadges.length > 0 && (
                <div className="w-full flex items-center gap-3 rounded-[10px] text-left" style={{ padding: '12px 14px', border: '1px solid var(--accent-primary)', background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' }}>
                    <div className="grid place-items-center flex-shrink-0" style={{ width: 36, height: 36, borderRadius: 10, background: 'color-mix(in srgb, var(--accent-primary) 18%, transparent)', color: 'var(--accent-primary)' }}>
                        <PartyPopper style={{ width: 18, height: 18 }} aria-hidden="true" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="font-semibold" style={{ color: 'var(--accent-primary)' }}>{t('learn.player.badge_earned', 'Badge earned')}</div>
                        {newBadges.map((b) => (
                            <div key={b.id || b.badgeId} className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                <span aria-hidden="true">{b.icon || '🏅'}</span> {t(b.titleKey, b.titleFallback || b.title)}
                            </div>
                        ))}
                        {celebration?.courseComplete && celebration?.courseTitle && (
                            <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('learn.player.course_complete', 'You completed {course}.').replace('{course}', celebration.courseTitle)}</div>
                        )}
                    </div>
                </div>
            )}

            <div className="w-full flex flex-col gap-1.5 mt-1">
                {!isReview && next ? (
                    <button type="button" onClick={openNext} className="inline-flex items-center justify-center gap-1.5 rounded-[10px] text-[12px] font-semibold px-3" style={{ height: 36, ...PRIMARY_ACTION_STYLE }}>
                        {next.docked ? <PanelRight style={{ width: 13, height: 13 }} aria-hidden="true" /> : <Play style={{ width: 13, height: 13 }} aria-hidden="true" />}
                        <span className="truncate">
                            {(next.docked ? t('learn.player.next_docked', 'Next lesson beside the app: {title}') : t('learn.player.next_lesson', 'Next lesson: {title}')).replace('{title}', next.title)}
                        </span>
                    </button>
                ) : (
                    <button type="button" onClick={() => onClose?.()} className="inline-flex items-center justify-center gap-1.5 rounded-[10px] text-[12px] font-semibold px-3" style={{ height: 36, ...PRIMARY_ACTION_STYLE }}>
                        {t('learn.player.done', 'Done')} <Check style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                )}
                {!isReview && (
                    <button type="button" onClick={backToCourse} className="inline-flex items-center justify-center gap-1.5 rounded-[10px] text-[12px] font-medium px-3 hover:bg-[var(--bg-tertiary)]" style={{ height: 36, border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                        {courseId ? t('learn.player.back_to_course', 'Back to the course') : t('learn.player.back_to_center', 'Back to the Learning Center')}
                    </button>
                )}
            </div>
            {!isReview && !celebration?.courseComplete && lesson && (
                <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.player.badge_note', 'On the last lesson of a course the "Badge earned" panel appears here too.')}</div>
            )}
        </div>
    );
}
