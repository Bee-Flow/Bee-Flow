// The Learning Center's own reads: the server's course catalog, the learner's
// progress and path, and the achievements.

import { useQuery } from '@tanstack/react-query';
import { fetchAchievements } from '../achievements';
import { fetchCatalog } from '../catalogClient';
import { mirrorLearningPath } from '../learningPath';
import { apiFetch } from '../typedRequest';
import { READ_ONCE } from './readOnce';
import type { LessonUser, ProgressMap, ServerCatalog } from '../lessons.types';

/**
 * GET /ai/learning/catalog (once per session, catalogClient keeps the answer), handed to
 * `overlay`, which lays it over the bundled catalog and returns what the screen reads of it.
 * Null while there is no server catalog: the bundled one carries the screen.
 */
export function useLearningCatalogQuery<T>(overlay: (catalog: ServerCatalog) => T) {
    return useQuery<T | null, Error>({
        queryKey: ['learning', 'catalog'],
        queryFn: async () => {
            const catalog = await fetchCatalog();
            return catalog ? overlay(catalog) : null;
        },
        ...READ_ONCE,
    });
}

export interface LearnerSettingsRead { learningProgress?: ProgressMap; learningPath?: unknown }

/**
 * GET /ai/user-settings for the learner's progress and path: the server's copy, asked every
 * time the Learning Center opens for a user, with the path it names mirrored into the
 * browser. Null when the server refused, an error when it could not be reached; either way
 * the local mirror stays what the screen shows.
 */
export function useLearnerSettingsQuery(user: LessonUser | null | undefined) {
    return useQuery<LearnerSettingsRead | null, Error>({
        queryKey: ['learning', 'learner-settings', user?.id ?? null],
        queryFn: async () => {
            const res = await apiFetch('GET /ai/user-settings');
            if (!res.ok) return null;
            const settings = (await res.json()) as LearnerSettingsRead | null;
            if (typeof settings?.learningPath === 'string' && settings.learningPath) mirrorLearningPath(user, settings.learningPath);
            return settings;
        },
        ...READ_ONCE,
        gcTime: 0,
    });
}

/**
 * GET /ai/learning/achievements: `{ badges, certificates, version }`. A failed read is an
 * error, so the answer before it stays on screen.
 */
export function useAchievementsQuery<T>(userId: string | undefined) {
    return useQuery<T, Error>({
        queryKey: ['learning', 'achievements', userId ?? null],
        queryFn: async () => {
            const data = await fetchAchievements();
            if (!data) throw new Error('achievements');
            return data as T;
        },
        ...READ_ONCE,
        gcTime: 0,
    });
}
