/** Onboarding queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { fetchSetupStatus } from '../api/endpoints';
import { onboardingKeys } from '../api/keys';

/** Pre-auth and effectively static for the life of a launch. */
export function useSetupStatus() {
    return useQuery({
        queryKey: onboardingKeys.setupStatus,
        queryFn: ({ signal }) => fetchSetupStatus(signal),
        staleTime: 5 * 60_000,
    });
}
