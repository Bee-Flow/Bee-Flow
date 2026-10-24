// Per-lesson completion tracking for the Learning Center.
//
// Two layers, mirroring how the intro tour persists `hasSeenIntroTour`:
//   • scopedStorage (per-user localStorage) — instant, same-browser source of truth
//   • POST/GET /ai/user-settings { learningProgress } — server blob, cross-device
//
// The engine's finish() calls markLessonComplete(); the Learning Center page calls
// fetchLearningProgress() on mount to hydrate checkmarks from the server. Every
// access is window/SSR-guarded and network calls are best-effort, so a failure
// never blocks the UI.

import scopedStorage from '../../utils/scopedStorage';
import { API_BASE, authFetch } from '../../utils/helpers';
import { isEphemeralLessonId } from './lessons';
import type { LessonProgressEntry, LessonUser, ProgressMap, StepOrigin, StepState } from '../../api/lessons.types';
import { logger } from '../../utils/logger';
import { request, RefusedError } from '../../api/mutate';

export const LEARNING_PROGRESS_KEY = 'learningProgress';

const hasWindow = (): boolean => typeof window !== 'undefined';

// Point scopedStorage at the active user before any read/write (it namespaces
// keys as beeflow:{userId}:learningProgress).
function withUser(user: LessonUser | null | undefined): void {
    try { if (user?.id) scopedStorage.setCurrentUser(user.id); } catch (err) { logger.debug('ignore', err); }
}

// Read the local progress map: { [lessonId]: { completedAt } }.
export function readLearningProgress(user: LessonUser | null | undefined): ProgressMap {
    if (!hasWindow()) return {};
    try {
        withUser(user);
        const map = scopedStorage.getJSON<ProgressMap>(LEARNING_PROGRESS_KEY, {});
        return map && typeof map === 'object' ? map : {};
    } catch (_) {
        return {};
    }
}

// A lesson counts as complete only when its entry carries a completedAt — a bare
// entry that only holds resume `steps` (a lesson started but not finished) is NOT
// complete. (Legacy entries are always { completedAt }, so this is compatible.)
export function isLessonComplete(user: LessonUser | null | undefined, lessonId: string): boolean {
    return lessonEntryComplete(readLearningProgress(user)[lessonId]);
}

// Mastery (v2): a lesson is MASTERED once its entry carries a masteredAt —
// stamped for a clean run (every quiz/sim first-try) or after a review session
// re-proves all of its items. Mastery implies nothing about completion order;
// the UI only shows gold where the lesson is also complete.
export function lessonEntryMastered(entry: LessonProgressEntry | null | undefined): boolean {
    return !!(entry && entry.masteredAt);
}

// { [lessonId]: true } of MASTERED lessons, mirroring readCompletedMap.
export function readMasteredMap(user: LessonUser | null | undefined): Record<string, boolean> {
    const progress = readLearningProgress(user);
    const map: Record<string, boolean> = {};
    Object.keys(progress).forEach((id: string) => { if (lessonEntryMastered(progress[id])) map[id] = true; });
    return map;
}

// Shared completion predicate so the page and helpers agree. Accepts the legacy
// `=== true` shape and the `{ completedAt }` shape; rejects resume-only entries.
export function lessonEntryComplete(entry: LessonProgressEntry | true | null | undefined): boolean {
    return entry === true || !!(entry && entry.completedAt);
}

// The per-step resume/score state stored alongside a lesson's progress entry:
// { [stepId]: { status, score, answers, ... } }.
export function readStepState(user: LessonUser | null | undefined, lessonId: string): Record<string, StepState> {
    const entry = readLearningProgress(user)[lessonId];
    return (entry && typeof entry.steps === 'object' && entry.steps) || {};
}

// A { [lessonId]: true } map of COMPLETED lessons (completedAt present). Shared
// by the Learning Center page and the player host to derive course/badge state.
// The legacy intro-tour flag is no longer injected here: the tour engine writes
// a real getting-started completion on finish, and the server lazily migrates
// pre-tracking users (learning_intro_migrated_user_*) — injecting it locally
// would resurrect getting-started after a reset.
export function readCompletedMap(user: LessonUser | null | undefined): Record<string, boolean> {
    const progress = readLearningProgress(user);
    const map: Record<string, boolean> = {};
    Object.keys(progress).forEach((id: string) => { if (lessonEntryComplete(progress[id])) map[id] = true; });
    return map;
}

function writeLocal(user: LessonUser | null | undefined, map: ProgressMap): void {
    try {
        withUser(user);
        scopedStorage.setJSON(LEARNING_PROGRESS_KEY, map);
    } catch (err) { logger.debug('ignore quota', err); }
}

async function syncProgress(merged: ProgressMap): Promise<void> {
    try {
        await authFetch(`${API_BASE}/ai/user-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [LEARNING_PROGRESS_KEY]: merged }),
        });
    } catch (err) { logger.debug('local mirror already written', err); }
}

// Mark a lesson complete: merge into the local map, then best-effort sync the
// full merged map to the server (read-modify-write, so no clobbering). Any resume
// `steps` already recorded for the lesson are preserved. Ephemeral handoff ids
// (the tour sub-segments of a rich lesson) are NOT persisted as real lessons.
export async function markLessonComplete(user: LessonUser | null | undefined, lessonId: string | null | undefined): Promise<ProgressMap> {
    if (!lessonId || isEphemeralLessonId(lessonId)) return readLearningProgress(user);
    const map = readLearningProgress(user);
    const prev = (map[lessonId] && typeof map[lessonId] === 'object') ? map[lessonId] : {};
    const merged = { ...map, [lessonId]: { ...prev, completedAt: new Date().toISOString() } };
    writeLocal(user, merged);
    await syncProgress(merged);
    return merged;
}

// Stamp a lesson as mastered (masteredAt beside completedAt). Same merge
// semantics as markLessonComplete; ephemeral (review-session) ids are never
// persisted — review sessions stamp their SOURCE lessons instead.
export async function markLessonMastered(user: LessonUser | null | undefined, lessonId: string | null | undefined): Promise<ProgressMap> {
    if (!lessonId || isEphemeralLessonId(lessonId)) return readLearningProgress(user);
    const map = readLearningProgress(user);
    const prev = (map[lessonId] && typeof map[lessonId] === 'object') ? map[lessonId] : {};
    if (prev.masteredAt) return map; // earliest wins — don't re-date
    const merged = { ...map, [lessonId]: { ...prev, masteredAt: new Date().toISOString() } };
    writeLocal(user, merged);
    await syncProgress(merged);
    return merged;
}

// Write a review answer back to its ORIGIN step (review sessions run under an
// ephemeral lesson id, but the truth lives at the step the item came from):
// a first-try-correct clears the mistake there; a wrong answer refreshes it.
export async function recordReviewOutcome(user: LessonUser | null | undefined, origin: StepOrigin | null | undefined, state: StepState): Promise<ProgressMap> {
    if (!origin?.lessonId || !origin?.stepId) return readLearningProgress(user);
    return saveStepState(user, origin.lessonId, origin.stepId, state);
}

// Persist per-step state for resume/scoring (e.g. a passed quiz/exercise). Writes
// the local mirror immediately and best-effort syncs the full map. Does NOT set
// completedAt — the lesson stays "in progress" until markLessonComplete runs.
export async function saveStepState(user: LessonUser | null | undefined, lessonId: string | null | undefined, stepId: string | null | undefined, state: StepState): Promise<ProgressMap> {
    if (!lessonId || !stepId || isEphemeralLessonId(lessonId)) return readLearningProgress(user);
    const map = readLearningProgress(user);
    const prev = (map[lessonId] && typeof map[lessonId] === 'object') ? map[lessonId] : {};
    const steps = { ...(prev.steps || {}), [stepId]: state };
    const merged = { ...map, [lessonId]: { ...prev, steps } };
    writeLocal(user, merged);
    await syncProgress(merged);
    return merged;
}

// Pull the authoritative map from the server and mirror it locally so a fresh
// browser shows cross-device completion. Returns the map (falls back to local).
export async function fetchLearningProgress(user: LessonUser | null | undefined): Promise<ProgressMap> {
    try {
        const res = await request(`${API_BASE}/ai/user-settings`).catch((err: unknown) => {
            if (err instanceof RefusedError) return null;
            throw err;
        });
        if (res) {
            const data = await res.json();
            const map = data?.[LEARNING_PROGRESS_KEY];
            if (map && typeof map === 'object') {
                writeLocal(user, map);
                return map;
            }
        }
    } catch (err) { logger.debug('fall through to local', err); }
    return readLearningProgress(user);
}

// Clear all progress (the "Reset progress" affordance). The server merges
// progress writes (a bare {} would be a no-op), so reset is an explicit flag.
// Note: does NOT touch the legacy hasSeenIntroTour flag, so the first-login
// auto-start guard is preserved.
export async function resetLearningProgress(user: LessonUser | null | undefined): Promise<ProgressMap> {
    writeLocal(user, {});
    try {
        await authFetch(`${API_BASE}/ai/user-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ learningProgressReset: true }),
        });
    } catch (err) { logger.debug('local already cleared', err); }
    return {};
}
