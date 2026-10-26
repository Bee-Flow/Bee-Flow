// Learning Center admin reads.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { request, RefusedError } from '../mutate';

/** The cache key of the training rules, for the save that writes the new rules into it. */
export const trainingRulesKey = ['learning', 'training-rules'] as const;

export interface TrainingRulesRead<Area, Course> { catalog: Area[]; courses: Course[]; areas: Record<string, string> }

/** GET /ai/learning/training-rules: the areas that can require a course, the courses, and the current rules. A refusal errors with its status. */
export function useTrainingRulesQuery<Area, Course>() {
    return useQuery<TrainingRulesRead<Area, Course>, Error>({
        queryKey: trainingRulesKey,
        queryFn: async ({ signal }) => {
            let res: Response;
            try {
                res = await request(`${API_BASE}/ai/learning/training-rules`, { signal });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error(String(err.status));
            }
            const body = await res.json();
            return { catalog: body.catalog || [], courses: body.courses || [], areas: body.areas || {} };
        },
        staleTime: 0,
        retry: false,
    });
}
