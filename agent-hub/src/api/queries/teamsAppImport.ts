// Microsoft Teams → Meeting Notes, option B: organisation-wide import with the app's own
// (application) permissions (server: routes/teamsSetup.mts, /api/teams-setup/org/app-import).
// The org is always the caller's session organisation: no request here names one. The
// shapes live in ./teamsSetup next to the other Teams setup types.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';
import { isDiagnosticsReport } from './teamsSetup';
import type { AppImportBody, AppImportDiagBody, TeamsAppImportState, TeamsDiagnosticsReport } from './teamsSetup';

const APP_IMPORT_PATH = '/api/teams-setup/org/app-import';

const teamsAppImportKeys = {
    state: ['teamsSetup', 'appImport'] as const,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Enough of the shape to render; the rest is the server's contract. */
const isAppImportState = (v: unknown): v is TeamsAppImportState =>
    isObject(v) && isObject(v.settings) && isObject(v.availability) && isObject(v.counts);

function asState(body: unknown): TeamsAppImportState {
    if (!isAppImportState(body)) throw new Error('Unreadable organisation-wide import answer');
    return body;
}

/** The stable error code of a refused save or test ('not_a_member', ...), or null. */
export function appImportErrorCode(err: unknown): string | null {
    if (!(err instanceof ApiError) || !isObject(err.body)) return null;
    return typeof err.body.code === 'string' ? err.body.code : null;
}

/** Settings, availability and coverage counts of organisation-wide import (org admins). */
export function useTeamsAppImport(enabled = true) {
    return useQuery<TeamsAppImportState, Error>({
        queryKey: teamsAppImportKeys.state,
        queryFn: async ({ signal }) => asState(await apiClient.get<TeamsAppImportState>(APP_IMPORT_PATH, { signal, retry: false })),
        enabled,
        retry: false,
    });
}

/**
 * Save the settings. The answer is the new state; the members overview is asked again
 * because who is covered may have changed.
 */
export function useSaveTeamsAppImport() {
    const qc = useQueryClient();
    return useMutation<TeamsAppImportState, Error, AppImportBody>({
        mutationFn: async (body) => asState(await apiClient.put(APP_IMPORT_PATH, {
            enabled: body.enabled, coverage: body.coverage, selectedUserIds: body.selectedUserIds,
        }, { retry: false })),
        onSuccess: (state) => {
            qc.setQueryData(teamsAppImportKeys.state, state);
            void qc.invalidateQueries({ queryKey: ['teamsSetup', 'orgOverview'] });
        },
    });
}

/** Run the option B checklist, optionally for one covered member (read-only on Microsoft's side). */
export function useRunTeamsAppImportDiagnostics() {
    return useMutation<TeamsDiagnosticsReport, Error, AppImportDiagBody>({
        mutationFn: async (body) => {
            const sent: AppImportDiagBody = body.probeUserId ? { probeUserId: body.probeUserId } : {};
            const answer: unknown = await apiClient.post(`${APP_IMPORT_PATH}/diagnostics`, sent, { retry: false });
            if (!isDiagnosticsReport(answer)) throw new Error('Unreadable Teams diagnostics answer');
            return answer;
        },
    });
}
