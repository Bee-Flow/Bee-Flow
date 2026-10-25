// Which meeting sources (Nextcloud Talk, Google Meet) the signed-in user has
// connected, read from the two cheap per-user settings endpoints. Best-effort:
// a non-ok answer or a network failure is a STATE ("not connected"), never an
// exception, so the queryFns swallow both. The probes are lazy (`enabled`).

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** The probe is lazy and runs once per mount: once armed it stays armed, so toggling `enabled` does not re-probe. */
function useArmed(enabled: boolean): boolean {
    const [armed, setArmed] = useState(enabled);
    if (enabled && !armed) setArmed(true);
    return armed;
}

const meetingNotesConnectionKeys = {
    talk: ['meetingNotes', 'connection', 'talk'] as const,
    gmeet: ['meetingNotes', 'connection', 'gmeet'] as const,
};

interface TalkSettings { nextcloudConnected?: boolean }
interface GmeetSettings { connection?: { googleConnected?: boolean; meetScopesGranted?: boolean } | null }

async function readTalkSettings(): Promise<TalkSettings> {
    const res = await authFetch(`${API_BASE}/api/talk-notes-settings/user/me`);
    return res.ok ? await res.json() : {};
}

async function readGmeetSettings(): Promise<GmeetSettings> {
    const res = await authFetch(`${API_BASE}/api/gmeet-notes-settings/user/me`);
    return res.ok ? await res.json() : {};
}

/** Nextcloud Talk connection (any kind). `connected` stays false on any error. */
export function useNextcloudConnectedQuery(enabled: boolean) {
    const armed = useArmed(enabled);
    const query = useQuery<boolean>({
        queryKey: meetingNotesConnectionKeys.talk,
        enabled: armed,
        queryFn: async () => {
            try {
                return !!(await readTalkSettings()).nextcloudConnected;
            } catch {
                return false;
            }
        },
        staleTime: 0,
        retry: false,
    });
    return { connected: query.data ?? false, loading: query.isFetching };
}

/** Google Meet connection: connected with Meet scopes, or connected but needing re-consent. */
export function useGoogleMeetConnectedQuery(enabled: boolean) {
    const armed = useArmed(enabled);
    const query = useQuery<{ connected: boolean; needsReconsent: boolean }>({
        queryKey: meetingNotesConnectionKeys.gmeet,
        enabled: armed,
        queryFn: async () => {
            try {
                const data = await readGmeetSettings();
                const conn = (data && typeof data.connection === 'object' && data.connection) || {};
                return {
                    connected: !!(conn.googleConnected && conn.meetScopesGranted),
                    needsReconsent: !!(conn.googleConnected && !conn.meetScopesGranted),
                };
            } catch {
                return { connected: false, needsReconsent: false };
            }
        },
        staleTime: 0,
        retry: false,
    });
    return {
        connected: query.data?.connected ?? false,
        needsReconsent: query.data?.needsReconsent ?? false,
        loading: query.isFetching,
    };
}

/** Both sources at once, for the "Upcoming" tab gate. `loading` is true until the first answer. */
export function useMeetingSourcesQuery() {
    const query = useQuery<{ talk: boolean; gmeet: boolean }>({
        queryKey: ['meetingNotes', 'sources'] as const,
        queryFn: async () => {
            const [talk, gmeet] = await Promise.all([
                readTalkSettings().then(d => d.nextcloudConnected === true).catch(() => false),
                readGmeetSettings().then(d => d.connection?.googleConnected === true).catch(() => false),
            ]);
            return { talk, gmeet };
        },
        staleTime: 0,
        retry: false,
    });
    return { talk: query.data?.talk ?? false, gmeet: query.data?.gmeet ?? false, loading: query.isPending };
}
