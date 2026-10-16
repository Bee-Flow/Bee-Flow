/** Shapes the Learning Center screens receive from LearningCenterSection. */
import type { countReviewDue } from '../../../components/onboarding/reviewEngine';
import type { xpFromProgress } from '../../../components/onboarding/courses';
import type { Course, LessonDoc } from '../../../components/onboarding/lessons.types';

/** What the review engine says is due. */
export type ReviewDue = ReturnType<typeof countReviewDue>;

/** xpFromProgress result: XP, level, next level and the done counters. */
export type LevelInfo = ReturnType<typeof xpFromProgress>;

/** Where the Learning Center navigates to: a tab, or one course. */
export interface LearningNavTarget {
    view: string;
    courseId?: string;
}

/** The capstone course with its prerequisite counters and lock state. */
export interface CapstoneInfo {
    course: Course;
    doneCourses: number;
    totalCourses: number;
    locked: boolean;
}

/** The lesson the overview's hero resumes: first open lesson of the first open course. */
export interface ContinueTarget {
    course: Course;
    lesson: LessonDoc;
    /** 1-based position of the lesson in its course. */
    index: number;
    total: number;
}

/** Starts a lesson; `layout` picks where the player opens. */
export type StartLessonFn = (lessonId: string, courseId: string, opts?: { layout?: string }) => void;
