// Client for the AI practice generator (server/routes/ai/learning.js).
//
// Thin authFetch wrappers in the exerciseCoach.js style: the answer keys live
// server-side under a short-lived practiceId; the client only ever sees
// question + choices. A failure never throws into the player — callers get a
// structured result with an `error` field and degrade (the review session
// falls back to bundled quiz items; grading shows a friendly retry note).

import { API_BASE, authFetch } from '../../utils/helpers';

export { PRACTICE_LESSON_IDS } from './reviewEngine';

// Generate fresh practice items for one or more practice-able lessons.
// Resolves to { practiceId, items: [{ id, lessonId, question, choices }] } or
// null when generation is unavailable (rate limit, LLM down, unknown lessons).
export async function generatePractice({ lessonIds, count = 3, locale = 'en' }) {
    try {
        const res = await authFetch(`${API_BASE}/ai/learning/practice/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lessonIds, count, locale }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || body.error || !Array.isArray(body.items) || !body.items.length || !body.practiceId) {
            return null;
        }
        return { practiceId: body.practiceId, items: body.items };
    } catch (_) {
        return null;
    }
}

// Grade one practice answer. Resolves to
//   { correct, explanation, correctChoiceIds?, error? }
// with error 'practice_expired' when the server no longer holds the key.
export async function gradePracticeItem({ practiceId, itemId, choiceIds }) {
    try {
        const res = await authFetch(`${API_BASE}/ai/learning/practice/grade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ practiceId, itemId, choiceIds }),
        });
        const body = await res.json().catch(() => null);
        if (res.status === 404) return { correct: false, explanation: '', error: 'practice_expired' };
        if (!res.ok || !body || typeof body.correct !== 'boolean') {
            return { correct: false, explanation: '', error: 'grade_failed' };
        }
        return {
            correct: body.correct,
            explanation: body.explanation || '',
            ...(Array.isArray(body.correctChoiceIds) ? { correctChoiceIds: body.correctChoiceIds } : {}),
            error: null,
        };
    } catch (_) {
        return { correct: false, explanation: '', error: 'network' };
    }
}
