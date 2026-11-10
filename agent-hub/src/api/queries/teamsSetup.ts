// Microsoft Teams meeting notes: setup and diagnostics (server: routes/teamsSetup.mts at
// /api/teams-setup, core/meetingNotes/teamsSetup/checks.mts). The org is always the caller's
// session organisation: no request here names one. The shapes are a mirror of the server's
// (contract sections 2 and 3, option B included); components import them through
// components/meetings/teamsSetup/types.ts.

import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped' | 'unknown';
export type Fixer = 'user' | 'org_admin' | 'entra_admin' | 'teams_admin' | 'platform_admin';
export type CheckParams = Record<string, string | number | boolean | string[]>;

export interface TeamsCheck {
    /** Catalogue id, e.g. 'a.connection'. */
    id: string;
    option: 'A' | 'B' | 'app';
    status: CheckStatus;
    /** Stable snake_case result code. */
    code: string;
    /** Allow-listed keys only. */
    params: CheckParams;
    /** Full i18n key 'teams_setup.fix.<name>'. */
    remediation: string | null;
    fixer: Fixer | null;
    /** Prerequisite ids from the catalogue. */
    dependsOn: string[];
}

export interface TeamsDiagnosticsReport {
    level: 'platform' | 'user' | 'org' | 'org_app';
    /** ISO time. */
    ranAt: string;
    overall: 'pass' | 'warn' | 'fail';
    /** In catalogue order. */
    checks: TeamsCheck[];
}

export type PermissionPurpose = 'sign_in' | 'offline' | 'mail' | 'shared_mailbox' | 'calendar' | 'files' | 'contacts'
    | 'meetings' | 'recordings' | 'transcripts' | 'auto_record' | 'unused';
export type PermissionRole = 'required' | 'optional' | 'requested';

export interface PermissionRow {
    /** e.g. 'OnlineMeetingRecording.Read.All'. */
    name: string;
    kind: 'delegated' | 'application';
    option: 'A' | 'B';
    /** requested = asked by Bee Flow, not needed by Teams notes. */
    role: PermissionRole;
    adminConsent: boolean;
    purpose: PermissionPurpose;
}

export interface TeamsRequirements {
    tenantMode: 'single' | 'common' | 'organizations' | 'consumers' | 'not_configured';
    redirectUris: { signIn: string; connect: string };
    delegated: PermissionRow[];
    application: PermissionRow[];
}

export type TeamsSkipReason = 'not_licensed' | 'no_credential' | 'credential_needs_reauth' | 'credential_revoked'
    | 'missing_scopes' | 'session_unavailable' | 'app_token_failed';

export interface TeamsMemberRow {
    userId: string;
    displayName: string | null;
    username: string | null;
    meetingNotesAccess: boolean;
    microsoft: 'none' | 'active' | 'needs_reauth' | 'revoked';
    missingPermissions: string[];
    teamsReady: boolean;
    verifiedMicrosoftIdentity: boolean;
    autoImportSkip: { reason: TeamsSkipReason; missingPermissions: string[]; at: string } | null;
    /** teams_import_jobs error codes in the window, count desc. */
    failures: { code: string; count: number }[];
    appImportCovered: boolean;
}

export interface TeamsOrgOverview {
    windowDays: number;
    generatedAt: string;
    /** More active members than the server shows. */
    truncated: boolean;
    /** The org document; null = members decide. */
    settings: { autoImport: boolean | null; autoRecordConfig: boolean | null };
    /** org.consent_link, org.admin_consent. */
    checks: TeamsCheck[];
    totals: { members: number; connected: number; missingPermissions: number; needsReauth: number; skipped: number; failedImports: number };
    members: TeamsMemberRow[];
}

export type ConsentUnavailableReason = 'tenant_unknown' | 'tenant_consumers' | 'app_not_configured';

export type ConsentLinkResponse =
    | {
        available: true; url: string; tenantId: string; tenantSource: 'configured' | 'your_account';
        redirectUri: string; expiresAt: string;
        permissions: { delegated: PermissionRow[]; application: PermissionRow[] };
    }
    | { available: false; reason: ConsentUnavailableReason };

/** The answer of POST /auth/providers/microsoft/test: `message` on success, `error` otherwise. */
export interface MicrosoftAppTestAnswer {
    success?: boolean;
    message?: string;
    error?: string;
    report?: TeamsDiagnosticsReport;
}

// Option B (organisation-wide import with application permissions).

export type CoverageReason = 'instance_disabled' | 'not_enabled' | 'tenant_not_bound' | 'tenant_changed' | 'inactive'
    | 'other_organisation' | 'no_identity' | 'other_tenant' | 'not_selected' | 'no_access' | 'app_not_configured';

export interface TeamsAppImportState {
    settings: {
        enabled: boolean; coverage: 'all' | 'selected'; selectedUserIds: string[];
        tenantId: string | null; enabledAt: string | null; enabledBy: string | null; updatedAt: string | null;
    };
    availability: {
        reason: 'ok' | 'instance_disabled' | 'tenant_not_bound' | 'tenant_mismatch_sso' | 'app_not_configured';
        tenantId: string | null; source: 'directory_binding' | 'single_org' | null;
    };
    counts: { eligible: number; covered: number; withoutIdentity: number; otherTenant: number; withoutAccess: number; notSelected: number };
}

export interface AppImportBody {
    enabled: boolean;
    coverage: 'all' | 'selected';
    selectedUserIds: string[];
}

export interface AppImportDiagBody {
    probeUserId?: string;
}

// ---------------------------------------------------------------------------
// Hooks

const teamsSetupKeys = {
    requirements: ['teamsSetup', 'requirements'] as const,
    overview: (days: number) => ['teamsSetup', 'orgOverview', days] as const,
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Shape checks of the answers: enough to render without crashing, the rest is the server's contract.
/** A diagnostics report: an object with a list of checks. */
export function isDiagnosticsReport(v: unknown): v is TeamsDiagnosticsReport {
    return isObject(v) && Array.isArray(v.checks);
}
const isRequirements = (v: unknown): v is TeamsRequirements =>
    isObject(v) && Array.isArray(v.delegated) && Array.isArray(v.application);
const isOrgOverview = (v: unknown): v is TeamsOrgOverview =>
    isObject(v) && Array.isArray(v.members) && Array.isArray(v.checks) && isObject(v.totals);
const isConsentLinkResponse = (v: unknown): v is ConsentLinkResponse => isObject(v) && typeof v.available === 'boolean';

function asReport(body: unknown): TeamsDiagnosticsReport {
    if (!isDiagnosticsReport(body)) throw new Error('Unreadable Teams diagnostics answer');
    return body;
}

/** True when the server refused a test because the previous one was seconds ago. */
export function isDiagnosticsRateLimited(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    const code = isObject(err.body) ? err.body.code : undefined;
    return err.status === 429 || code === 'diagnostics_rate_limited';
}

/**
 * What the Microsoft app registration needs (permissions, redirect URIs). No Graph call.
 * The request is behind the Meeting Notes licence and module: when those are off it fails,
 * and the caller shows nothing Teams-specific.
 */
export function useTeamsRequirements(enabled = true) {
    return useQuery<TeamsRequirements, Error>({
        queryKey: teamsSetupKeys.requirements,
        queryFn: async ({ signal }) => {
            const body: unknown = await apiClient.get<TeamsRequirements>('/api/teams-setup/requirements', { signal, retry: false });
            if (!isRequirements(body)) throw new Error('Unreadable Teams requirements answer');
            return body;
        },
        enabled,
        retry: false,
        staleTime: 5 * 60_000,
    });
}

/** Run the checklist for the caller's own Microsoft connection (read-only on Microsoft's side). */
export function useRunMyTeamsDiagnostics() {
    return useMutation<TeamsDiagnosticsReport, Error, void>({
        mutationFn: async () => asReport(await apiClient.post('/api/teams-setup/me/diagnostics', undefined, { retry: false })),
    });
}

/** The members overview of the caller's organisation, from stored state only (org admins). */
export function useTeamsOrgOverview(days: number, enabled = true) {
    return useQuery<TeamsOrgOverview, Error>({
        queryKey: teamsSetupKeys.overview(days),
        queryFn: async ({ signal }) => {
            const body: unknown = await apiClient.get<TeamsOrgOverview>('/api/teams-setup/org/overview', { signal, retry: false, query: { days } });
            if (!isOrgOverview(body)) throw new Error('Unreadable Teams members overview');
            return body;
        },
        enabled,
        retry: false,
    });
}

/** Make an admin consent link for the caller's organisation (org admins). */
export function useCreateTeamsConsentLink() {
    return useMutation<ConsentLinkResponse, Error, void>({
        mutationFn: async () => {
            const body: unknown = await apiClient.post('/api/teams-setup/org/consent-link', undefined, { retry: false });
            if (!isConsentLinkResponse(body)) throw new Error('Unreadable consent link answer');
            return body;
        },
    });
}
