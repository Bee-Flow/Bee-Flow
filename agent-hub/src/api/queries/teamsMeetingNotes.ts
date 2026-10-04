// Microsoft Teams → Meeting Notes (server: routes/teamsNotesSettings.js at
// /api/teams-notes-settings, and routes/transcriptions/teams.js under
// /api/transcriptions). Graph only gives recordings to the meeting organizer,
// so every import here is for meetings the user organised.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

export interface TeamsConnection {
    microsoftConnected: boolean;
    /** Calendar + OnlineMeetingRecording.Read.All granted. */
    teamsScopesGranted: boolean;
    /** OnlineMeetings.ReadWrite granted (Teams' own auto-recording). */
    hasMeetingWriteScope: boolean;
    /** OnlineMeetingTranscript.Read.All granted (transcript fallback). */
    hasTranscriptScope: boolean;
    needsReauth: boolean;
}

export interface TeamsNotesSettings {
    autoImport: boolean | null;
    autoRecordConfig: boolean | null;
    language: string | null;
    lookbackHours: number | null;
    updatedAt?: string | null;
    updatedBy?: string | null;
}

export interface TeamsNotesUserSettings extends TeamsNotesSettings {
    connection: TeamsConnection;
}

export type TeamsRecordingState = 'available' | 'transcript_only' | 'none';

export interface TeamsRecordingItem {
    eventId: string;
    title: string | null;
    start: string | null;
    end: string | null;
    recordingState: TeamsRecordingState;
    importedNoteId: string | null;
}

export const teamsMeetingNotesKeys = {
    userSettings: ['teamsMeetingNotes', 'userSettings'] as const,
    recordings: ['teamsMeetingNotes', 'recordings'] as const,
};

const NOT_CONNECTED: TeamsConnection = {
    microsoftConnected: false,
    teamsScopesGranted: false,
    hasMeetingWriteScope: false,
    hasTranscriptScope: false,
    needsReauth: false,
};

/**
 * The user's own Teams settings plus the connection block. A 403/404 means
 * Meeting Notes is not licensed for this account: the query then errors and
 * callers hide their Teams UI.
 */
export function useTeamsNotesUserSettings(enabled = true) {
    return useQuery<TeamsNotesUserSettings, Error>({
        queryKey: teamsMeetingNotesKeys.userSettings,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<TeamsNotesUserSettings>('/api/teams-notes-settings/user/me', { signal, retry: false });
            return body || { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24, connection: NOT_CONNECTED };
        },
        enabled,
        retry: false,
        staleTime: 60_000,
    });
}

export function useSaveTeamsNotesUserSettings() {
    const qc = useQueryClient();
    return useMutation<unknown, Error, TeamsNotesSettings>({
        mutationFn: (settings) => apiClient.put('/api/teams-notes-settings/user/me', settings, { retry: false }),
        onSettled: () => qc.invalidateQueries({ queryKey: teamsMeetingNotesKeys.userSettings }),
    });
}

/** Recently ended Teams meetings the user organised, for the import panel. */
export function useTeamsRecordings(enabled = true) {
    return useQuery<{ connection: TeamsConnection; items: TeamsRecordingItem[] }, Error>({
        queryKey: teamsMeetingNotesKeys.recordings,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ connection: TeamsConnection; items: TeamsRecordingItem[] }>(
                '/api/transcriptions/teams-recordings', { signal, retry: false },
            );
            return { connection: body?.connection || NOT_CONNECTED, items: Array.isArray(body?.items) ? body.items : [] };
        },
        enabled,
        retry: false,
    });
}

/** Refresh both after a reconnect, so the new scopes show at once. */
export function useInvalidateTeamsMeetingNotes() {
    const qc = useQueryClient();
    return () => Promise.all([
        qc.invalidateQueries({ queryKey: teamsMeetingNotesKeys.userSettings }),
        qc.invalidateQueries({ queryKey: teamsMeetingNotesKeys.recordings }),
    ]);
}

/** The organisation's Teams settings (admin panel). `null` per field = each member decides. */
export function useTeamsNotesOrgSettings(orgId: string | null | undefined) {
    return useQuery<TeamsNotesSettings, Error>({
        queryKey: ['teamsMeetingNotes', 'orgSettings', orgId],
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<TeamsNotesSettings>(`/api/teams-notes-settings/${encodeURIComponent(String(orgId))}`, { signal, retry: false });
            return body || { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 };
        },
        enabled: !!orgId,
        retry: false,
    });
}

export function useSaveTeamsNotesOrgSettings(orgId: string | null | undefined) {
    const qc = useQueryClient();
    return useMutation<unknown, Error, TeamsNotesSettings>({
        mutationFn: (settings) => apiClient.put(`/api/teams-notes-settings/${encodeURIComponent(String(orgId))}`, settings, { retry: false }),
        onSettled: () => qc.invalidateQueries({ queryKey: ['teamsMeetingNotes', 'orgSettings', orgId] }),
    });
}
