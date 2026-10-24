// Client wrapper for the Learning Center AI coach (server/routes/ai/learning.js).
//
// Thin authFetch calls — the rubric lives server-side; the client only sends the
// exerciseId + the learner's submission. A failure never throws into the player:
// callers get a structured result with an `error` field and degrade gracefully
// (the exercise is a soft gate, so the learner can always retry or skip).

import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';

export interface ExerciseGrade {
    score: number | null;
    passed: boolean;
    feedback: string;
    strengths: string[];
    improvements: string[];
    error: string | null;
}

export interface GradeExerciseArgs {
    exerciseId: string | undefined;
    submission: string;
    modelTier?: string;
    locale?: string;
}

export interface AskTutorArgs {
    question: string;
    lessonId: string;
    stepId: string | undefined;
    stepContext?: string;
    modelTier?: string;
    locale?: string;
}

export interface TutorAnswer {
    answer: string;
    error: string | null;
}

export interface GetHintArgs {
    exerciseId: string | undefined;
    submission?: string;
    modelTier?: string;
    locale?: string;
}

const ENDPOINT = `${API_BASE}/ai/learning/coach`;

// Grade an attempt. Resolves to:
//   { score: number|null, passed: bool, feedback, strengths[], improvements[], error? }
// `locale` makes the coach reply in the learner's UI language (defaults to English).
export async function gradeExercise({ exerciseId, submission, modelTier = 'fast', locale = 'en' }: GradeExerciseArgs): Promise<ExerciseGrade> {
    try {
        const res = await authFetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exerciseId, mode: 'grade', submission, modelTier, locale }),
        });
        let body = null;
        try { body = await res.json(); } catch (err) { logger.debug('ignore', err); }
        if (res.status === 429) {
            return { score: null, passed: false, feedback: 'You\'re going quickly! Wait a moment, then try again — or skip ahead.', strengths: [], improvements: [], error: 'rate_limited' };
        }
        if (!res.ok || !body) {
            return { score: null, passed: false, feedback: 'The AI coach is unavailable right now — you can retry or skip ahead.', strengths: [], improvements: [], error: 'request_failed' };
        }
        return {
            score: typeof body.score === 'number' ? body.score : null,
            passed: !!body.passed,
            feedback: body.feedback || '',
            strengths: Array.isArray(body.strengths) ? body.strengths : [],
            improvements: Array.isArray(body.improvements) ? body.improvements : [],
            error: body.error || null,
        };
    } catch (_) {
        return { score: null, passed: false, feedback: 'Couldn\'t reach the AI coach — check your connection, then retry or skip ahead.', strengths: [], improvements: [], error: 'network' };
    }
}

// Ask the lesson tutor a free-form question (the "Ask AI" panel available on
// every step of the player). The server grounds the answer in a product fact
// sheet plus the step context the client sends. Resolves to
// { answer: string, error?: string } — a failure degrades to a friendly line,
// never a throw into the player.
export async function askTutor({ question, lessonId, stepId, stepContext = '', modelTier = 'fast', locale = 'en' }: AskTutorArgs): Promise<TutorAnswer> {
    const fallback = (t: string): TutorAnswer => ({ answer: t, error: 'tutor_unavailable' });
    try {
        const res = await authFetch(`${API_BASE}/ai/learning/tutor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, lessonId, stepId, stepContext, modelTier, locale }),
        });
        const body = await res.json().catch(() => null);
        if (res.status === 429) {
            return fallback('You\'re going quickly! Give it a few seconds, then ask again.');
        }
        if (!res.ok || !body?.answer) {
            return fallback('The AI coach is unavailable right now — try again in a moment.');
        }
        return { answer: body.answer, error: null };
    } catch (_) {
        return fallback('Couldn\'t reach the AI coach — check your connection and try again.');
    }
}

// Ask for a single hint. Resolves to { hint: string }.
export async function getHint({ exerciseId, submission = '', modelTier = 'fast', locale = 'en' }: GetHintArgs): Promise<{ hint: string }> {
    try {
        const res = await authFetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exerciseId, mode: 'hint', submission, modelTier, locale }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.hint) {
            return { hint: 'Add concrete context (who it\'s for, the goal) and pin down the exact output format.' };
        }
        return { hint: body.hint };
    } catch (_) {
        return { hint: 'Add concrete context (who it\'s for, the goal) and pin down the exact output format.' };
    }
}
