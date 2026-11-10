/**
 * Every Microsoft Graph permission Bee Flow asks for, as the setup screens and
 * the admin consent card list them.
 *
 * Delegated (option A): every scope of the sign-in set (MICROSOFT_SCOPES in
 * auth/permissionsOAuth.js) plus the four the Microsoft 365 connect flow adds
 * (routes/integrations/microsoft365.js MS_CONNECT_SCOPES), in that order. The
 * Teams rows (role, admin consent, purpose) come from TEAMS_DELEGATED_PERMISSIONS
 * in teamsNotesSettings.js, which owns them; the rest from the table below,
 * whose admin-consent column follows Microsoft's permissions reference.
 *
 * Application (option B): the app roles organisation-wide import needs. Every
 * application permission for Microsoft Graph needs admin consent.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type PermissionRole = 'required' | 'optional' | 'requested';
export type PermissionPurpose = 'sign_in' | 'offline' | 'mail' | 'shared_mailbox' | 'calendar' | 'files' | 'contacts'
    | 'meetings' | 'recordings' | 'transcripts' | 'auto_record' | 'unused';

export interface PermissionRow {
    name: string;
    kind: 'delegated' | 'application';
    option: 'A' | 'B';
    role: PermissionRole;
    adminConsent: boolean;
    purpose: PermissionPurpose;
}

/** The scopes the connect flow asks for on top of the sign-in set. */
export const CONNECT_EXTRA_SCOPES: readonly string[] = Object.freeze(['Mail.Read.Shared', 'Mail.Send.Shared', 'Mail.ReadWrite', 'Mail.ReadWrite.Shared']);

type Meta = { role: PermissionRole; adminConsent: boolean; purpose: PermissionPurpose };

/** Non-Teams delegated scopes. Teams scopes come from teamsNotesSettings.js. */
const DELEGATED_META: Readonly<Record<string, Meta>> = Object.freeze({
    openid: { role: 'requested', adminConsent: false, purpose: 'sign_in' },
    email: { role: 'requested', adminConsent: false, purpose: 'sign_in' },
    profile: { role: 'requested', adminConsent: false, purpose: 'sign_in' },
    offline_access: { role: 'requested', adminConsent: false, purpose: 'offline' },
    'User.Read': { role: 'requested', adminConsent: false, purpose: 'sign_in' },
    'Mail.Read': { role: 'requested', adminConsent: false, purpose: 'mail' },
    'Mail.Send': { role: 'requested', adminConsent: false, purpose: 'mail' },
    'Mail.ReadWrite': { role: 'requested', adminConsent: false, purpose: 'mail' },
    'Mail.Read.Shared': { role: 'requested', adminConsent: false, purpose: 'shared_mailbox' },
    'Mail.Send.Shared': { role: 'requested', adminConsent: false, purpose: 'shared_mailbox' },
    'Mail.ReadWrite.Shared': { role: 'requested', adminConsent: false, purpose: 'shared_mailbox' },
    'Files.ReadWrite': { role: 'requested', adminConsent: false, purpose: 'files' },
    'Contacts.ReadWrite': { role: 'requested', adminConsent: false, purpose: 'contacts' },
    'OnlineMeetingArtifact.Read.All': { role: 'requested', adminConsent: false, purpose: 'unused' },
});

/** A scope nobody described yet: listed, but as asked for and unused, never as required. */
const UNDESCRIBED: Meta = Object.freeze({ role: 'requested', adminConsent: false, purpose: 'unused' });

export const APPLICATION_PERMISSIONS: readonly PermissionRow[] = Object.freeze([
    Object.freeze<PermissionRow>({ name: 'OnlineMeetings.Read.All', kind: 'application', option: 'B', role: 'required', adminConsent: true, purpose: 'meetings' }),
    Object.freeze<PermissionRow>({ name: 'OnlineMeetingRecording.Read.All', kind: 'application', option: 'B', role: 'required', adminConsent: true, purpose: 'recordings' }),
    Object.freeze<PermissionRow>({ name: 'Calendars.Read', kind: 'application', option: 'B', role: 'required', adminConsent: true, purpose: 'calendar' }),
    Object.freeze<PermissionRow>({ name: 'OnlineMeetingTranscript.Read.All', kind: 'application', option: 'B', role: 'optional', adminConsent: true, purpose: 'transcripts' }),
]);

type TeamsPermission = { name: string; role: 'required' | 'optional'; adminConsent: boolean; purpose: PermissionPurpose };

function signInScopes(): readonly string[] {
    return (nodeRequire('../../../auth/permissionsOAuth.js') as { MICROSOFT_SCOPES: readonly string[] }).MICROSOFT_SCOPES;
}

function teamsPermissions(): readonly TeamsPermission[] {
    const mod = nodeRequire('../teamsNotesSettings.js') as { TEAMS_DELEGATED_PERMISSIONS?: readonly TeamsPermission[] };
    return mod.TEAMS_DELEGATED_PERMISSIONS || [];
}

/** Every scope the connect flow requests, in the order it requests them. */
export function requestedDelegatedScopes(): string[] {
    return [...signInScopes(), ...CONNECT_EXTRA_SCOPES];
}

/** The delegated rows, one per requested scope, in request order. */
export function delegatedPermissions(): PermissionRow[] {
    const teams = new Map(teamsPermissions().map((p) => [p.name, p]));
    return requestedDelegatedScopes().map((name) => {
        const meta: Meta = teams.get(name) || DELEGATED_META[name] || UNDESCRIBED;
        return { name, kind: 'delegated', option: 'A', role: meta.role, adminConsent: meta.adminConsent, purpose: meta.purpose };
    });
}

/** The application rows, as copies (callers may serialise or sort them). */
export function applicationPermissions(): PermissionRow[] {
    return APPLICATION_PERMISSIONS.map((p) => ({ ...p }));
}

/** True when the table above or the Teams list describes the scope. */
export function isDescribedScope(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(DELEGATED_META, name) || teamsPermissions().some((p) => p.name === name);
}
