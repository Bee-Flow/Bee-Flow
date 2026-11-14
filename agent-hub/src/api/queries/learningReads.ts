// Learning Center admin reads.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { request, RefusedError } from '../mutate';
import { useAdminOrgScope, withOrgIdParam } from '../adminOrgScope';

/** The cache key of the training rules of an organisation (null: the caller's own), for the save that writes the new rules into it. */
export const trainingRulesKey = (orgId: string | null) => ['learning', 'training-rules', orgId] as const;

/** The training rules address, for the organisation an AdminOrgScopeProvider names (null: the caller's own). */
const trainingRulesPath = (orgId: string | null) => withOrgIdParam(`${API_BASE}/ai/learning/training-rules`, orgId);

export interface TrainingRulesRead<Area, Course> { catalog: Area[]; courses: Course[]; areas: Record<string, string> }

/** GET /ai/learning/training-rules: the areas that can require a course, the courses, and the current rules. A refusal errors with its status. */
export function useTrainingRulesQuery<Area, Course>() {
    const orgId = useAdminOrgScope();
    return useQuery<TrainingRulesRead<Area, Course>, Error>({
        queryKey: trainingRulesKey(orgId),
        queryFn: async ({ signal }) => {
            let res: Response;
            try {
                res = await request(trainingRulesPath(orgId), { signal });
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
