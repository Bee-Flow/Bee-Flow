// Org-level Meeting Notes settings (Google Meet at /api/gmeet-notes-settings,
// Nextcloud Talk at /api/talk-notes-settings).
//
// A non-ok answer or a network failure is an ERROR, never `{}`. The admin
// panels build their form from defaults plus this answer and PUT the whole
// form back, and the server rebuilds the stored document from that body with
// no merge. An empty "success" after a passing 5xx therefore showed defaults
// as if they were the org's settings, and a save then wiped every stored field
// (the custom recording folder, the fallback owner, the auto-transcribe flag).
// An error also keeps the last good answer on a failed refetch instead of
// replacing it with `{}`. The panels show the error and keep Save disabled.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { jsonOrThrow } from '../jsonOrThrow';

type NotesSettingsKind = 'gmeet' | 'talk';

export function useOrgNotesSettingsQuery<T extends object>(kind: NotesSettingsKind, orgId: string | null | undefined) {
    return useQuery<Partial<T>>({
        queryKey: ['meetingNotes', 'orgSettings', kind, orgId ?? null] as const,
        enabled: !!orgId,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/${kind}-notes-settings/${orgId}`);
            const body: unknown = await jsonOrThrow(res);
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unreadable settings answer');
            return body as Partial<T>;
        },
        staleTime: 0,
        retry: false,
    });
}
