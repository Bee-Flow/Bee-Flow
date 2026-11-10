// Shapes of the Teams setup and diagnostics API (server: routes/teamsSetup.mts at
// /api/teams-setup, core/meetingNotes/teamsSetup/checks.mts, and the Microsoft branch of
// POST /auth/providers/microsoft/test), option B included. They are defined next to the
// query hooks in api/queries/teamsSetup.ts, because api/ may not import from components/;
// components import them from here.

export type {
    AppImportBody,
    CheckParams,
    CheckStatus,
    ConsentUnavailableReason,
    CoverageReason,
    Fixer,
    MicrosoftAppTestAnswer,
    PermissionPurpose,
    PermissionRole,
    PermissionRow,
    TeamsAppImportState,
    TeamsCheck,
    TeamsDiagnosticsReport,
    TeamsMemberRow,
    TeamsRequirements,
    TeamsSkipReason,
} from '@/api/queries/teamsSetup';
