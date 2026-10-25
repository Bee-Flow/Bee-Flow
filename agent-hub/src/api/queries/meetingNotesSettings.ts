// Org-level Meeting Notes settings (Google Meet at /api/gmeet-notes-settings,
// Nextcloud Talk at /api/talk-notes-settings). A non-ok answer or a network
// failure leaves the panel on its defaults, so the queryFn resolves `{}`.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';

type NotesSettingsKind = 'gmeet' | 'talk';

export function useOrgNotesSettingsQuery<T extends object>(kind: NotesSettingsKind, orgId: string | null | undefined) {
    return useQuery<Partial<T>>({
        queryKey: ['meetingNotes', 'orgSettings', kind, orgId ?? null] as const,
        enabled: !!orgId,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/${kind}-notes-settings/${orgId}`);
                return res.ok ? await res.json() : {};
            } catch (err) {
                logger.debug('ignore', err);
                return {};
            }
        },
        staleTime: 0,
        retry: false,
    });
}
