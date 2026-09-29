import { useCallback } from 'react';
import {
    trainingGateKeys,
    useTrainingGatesQuery,
    type TrainingGateAreas,
    type TrainingGateState,
} from '../api/queries/trainingGates';
import { queryClient } from '../api/queryClient';

/**
 * The organisation's "finish the course first" rules, for THIS user.
 *
 * The server enforces them on write (server/learning/requireTraining.js). This
 * exists so the client can lock a create button WITH ITS REASON before it is
 * pressed: a 403 discovered at Save costs somebody the work they just did and
 * tells them nothing about which course lifts it.
 *
 * One fetch per session, shared through the app's React Query cache, because
 * several surfaces (the New menu, a section header, an empty state) ask the
 * same question on the same screen and none of them should cost a round-trip.
 * The wire contract, including the fails-open rule, lives in
 * `api/queries/trainingGates`.
 */
export type { TrainingGateAreas, TrainingGateState };

/** A lock the caller may render, with enough to name the course and progress. */
export interface TrainingLock {
    areaId: string;
    courseId?: string;
    courseTitle?: string;
    lessonsDone: number;
    lessonsTotal: number;
}

const NO_AREAS: TrainingGateAreas = Object.freeze({});

/** Drop the shared answer — call after progress changes (a lesson completed). */
export function invalidateTrainingGates(): void {
    // remove, not reset or invalidate: logout calls this while the old
    // user's screens are still mounted and their session token still set,
    // and either of those would refetch for the old user on the way out.
    queryClient.removeQueries({ queryKey: trainingGateKeys.all });
}

export interface UseTrainingGatesReturn {
    areas: TrainingGateAreas;
    loading: boolean;
    lockFor: (areaId: string) => TrainingLock | null;
}

/**
 * `enabled` defaults to false: the answer is only needed the moment somebody
 * reaches for a create control. Fetching eagerly would put a request on every
 * page load to answer a question nobody asked.
 */
export function useTrainingGates({ enabled = false }: { enabled?: boolean } = {}): UseTrainingGatesReturn {
    const query = useTrainingGatesQuery({ enabled });
    const areas = query.data ?? NO_AREAS;

    /**
     * The lock on one area, or null when there is none. Returns the course and
     * how far along they are, so the caller can say "Finish Build Your First
     * Agent (4 of 7) to unlock this" rather than only "not allowed".
     */
    const lockFor = useCallback((areaId: string): TrainingLock | null => {
        const state = areas?.[areaId];
        if (!state || !state.enforced || state.satisfied) return null;
        return {
            areaId,
            courseId: state.courseId,
            courseTitle: state.courseTitle,
            lessonsDone: state.lessonsDone || 0,
            lessonsTotal: state.lessonsTotal || 0,
        };
    }, [areas]);

    return { areas, loading: enabled && query.isFetching, lockFor };
}

/** The one-line hint a training-locked control carries. */
export function trainingLockHint(
    lock: TrainingLock | null | undefined,
    t: (key: string, fallback: string) => string,
): string {
    if (!lock) return '';
    if (lock.lessonsTotal) {
        return t('training.locked_progress', 'Finish “{course}” first — {a} of {b} lessons done')
            .replace('{course}', lock.courseTitle ?? '')
            .replace('{a}', String(lock.lessonsDone))
            .replace('{b}', String(lock.lessonsTotal));
    }
    return t('training.locked', 'Finish “{course}” first').replace('{course}', lock.courseTitle ?? '');
}
