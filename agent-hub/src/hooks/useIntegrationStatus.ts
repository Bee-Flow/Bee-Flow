import {
    integrationStatusKeys,
    useIntegrationStatusQuery,
    type IntegrationStatus,
} from '../api/queries/integrationStatus';
import { queryClient } from '../api/queryClient';

export type { IntegrationStatus };

export interface IntegrationStatusState {
    integrationStatus: IntegrationStatus | null;
    unavailable: boolean;
}

const UNAVAILABLE: IntegrationStatusState = Object.freeze({ integrationStatus: {}, unavailable: true });

/**
 * Forget the cached payload.
 *
 * Called from `hooks/sessionCaches.clearSessionCaches` on logout — the list
 * now lives in the shared React Query cache, which `AuthedApp` clears
 * wholesale, so this drops just this one read for a screen that changed it.
 */
export function invalidateIntegrationStatus(): void {
    // remove, not reset or invalidate: logout calls this while the old
    // user's screens are still mounted and their session token still set,
    // and either of those would refetch for the old user on the way out.
    queryClient.removeQueries({ queryKey: integrationStatusKeys.all });
}

/**
 * Integration status for availability gating.
 *
 * Consumers without access to AgentEditorBootstrapContext (e.g. SkillsStudio)
 * use this hook; BuilderSplit keeps its bootstrap-provided copy.
 *
 * THREE answers, not two:
 *
 *   integrationStatus === null   not read yet — claim nothing
 *   unavailable === true         the read failed. `integrationStatus` is `{}`
 *                                and NOT null, so no existing gate widens on
 *                                a blip; a caller that draws a list from it
 *                                has to say the list is short
 *   otherwise                    the payload
 *
 * A failed read is never cached: the next mount asks again.
 */
export function useIntegrationStatus(): IntegrationStatusState {
    const query = useIntegrationStatusQuery();
    if (query.error) return UNAVAILABLE;
    return { integrationStatus: query.data ?? null, unavailable: false };
}
