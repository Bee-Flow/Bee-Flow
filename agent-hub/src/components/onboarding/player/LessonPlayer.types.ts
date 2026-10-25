import type { LessonUser, StepState, LessonDoc } from '../../../api/lessons.types';
import type { LessonStep } from './SimStep.types';
import type { TranslateParams } from '../../../hooks/useTranslation';

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
export interface CelebrationBadge {
    id?: string;
    badgeId?: string;
    icon?: string;
    title?: string;
    titleKey?: string;
    titleFallback?: string;
}

export interface CelebrationXp {
    gained: number;
    total: number;
    level: { key: string; titleFallback: string };
    next: { key: string; min: number; titleFallback: string } | null;
    masteryBonus: number;
}

/** What the end screen shows: the host's answer to onComplete plus the player's own mastery flags. */
export interface Celebration {
    mastered?: boolean;
    review?: boolean;
    masteredTitles?: (string | null)[];
    newBadges?: CelebrationBadge[];
    courseComplete?: boolean;
    courseTitle?: string | null;
    xp?: CelebrationXp | null;
    nextLesson?: { id: string; courseId: string; title: string; docked: boolean } | null;
}

export interface LessonPlayerProps {
    lessonId: string;
    courseId?: string | null;
    initialLayout?: string | null;
    user?: LessonUser | null;
    modelTier?: string;
    onNavigate?: (value: string) => void;
    onClose?: () => void;
    onComplete?: (lessonId: string) => Promise<Celebration | void>;
}

export interface LessonPlayerViewProps extends LessonPlayerProps {
    steps: LessonStep[];
    onVideoUnavailable?: (stepId: string) => void;
}

export interface StepBodyProps {
    step: LessonStep | null;
    recordStatus: (stepId: string | null, state: StepState) => void;
    onVideoUnavailable?: (stepId: string) => void;
    lessonId: string;
    user?: LessonUser | null;
    statusMap: Record<string, StepState>;
    modelTier: string;
    onLaunch: (navigateTo: string) => void;
}

/**
 * The end screen (artboard 1f): 🎉, the XP line, the gold "Mastered" panel
 * only on a clean run, the badge panel on the last lesson of a course, and
 * two ways on — the next lesson (beside the app when it has real-app steps)
 * and back to the course.
 */
export interface CompletionScreenProps {
    celebration: Celebration | null;
    steps: LessonStep[];
    courseId?: string | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    lesson: LessonDoc | undefined;
    onClose?: () => void;
    onNavigate?: (value: string) => void;
}
