import { useState, useEffect, useRef, useCallback } from 'react';
import { userSettingsApi } from '../../api/userSettingsApi';
import scopedStorage from '../../utils/scopedStorage';
import { markLessonComplete } from './learningProgress';
import { resolveLessonSteps, DEFAULT_LESSON_ID, LESSON_COMPLETE_EVENT } from './lessons';
import { resolveTourCompletionNavigation } from './tourCompletion';
import { TOUR_SEEN_KEY, TOUR_START_EVENT } from './tourSteps';
import type { OnboardingTourProps, TargetRect, TourStartDetail, TourStep } from './OnboardingTour.types';

/**
 * The run of a tour: which lesson is running, the steps and the current one,
 * the target rect, starting (by event, or automatically for a first-time user)
 * and finishing (persist, record progress, navigate back).
 */
export function useTourRun({ user, onNavigate, currentPage }: OnboardingTourProps) {
    const [active, setActive] = useState(false);
    const [steps, setSteps] = useState<TourStep[]>([]);
    const [stepIndex, setStepIndex] = useState(0);
    const [rect, setRect] = useState<TargetRect | null>(null); // target rect, or null → centered card

    const targetElRef = useRef<Element | null>(null);
    const navigatedRef = useRef(false);     // did we drive navigation this run?
    const agentCreatedRef = useRef(false);  // did the user actually create an agent?
    const activeLessonRef = useRef(DEFAULT_LESSON_ID); // which lesson is running
    const returnToRef = useRef<string | null>(null);       // where the starter wants the learner back (BFSF-472)
    const runningRef = useRef(false);       // re-entrancy guard (mirrors `active`)

    const step = steps[stepIndex] || null;

    // Run a lesson by id. No id → the getting-started lesson (the original intro
    // tour), so existing detail-less callers behave exactly as before. `context`
    // carries the starter's return context: `{ returnTo }` names the page the
    // learner goes back to on completion (the Learning Center passes
    // 'settings/learning'); without it the intro tour keeps its first-time
    // onboarding home-jump to Direct chat.
    const startTour = useCallback((lessonId: string = DEFAULT_LESSON_ID, context: TourStartDetail | null = null) => {
        // Ignore a start while a lesson is already running (e.g. a double-click on
        // a Learning Center card) so step arrays can't stack.
        if (runningRef.current) return;
        const id = lessonId || DEFAULT_LESSON_ID;
        const resolved = resolveLessonSteps(id, user);
        if (!resolved.length) return;
        activeLessonRef.current = id;
        returnToRef.current = (context && typeof context.returnTo === 'string' && context.returnTo) || null;
        runningRef.current = true;
        navigatedRef.current = false;
        agentCreatedRef.current = false;
        setSteps(resolved);
        setStepIndex(0);
        setRect(null);
        setActive(true);
    }, [user]);

    // ── Persist + close ───────────────────────────────────────────────
    const finish = useCallback(async () => {
        const lessonId = activeLessonRef.current || DEFAULT_LESSON_ID;
        const isIntro = lessonId === DEFAULT_LESSON_ID;
        setActive(false);
        runningRef.current = false;
        setRect(null);
        targetElRef.current = null;
        try { if (user?.id) scopedStorage.setCurrentUser(user.id); } catch (e) { /* ignore */ }

        // Legacy intro path — unchanged so the first-login auto-start never
        // re-fires and the user lands back on chat.
        if (isIntro) {
            try { scopedStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (e) { /* ignore */ }
            try {
                await userSettingsApi.save({ [TOUR_SEEN_KEY]: true });
            } catch (e) { /* best-effort — local guard already set */ }
        }

        // Per-lesson completion for the Learning Center (also recorded for the
        // intro lesson so its card shows a checkmark).
        try { await markLessonComplete(user, lessonId); } catch (e) { /* best-effort */ }

        // The home-jump is intro-tour behaviour only, and only for first-time
        // onboarding: a run started WITH a return context (e.g. the Learning
        // Center replaying "Getting started") hands the learner back to its
        // starter instead (BFSF-472). Other lessons leave the user wherever the
        // lesson ended.
        const target = resolveTourCompletionNavigation({ isIntro, navigated: navigatedRef.current, returnTo: returnToRef.current });
        if (target && onNavigate) onNavigate(target);
        navigatedRef.current = false;
        returnToRef.current = null;

        // Let an open Learning Center flip this lesson's card to "Replay".
        try { window.dispatchEvent(new CustomEvent(LESSON_COMPLETE_EVENT, { detail: { lessonId } })); } catch (e) { /* ignore */ }
    }, [onNavigate, user]);

    const goNext = useCallback(() => {
        setStepIndex((i: number) => {
            if (i >= steps.length - 1) { finish(); return i; }
            return i + 1;
        });
    }, [steps.length, finish]);

    const goPrev = useCallback(() => {
        setStepIndex((i: number) => Math.max(0, i - 1));
    }, []);

    // ── Auto-start for first-time users (desktop, on the chat home only) ──
    const autoStartTriedRef = useRef(false);
    useEffect(() => {
        if (autoStartTriedRef.current) return;
        if (!user?.id) return;
        if (currentPage && currentPage !== 'agents') return; // wait until they're on chat
        if (typeof window !== 'undefined' && window.innerWidth < 768) { autoStartTriedRef.current = true; return; }
        autoStartTriedRef.current = true;
        let cancelled = false;
        try { scopedStorage.setCurrentUser(user.id); } catch (e) { /* ignore */ }
        try { if (scopedStorage.getItem(TOUR_SEEN_KEY) === '1') return; } catch (e) { /* ignore */ }

        (async () => {
            try {
                const res = await userSettingsApi.get();
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (data?.[TOUR_SEEN_KEY]) return;
                setTimeout(() => { if (!cancelled) startTour(); }, 900);
            } catch (e) { /* don't block the app on a settings fetch */ }
        })();
        return () => { cancelled = true; };
    }, [user?.id, currentPage, startTour]);

    // ── Replay on demand (intro tour or a specific Learning Center lesson) ──
    useEffect(() => {
        const onStart = (e: CustomEvent<TourStartDetail>) => startTour(e?.detail?.lessonId, e?.detail || null);
        window.addEventListener(TOUR_START_EVENT, onStart as EventListener);
        return () => window.removeEventListener(TOUR_START_EVENT, onStart as EventListener);
    }, [startTour]);

    return { active, steps, stepIndex, rect, setRect, step, targetElRef, navigatedRef, agentCreatedRef, finish, goNext, goPrev };
}
