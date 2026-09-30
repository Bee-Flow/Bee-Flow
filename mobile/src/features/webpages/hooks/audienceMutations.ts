/**
 * Writes behind the Share and Data tabs: making the page public (or not),
 * and what the page's bridges may run. Going public changes the page row
 * (its address) and its links, so the whole page is refreshed.
 */

import { useQueryClient } from '@tanstack/react-query';

import { usePageMutation, type Handlers } from './pageMutation';
import { grantAutomation, revokeGrant, setPublic } from '../api/audienceEndpoints';
import { webpageKeys } from '../api/keys';
import type { PublicChoice, WebpageAudience } from '../model/audienceTypes';

const GRANTS = (id: string) => [webpageKeys.grants(id), webpageKeys.dataCards(id)];

export function useSetPublic(id: string, handlers: Handlers<WebpageAudience, PublicChoice> = {}) {
    const queryClient = useQueryClient();
    return usePageMutation(
        id,
        async (choice: PublicChoice) => {
            const model = await setPublic(id, choice);
            // The answer IS the new model; showing it now saves a round trip.
            queryClient.setQueryData(webpageKeys.audience(id), model);
            return model;
        },
        { handlers },
    );
}

export function useGrantAutomation(
    id: string,
    handlers: Handlers<void, { automationId: string; label?: string }> = {},
) {
    return usePageMutation(
        id,
        ({ automationId, label }: { automationId: string; label?: string }) => grantAutomation(id, automationId, label),
        { handlers, refresh: GRANTS },
    );
}

export interface GrantRef {
    kind: 'integrations' | 'automations';
    key: string;
}

export function useRevokeGrant(id: string, handlers: Handlers<void, GrantRef> = {}) {
    return usePageMutation(id, ({ kind, key }: GrantRef) => revokeGrant(id, kind, key), { handlers, refresh: GRANTS });
}
