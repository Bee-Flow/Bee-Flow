// The words for a Teams diagnostics report: check titles, result sentences, what to do,
// who can fix it, the status labels, auto-import skip reasons, organisation-wide coverage
// reasons, permission purposes and roles, and the import failure codes of the members
// overview. One literal t() call per key, so the i18n guard sees every key; an unknown
// value falls back as written on each function.

import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import type { CheckParams, CheckStatus, CoverageReason, Fixer, PermissionPurpose, PermissionRole, TeamsDiagnosticsReport, TeamsSkipReason } from './types';

type Words = (t: TranslateFn, params?: TranslateParams) => string;

const own = (table: Record<string, unknown>, key: string | null | undefined): key is string =>
    typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/** The check id ('a.scope_calendar') to its title. */
const CHECK_TITLES: Record<string, Words> = {
    'app.config': (t) => t('teams_setup.check.app_config'),
    'app.token': (t) => t('teams_setup.check.app_token'),
    'app.redirect_uris': (t) => t('teams_setup.check.app_redirect_uris'),
    'app.configured': (t) => t('teams_setup.check.app_configured'),
    'product.access': (t) => t('teams_setup.check.product_access'),
    'a.connection': (t) => t('teams_setup.check.a_connection'),
    'a.scope_calendar': (t) => t('teams_setup.check.a_scope_calendar'),
    'a.scope_recordings': (t) => t('teams_setup.check.a_scope_recordings'),
    'a.scope_transcripts': (t) => t('teams_setup.check.a_scope_transcripts'),
    'a.auto_record': (t) => t('teams_setup.check.a_auto_record'),
    'a.calendar': (t) => t('teams_setup.check.a_calendar'),
    'a.meeting_lookup': (t) => t('teams_setup.check.a_meeting_lookup'),
    'a.recordings': (t) => t('teams_setup.check.a_recordings'),
    'a.transcripts': (t) => t('teams_setup.check.a_transcripts'),
    'a.transcript_content': (t) => t('teams_setup.check.a_transcript_content'),
    'a.background_access': (t) => t('teams_setup.check.a_background_access'),
    'a.auto_import': (t) => t('teams_setup.check.a_auto_import'),
    'org.consent_link': (t) => t('teams_setup.check.org_consent_link'),
    'org.admin_consent': (t) => t('teams_setup.check.org_admin_consent'),
    'b.instance': (t) => t('teams_setup.check.b_instance'),
    'b.org_tenant': (t) => t('teams_setup.check.b_org_tenant'),
    'b.app_credentials': (t) => t('teams_setup.check.b_app_credentials'),
    'b.app_token': (t) => t('teams_setup.check.b_app_token'),
    'b.role_meetings': (t) => t('teams_setup.check.b_role_meetings'),
    'b.role_recordings': (t) => t('teams_setup.check.b_role_recordings'),
    'b.role_calendar': (t) => t('teams_setup.check.b_role_calendar'),
    'b.role_transcripts': (t) => t('teams_setup.check.b_role_transcripts'),
    'b.role_unused': (t) => t('teams_setup.check.b_role_unused'),
    'b.enabled': (t) => t('teams_setup.check.b_enabled'),
    'b.coverage': (t) => t('teams_setup.check.b_coverage'),
    'b.probe_user': (t) => t('teams_setup.check.b_probe_user'),
    'b.calendar': (t) => t('teams_setup.check.b_calendar'),
    'b.access_policy': (t) => t('teams_setup.check.b_access_policy'),
    'b.recordings': (t) => t('teams_setup.check.b_recordings'),
    'b.transcripts': (t) => t('teams_setup.check.b_transcripts'),
};

/** Result code to its sentence; placeholders come from the check's params. */
const CODE_TEXT: Record<string, Words> = {
    ok: (t, p) => t('teams_setup.code.ok', p),
    prerequisite_failed: (t, p) => (p?.prerequisite
        ? t('teams_setup.code.prerequisite_failed_named', p)
        : t('teams_setup.code.prerequisite_failed', p)),
    client_id_missing: (t, p) => t('teams_setup.code.client_id_missing', p),
    client_id_invalid: (t, p) => t('teams_setup.code.client_id_invalid', p),
    secret_missing: (t, p) => t('teams_setup.code.secret_missing', p),
    tenant_invalid: (t, p) => t('teams_setup.code.tenant_invalid', p),
    tenant_consumers: (t, p) => t('teams_setup.code.tenant_consumers', p),
    tenant_needed: (t, p) => t('teams_setup.code.tenant_needed', p),
    secret_invalid: (t, p) => t('teams_setup.code.secret_invalid', p),
    secret_expired: (t, p) => t('teams_setup.code.secret_expired', p),
    app_not_in_tenant: (t, p) => t('teams_setup.code.app_not_in_tenant', p),
    resource_principal_missing: (t, p) => t('teams_setup.code.resource_principal_missing', p),
    tenant_not_found: (t, p) => t('teams_setup.code.tenant_not_found', p),
    app_disabled: (t, p) => t('teams_setup.code.app_disabled', p),
    consent_missing: (t, p) => t('teams_setup.code.consent_missing', p),
    admin_consent_required: (t, p) => t('teams_setup.code.admin_consent_required', p),
    consent_declined: (t, p) => t('teams_setup.code.consent_declined', p),
    permission_not_on_app: (t, p) => t('teams_setup.code.permission_not_on_app', p),
    blocked_by_conditional_access: (t, p) => t('teams_setup.code.blocked_by_conditional_access', p),
    mfa_required: (t, p) => t('teams_setup.code.mfa_required', p),
    user_not_assigned: (t, p) => t('teams_setup.code.user_not_assigned', p),
    redirect_uri_mismatch: (t, p) => t('teams_setup.code.redirect_uri_mismatch', p),
    account_not_in_tenant: (t, p) => t('teams_setup.code.account_not_in_tenant', p),
    single_tenant_app_common: (t, p) => t('teams_setup.code.single_tenant_app_common', p),
    app_not_for_tenant: (t, p) => t('teams_setup.code.app_not_for_tenant', p),
    entra_error: (t, p) => t('teams_setup.code.entra_error', p),
    entra_error_no_code: (t, p) => t('teams_setup.code.entra_error_no_code', p),
    entra_unreachable: (t, p) => t('teams_setup.code.entra_unreachable', p),
    manual_check: (t, p) => t('teams_setup.code.manual_check', p),
    probe_timeout: (t, p) => t('teams_setup.code.probe_timeout', p),
    capability_missing: (t, p) => t('teams_setup.code.capability_missing', p),
    app_not_configured: (t, p) => t('teams_setup.code.app_not_configured', p),
    not_connected: (t, p) => t('teams_setup.code.not_connected', p),
    needs_reauth: (t, p) => t('teams_setup.code.needs_reauth', p),
    scope_missing: (t, p) => t('teams_setup.code.scope_missing', p),
    calendar_forbidden: (t, p) => t('teams_setup.code.calendar_forbidden', p),
    graph_throttled: (t, p) => t('teams_setup.code.graph_throttled', p),
    graph_unavailable: (t, p) => t('teams_setup.code.graph_unavailable', p),
    graph_error: (t, p) => t('teams_setup.code.graph_error', p),
    no_teams_meetings: (t, p) => t('teams_setup.code.no_teams_meetings', p),
    no_meeting_to_probe: (t, p) => t('teams_setup.code.no_meeting_to_probe', p),
    recording_not_allowed: (t, p) => t('teams_setup.code.recording_not_allowed', p),
    meeting_not_available: (t, p) => t('teams_setup.code.meeting_not_available', p),
    needs_teams_scopes: (t, p) => t('teams_setup.code.needs_teams_scopes', p),
    graph_forbidden: (t, p) => t('teams_setup.code.graph_forbidden', p),
    transcript_api_disabled: (t, p) => t('teams_setup.code.transcript_api_disabled', p),
    no_transcript_to_probe: (t, p) => t('teams_setup.code.no_transcript_to_probe', p),
    speaker_attribution_off: (t, p) => t('teams_setup.code.speaker_attribution_off', p),
    application_access_policy_missing: (t, p) => t('teams_setup.code.application_access_policy_missing', p),
    no_stored_connection: (t, p) => t('teams_setup.code.no_stored_connection', p),
    stored_connection_missing_scopes: (t, p) => t('teams_setup.code.stored_connection_missing_scopes', p),
    stored_connection_expired: (t, p) => t('teams_setup.code.stored_connection_expired', p),
    auto_import_off: (t, p) => t('teams_setup.code.auto_import_off', p),
    auto_import_skipped: (t, p) => t('teams_setup.code.auto_import_skipped', p),
    tenant_unknown: (t, p) => t('teams_setup.code.tenant_unknown', p),
    consent_granted: (t, p) => t('teams_setup.code.consent_granted', p),
    consent_denied: (t, p) => t('teams_setup.code.consent_denied', p),
    consent_tenant_mismatch: (t, p) => t('teams_setup.code.consent_tenant_mismatch', p),
    consent_not_recorded: (t, p) => t('teams_setup.code.consent_not_recorded', p),
    app_import_disabled_instance: (t, p) => t('teams_setup.code.app_import_disabled_instance', p),
    tenant_not_bound: (t, p) => t('teams_setup.code.tenant_not_bound', p),
    tenant_mismatch_sso: (t, p) => t('teams_setup.code.tenant_mismatch_sso', p),
    role_missing: (t, p) => t('teams_setup.code.role_missing', p),
    roles_unreadable: (t, p) => t('teams_setup.code.roles_unreadable', p),
    unused_roles: (t, p) => t('teams_setup.code.unused_roles', p),
    not_enabled: (t, p) => t('teams_setup.code.not_enabled', p),
    nobody_covered: (t, p) => t('teams_setup.code.nobody_covered', p),
    no_probe_user: (t, p) => t('teams_setup.code.no_probe_user', p),
    probe_user_not_covered: (t, p) => t('teams_setup.code.probe_user_not_covered', p),
};

/** Full remediation key to its text. */
const FIX_TEXT: Record<string, Words> = {
    'teams_setup.fix.enter_client_id': (t) => t('teams_setup.fix.enter_client_id'),
    'teams_setup.fix.enter_secret': (t) => t('teams_setup.fix.enter_secret'),
    'teams_setup.fix.enter_tenant': (t) => t('teams_setup.fix.enter_tenant'),
    'teams_setup.fix.tenant_not_consumers': (t) => t('teams_setup.fix.tenant_not_consumers'),
    'teams_setup.fix.sign_in_with_microsoft_or_set_tenant': (t) => t('teams_setup.fix.sign_in_with_microsoft_or_set_tenant'),
    'teams_setup.fix.new_client_secret': (t) => t('teams_setup.fix.new_client_secret'),
    'teams_setup.fix.app_not_in_tenant': (t) => t('teams_setup.fix.app_not_in_tenant'),
    'teams_setup.fix.app_disabled': (t) => t('teams_setup.fix.app_disabled'),
    'teams_setup.fix.add_permissions_to_app': (t) => t('teams_setup.fix.add_permissions_to_app'),
    'teams_setup.fix.admin_consent_needed': (t) => t('teams_setup.fix.admin_consent_needed'),
    'teams_setup.fix.consent_denied': (t) => t('teams_setup.fix.consent_denied'),
    'teams_setup.fix.conditional_access': (t) => t('teams_setup.fix.conditional_access'),
    'teams_setup.fix.mfa_required': (t) => t('teams_setup.fix.mfa_required'),
    'teams_setup.fix.assign_user': (t) => t('teams_setup.fix.assign_user'),
    'teams_setup.fix.register_redirect_uris': (t) => t('teams_setup.fix.register_redirect_uris'),
    'teams_setup.fix.account_not_in_tenant': (t) => t('teams_setup.fix.account_not_in_tenant'),
    'teams_setup.fix.app_audience': (t) => t('teams_setup.fix.app_audience'),
    'teams_setup.fix.see_microsoft_error': (t) => t('teams_setup.fix.see_microsoft_error'),
    'teams_setup.fix.check_network': (t) => t('teams_setup.fix.check_network'),
    'teams_setup.fix.grant_meeting_notes_access': (t) => t('teams_setup.fix.grant_meeting_notes_access'),
    'teams_setup.fix.configure_app_registration': (t) => t('teams_setup.fix.configure_app_registration'),
    'teams_setup.fix.connect_microsoft': (t) => t('teams_setup.fix.connect_microsoft'),
    'teams_setup.fix.reconnect_microsoft': (t) => t('teams_setup.fix.reconnect_microsoft'),
    'teams_setup.fix.reconnect_to_grant': (t) => t('teams_setup.fix.reconnect_to_grant'),
    'teams_setup.fix.calendar_access': (t) => t('teams_setup.fix.calendar_access'),
    'teams_setup.fix.try_again_later': (t) => t('teams_setup.fix.try_again_later'),
    'teams_setup.fix.schedule_test_meeting': (t) => t('teams_setup.fix.schedule_test_meeting'),
    'teams_setup.fix.allow_cloud_recording': (t) => t('teams_setup.fix.allow_cloud_recording'),
    'teams_setup.fix.meeting_not_available': (t) => t('teams_setup.fix.meeting_not_available'),
    'teams_setup.fix.graph_forbidden': (t) => t('teams_setup.fix.graph_forbidden'),
    'teams_setup.fix.enable_transcript_api': (t) => t('teams_setup.fix.enable_transcript_api'),
    'teams_setup.fix.enable_speaker_attribution': (t) => t('teams_setup.fix.enable_speaker_attribution'),
    'teams_setup.fix.connect_for_background': (t) => t('teams_setup.fix.connect_for_background'),
    'teams_setup.fix.turn_on_auto_import': (t) => t('teams_setup.fix.turn_on_auto_import'),
    'teams_setup.fix.turn_on_auto_import_org': (t) => t('teams_setup.fix.turn_on_auto_import_org'),
    'teams_setup.fix.open_consent_link': (t) => t('teams_setup.fix.open_consent_link'),
    'teams_setup.fix.instance_disabled': (t) => t('teams_setup.fix.instance_disabled'),
    'teams_setup.fix.bind_directory': (t) => t('teams_setup.fix.bind_directory'),
    'teams_setup.fix.grant_application_permission': (t) => t('teams_setup.fix.grant_application_permission'),
    'teams_setup.fix.remove_unused_permissions': (t) => t('teams_setup.fix.remove_unused_permissions'),
    'teams_setup.fix.enable_app_import': (t) => t('teams_setup.fix.enable_app_import'),
    'teams_setup.fix.members_sign_in_with_microsoft': (t) => t('teams_setup.fix.members_sign_in_with_microsoft'),
    'teams_setup.fix.pick_probe_user': (t) => t('teams_setup.fix.pick_probe_user'),
    'teams_setup.fix.grant_access_policy': (t) => t('teams_setup.fix.grant_access_policy'),
    'teams_setup.fix.calendar_application_access': (t) => t('teams_setup.fix.calendar_application_access'),
};

const SKIP_TEXT: Record<string, Words> = {
    not_licensed: (t, p) => t('teams_setup.skip.not_licensed', p),
    no_credential: (t, p) => t('teams_setup.skip.no_credential', p),
    credential_needs_reauth: (t, p) => t('teams_setup.skip.credential_needs_reauth', p),
    credential_revoked: (t, p) => t('teams_setup.skip.credential_revoked', p),
    missing_scopes: (t, p) => t('teams_setup.skip.missing_scopes', p),
    session_unavailable: (t, p) => t('teams_setup.skip.session_unavailable', p),
    app_token_failed: (t, p) => t('teams_setup.skip.app_token_failed', p),
};

const COVERAGE_TEXT: Record<string, Words> = {
    covered: (t) => t('teams_setup.coverage.covered'),
    instance_disabled: (t) => t('teams_setup.coverage.instance_disabled'),
    not_enabled: (t) => t('teams_setup.coverage.not_enabled'),
    tenant_not_bound: (t) => t('teams_setup.coverage.tenant_not_bound'),
    tenant_changed: (t) => t('teams_setup.coverage.tenant_changed'),
    inactive: (t) => t('teams_setup.coverage.inactive'),
    other_organisation: (t) => t('teams_setup.coverage.other_organisation'),
    no_identity: (t) => t('teams_setup.coverage.no_identity'),
    other_tenant: (t) => t('teams_setup.coverage.other_tenant'),
    not_selected: (t) => t('teams_setup.coverage.not_selected'),
    no_access: (t) => t('teams_setup.coverage.no_access'),
    app_not_configured: (t) => t('teams_setup.coverage.app_not_configured'),
};

const PURPOSE_TEXT: Record<string, Words> = {
    sign_in: (t) => t('teams_setup.guide.purpose_sign_in'),
    offline: (t) => t('teams_setup.guide.purpose_offline'),
    mail: (t) => t('teams_setup.guide.purpose_mail'),
    shared_mailbox: (t) => t('teams_setup.guide.purpose_shared_mailbox'),
    calendar: (t) => t('teams_setup.guide.purpose_calendar'),
    files: (t) => t('teams_setup.guide.purpose_files'),
    contacts: (t) => t('teams_setup.guide.purpose_contacts'),
    meetings: (t) => t('teams_setup.guide.purpose_meetings'),
    recordings: (t) => t('teams_setup.guide.purpose_recordings'),
    transcripts: (t) => t('teams_setup.guide.purpose_transcripts'),
    auto_record: (t) => t('teams_setup.guide.purpose_auto_record'),
    unused: (t) => t('teams_setup.guide.purpose_unused'),
};

/**
 * Import failure codes (teams_import_jobs.error_code) for the members overview, with the
 * same meetings.import_error_* keys as pages/meeting-notes/lib/importErrorText (components
 * may not import from pages; checkText.test.ts pins that both say the same).
 */
const FAILURE_TEXT: Record<string, Words> = {
    not_connected: (t) => t('meetings.import_error_not_connected'),
    needs_reauth: (t) => t('meetings.import_error_needs_reauth'),
    needs_teams_scopes: (t) => t('meetings.import_error_needs_scopes'),
    not_organizer: (t) => t('meetings.import_error_not_organizer'),
    no_recording: (t) => t('meetings.import_error_no_recording'),
    recording_too_large: (t) => t('meetings.import_error_too_large'),
    transcript_access_disabled: (t) => t('meetings.import_error_transcript_api_off'),
    speaker_attribution_disabled: (t) => t('meetings.import_error_speaker_attribution_off'),
    empty_transcription: (t) => t('meetings.import_error_empty'),
    timeout: (t) => t('meetings.import_error_timeout'),
    already_imported: (t) => t('meetings.import_error_already_imported'),
    provider_not_allowed: (t) => t('meetings.import_error_provider_not_allowed'),
    graph_forbidden: (t) => t('meetings.import_error_graph_forbidden'),
    meeting_not_available: (t) => t('meetings.import_error_meeting_not_available'),
    application_access_policy_missing: (t) => t('meetings.import_error_access_policy'),
    calendar_forbidden: (t) => t('meetings.import_error_calendar_forbidden'),
    graph_throttled: (t) => t('meetings.import_error_throttled'),
    graph_unavailable: (t) => t('meetings.import_error_graph_unavailable'),
    download_failed: (t) => t('meetings.import_error_download_failed'),
    too_many_imports: (t) => t('meetings.import_error_too_many'),
};

/** A date-time param ('at') in the reader's locale; anything unreadable stays as it came. */
function formatAt(value: string): string {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

/** Params as placeholder values: arrays joined with ', ', times readable, the rest as text. */
export function formatParams(params: CheckParams | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!params || typeof params !== 'object') return out;
    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) out[key] = value.join(', ');
        else if (key === 'at' && typeof value === 'string') out[key] = formatAt(value);
        else out[key] = String(value);
    }
    return out;
}

/** The title of a check; an id this client does not know shows as the raw id. */
export function checkTitle(t: TranslateFn, id: string): string {
    return own(CHECK_TITLES, id) ? CHECK_TITLES[id](t) : id;
}

/** The result sentence; an unknown code says Graph could not be reached (the generic failure). */
export function codeText(t: TranslateFn, code: string | null | undefined, params?: CheckParams | null): string {
    const words = own(CODE_TEXT, code) ? CODE_TEXT[code] : CODE_TEXT.graph_error;
    const values = formatParams(params);
    // The probe member's coverage reason is a code: say it in words.
    if (code === 'probe_user_not_covered' && values.reason) values.reason = coverageText(t, values.reason);
    // The skip reason too, with the permissions it names.
    if (code === 'auto_import_skipped' && values.reason) {
        const raw = params?.missing;
        const missing = Array.isArray(raw) ? raw.map(String) : [];
        values.reason = skipText(t, values.reason, missing);
    }
    // A skipped check names the check it waits for by its title.
    if (code === 'prerequisite_failed' && values.prerequisite) values.prerequisite = checkTitle(t, values.prerequisite);
    // A placeholder the server left out (an optional param) is dropped, never shown as {name}.
    return words(t, values).replace(/ ?\(\{[A-Za-z]+\}\)/g, '').replace(/\{[A-Za-z]+\}/g, '').trim();
}

/** What to do, from the full remediation key; null when there is none or this client does not know it. */
export function fixText(t: TranslateFn, remediation: string | null | undefined): string | null {
    return own(FIX_TEXT, remediation) ? FIX_TEXT[remediation](t) : null;
}

/** Who can fix it; an unknown fixer gives null (the row then names nobody). */
export function fixerText(t: TranslateFn, fixer: Fixer | string | null | undefined): string | null {
    switch (fixer) {
        case 'user': return t('teams_setup.fixer.user');
        case 'org_admin': return t('teams_setup.fixer.org_admin');
        case 'entra_admin': return t('teams_setup.fixer.entra_admin');
        case 'teams_admin': return t('teams_setup.fixer.teams_admin');
        case 'platform_admin': return t('teams_setup.fixer.platform_admin');
        default: return null;
    }
}

/** The status label; an unknown status reads as "could not be tested". */
export function statusText(t: TranslateFn, status: CheckStatus | string): string {
    switch (status) {
        case 'pass': return t('teams_setup.status.pass');
        case 'fail': return t('teams_setup.status.fail');
        case 'warn': return t('teams_setup.status.warn');
        case 'skipped': return t('teams_setup.status.skipped');
        default: return t('teams_setup.status.unknown');
    }
}

/** The one-line verdict over a whole report. */
export function overallText(t: TranslateFn, overall: TeamsDiagnosticsReport['overall']): string {
    switch (overall) {
        case 'pass': return t('teams_setup.overall.pass');
        case 'warn': return t('teams_setup.overall.warn');
        default: return t('teams_setup.overall.fail');
    }
}

/** Why the last automatic import run skipped a member; an unknown reason uses the generic "could not be used". */
export function skipText(t: TranslateFn, reason: TeamsSkipReason | string, missingPermissions: string[] = []): string {
    const words = own(SKIP_TEXT, reason) ? SKIP_TEXT[reason] : SKIP_TEXT.session_unavailable;
    return words(t, { permissions: missingPermissions.join(', ') });
}

/** Why a member is (not) covered by organisation-wide import; an unknown reason shows raw. */
export function coverageText(t: TranslateFn, reason: CoverageReason | 'covered' | string): string {
    return own(COVERAGE_TEXT, reason) ? COVERAGE_TEXT[reason](t) : reason;
}

/** What a permission is for; an unknown purpose shows raw. */
export function purposeText(t: TranslateFn, purpose: PermissionPurpose | string): string {
    return own(PURPOSE_TEXT, purpose) ? PURPOSE_TEXT[purpose](t) : purpose;
}

/** Required, optional or only asked for by Bee Flow. */
export function roleText(t: TranslateFn, role: PermissionRole | string): string {
    switch (role) {
        case 'required': return t('teams_setup.guide.role_required');
        case 'optional': return t('teams_setup.guide.role_optional');
        default: return t('teams_setup.guide.role_requested');
    }
}

/** The sentence for an import failure code; an unknown code gets the generic failure sentence. */
export function failureText(t: TranslateFn, code: string | null | undefined): string {
    return own(FAILURE_TEXT, code) ? FAILURE_TEXT[code](t) : t('meetings.import_error_failed');
}

