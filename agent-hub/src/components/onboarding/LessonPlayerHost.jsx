import React, { useCallback, useEffect, useRef, useState } from 'react';
import { activeCourses, courseLessons, earnedBadgesFromProgress, isCourseComplete, xpFromProgress, getCourse, XP_PER_MASTERY } from './courses';
import { readCompletedMap, readMasteredMap } from './learningProgress';
import { LESSON_PLAYER_OPEN_EVENT, TOUR_START_EVENT, lessonIdIsPureTour } from './lessons';
import LessonPlayer from './player/LessonPlayer';
import { useTranslation } from '../../hooks/useTranslation';
import { lessonPlays } from '../../pages/settings/learning/curriculum';
import { useLicenseContext } from '../licensing/LicenseContext';

/**
 * LessonPlayerHost — mounted once in App (beside OnboardingTour). Listens for
 * LESSON_PLAYER_OPEN_EVENT and opens the focused LessonPlayer for rich lessons.
 * Pure-tour lessons (the legacy 10) are routed straight to the spotlight engine so
 * they behave exactly as before. On completion it diffs earned badges (snapshotted
 * at open time) to celebrate any newly-earned badge in the player's final screen.
 */
export default function LessonPlayerHost({ user, onNavigate }) {
    const { t } = useTranslation();
    const { hasFeature } = useLicenseContext();
    const [active, setActive] = useState(null); // { lessonId, courseId, layout }
    const beforeBadgesRef = useRef(new Set());
    const beforeXpRef = useRef(0);
    const activeRef = useRef(null);
    useEffect(() => { activeRef.current = active; }, [active]);

    useEffect(() => {
        const onOpen = (e) => {
            const lessonId = e?.detail?.lessonId;
            if (!lessonId) return;
            // A lesson made entirely of live-app tour steps skips the player.
            // The Learning Center is the only opener, so the tour engine gets
            // the return context with it: completion brings the learner back
            // here instead of the onboarding home-jump to Direct chat (BFSF-472).
            if (lessonIdIsPureTour(lessonId)) {
                try { window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { lessonId, returnTo: 'settings/learning' } })); } catch (_) { /* ignore */ }
                return;
            }
            try {
                const completed = readCompletedMap(user);
                beforeBadgesRef.current = new Set(
                    earnedBadgesFromProgress(completed, user, hasFeature).map((b) => b.id),
                );
                beforeXpRef.current = xpFromProgress(completed, user, hasFeature, readMasteredMap(user)).xp;
            } catch (_) { beforeBadgesRef.current = new Set(); beforeXpRef.current = 0; }
            setActive({ lessonId, courseId: e?.detail?.courseId || null, layout: e?.detail?.layout || null });
        };
        window.addEventListener(LESSON_PLAYER_OPEN_EVENT, onOpen);
        return () => window.removeEventListener(LESSON_PLAYER_OPEN_EVENT, onOpen);
    }, [user, hasFeature]);

    const handleComplete = useCallback(async (lessonId) => {
        const completedMap = readCompletedMap(user);
        const after = earnedBadgesFromProgress(completedMap, user, hasFeature);
        const before = beforeBadgesRef.current;
        const newBadges = after.filter((b) => !before.has(b.id));

        let courseComplete = false;
        let courseTitle = null;
        const course = (activeRef.current?.courseId && getCourse(activeRef.current.courseId))
            || activeCourses().find((c) => (c.lessonIds || []).includes(lessonId));
        if (course && isCourseComplete(course, completedMap, user, hasFeature)) {
            courseComplete = true;
            courseTitle = t(course.titleKey, course.titleFallback);
        }

        // The XP line on the end screen: what this lesson added, where that
        // leaves the learner, and how far the next level is.
        let xp = null;
        try {
            const now = xpFromProgress(completedMap, user, hasFeature, readMasteredMap(user));
            xp = { gained: Math.max(0, now.xp - beforeXpRef.current), total: now.xp, level: now.level, next: now.next, masteryBonus: XP_PER_MASTERY };
        } catch (_) { /* celebration only */ }

        // The next not-complete lesson in the same course — offered right on
        // the end screen, beside the app when it has real-app steps.
        let nextLesson = null;
        if (course) {
            const lessons = courseLessons(course, user, hasFeature);
            const next = lessons.find((l) => l.id !== lessonId && !completedMap[l.id]);
            if (next) nextLesson = { id: next.id, courseId: course.id, title: t(next.titleKey, next.titleFallback), docked: lessonPlays(next) === 'docked' };
        }
        return { newBadges, courseComplete, courseTitle, xp, nextLesson };
    }, [user, hasFeature, t]);

    if (!active) return null;

    return (
        <LessonPlayer
            key={active.lessonId}
            lessonId={active.lessonId}
            courseId={active.courseId}
            initialLayout={active.layout}
            user={user}
            onNavigate={onNavigate}
            onClose={() => setActive(null)}
            onComplete={handleComplete}
        />
    );
}
