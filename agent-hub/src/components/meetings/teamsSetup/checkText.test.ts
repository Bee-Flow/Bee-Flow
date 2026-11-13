import { describe, expect, it } from 'vitest';
import EN_DEFAULTS from '@/i18n/en-defaults';
import { interpolate, type TranslateFn } from '@/hooks/useTranslation';
import { importErrorText } from '@/pages/meeting-notes/lib/importErrorText';
import {
    checkTitle, codeText, coverageText, failureText, fixText, fixerText, formatParams,
    overallText, purposeText, roleText, skipText, statusText,
} from './checkText';

const DICT = EN_DEFAULTS as Record<string, string>;

/** The real catalogue, recording which keys were asked for. */
function recorder() {
    const keys: string[] = [];
    const t = ((key: string, fallbackOrParams?: unknown, params?: unknown) => {
        keys.push(key);
        const p = (typeof fallbackOrParams === 'string' ? params : fallbackOrParams) as Record<string, unknown> | undefined;
        return interpolate(DICT[key] ?? key, p);
    }) as TranslateFn;
    return { t, keys };
}

// Copied from the contract (sections 3.1-3.7 and 6.3): the server may send any of these.
const CHECK_IDS = [
    'app.config', 'app.token', 'app.redirect_uris', 'app.configured', 'product.access',
    'a.connection', 'a.scope_calendar', 'a.scope_recordings', 'a.scope_transcripts', 'a.auto_record',
    'a.calendar', 'a.meeting_lookup', 'a.recordings', 'a.transcripts', 'a.transcript_content',
    'a.background_access', 'a.auto_import', 'org.consent_link', 'org.admin_consent',
    'b.instance', 'b.org_tenant', 'b.app_credentials', 'b.app_token', 'b.role_meetings', 'b.role_recordings',
    'b.role_calendar', 'b.role_transcripts', 'b.role_unused', 'b.enabled', 'b.coverage', 'b.probe_user', 'b.calendar',
    'b.access_policy', 'b.recordings', 'b.transcripts',
];

const CODES = [
    'ok', 'prerequisite_failed', 'client_id_missing', 'client_id_invalid', 'secret_missing', 'tenant_invalid',
    'tenant_consumers', 'tenant_needed', 'secret_invalid', 'secret_expired', 'app_not_in_tenant',
    'resource_principal_missing', 'tenant_not_found', 'app_disabled', 'consent_missing', 'admin_consent_required',
    'consent_declined', 'permission_not_on_app', 'blocked_by_conditional_access', 'mfa_required', 'user_not_assigned',
    'redirect_uri_mismatch', 'account_not_in_tenant', 'single_tenant_app_common', 'app_not_for_tenant', 'entra_error',
    'entra_error_no_code', 'entra_unreachable', 'manual_check', 'probe_timeout', 'capability_missing',
    'app_not_configured', 'not_connected', 'needs_reauth', 'scope_missing', 'calendar_forbidden', 'graph_throttled',
    'graph_unavailable', 'graph_error', 'no_teams_meetings', 'no_meeting_to_probe', 'recording_not_allowed',
    'meeting_not_available', 'needs_teams_scopes', 'graph_forbidden', 'transcript_api_disabled',
    'no_transcript_to_probe', 'speaker_attribution_off', 'application_access_policy_missing', 'no_stored_connection',
    'stored_connection_missing_scopes', 'stored_connection_expired', 'auto_import_off', 'auto_import_skipped',
    'tenant_unknown', 'consent_granted', 'consent_denied', 'consent_tenant_mismatch', 'consent_not_recorded',
    'app_import_disabled_instance', 'tenant_not_bound', 'tenant_mismatch_sso', 'role_missing', 'roles_unreadable', 'unused_roles',
    'not_enabled', 'nobody_covered', 'no_probe_user', 'probe_user_not_covered',
];

const FIXES = [
    'enter_client_id', 'enter_secret', 'enter_tenant', 'tenant_not_consumers', 'sign_in_with_microsoft_or_set_tenant',
    'new_client_secret', 'app_not_in_tenant', 'app_disabled', 'add_permissions_to_app', 'admin_consent_needed',
    'consent_denied', 'conditional_access', 'mfa_required', 'assign_user', 'register_redirect_uris',
    'account_not_in_tenant', 'app_audience', 'see_microsoft_error', 'check_network', 'grant_meeting_notes_access',
    'configure_app_registration', 'connect_microsoft', 'reconnect_microsoft', 'reconnect_to_grant', 'calendar_access',
    'try_again_later', 'schedule_test_meeting', 'allow_cloud_recording', 'meeting_not_available', 'graph_forbidden',
    'enable_transcript_api', 'enable_speaker_attribution', 'connect_for_background', 'turn_on_auto_import',
    'turn_on_auto_import_org', 'open_consent_link', 'instance_disabled', 'bind_directory',
    'grant_application_permission', 'remove_unused_permissions', 'enable_app_import', 'members_sign_in_with_microsoft', 'pick_probe_user',
    'grant_access_policy', 'calendar_application_access',
];

const SKIPS = ['not_licensed', 'no_credential', 'credential_needs_reauth', 'credential_revoked', 'missing_scopes', 'session_unavailable', 'app_token_failed'];
const COVERAGE = ['covered', 'instance_disabled', 'not_enabled', 'tenant_not_bound', 'tenant_changed', 'inactive', 'other_organisation', 'no_identity', 'other_tenant', 'not_selected', 'no_access', 'app_not_configured'];
const PURPOSES = ['sign_in', 'offline', 'mail', 'shared_mailbox', 'calendar', 'files', 'contacts', 'meetings', 'recordings', 'transcripts', 'auto_record', 'unused'];
const FIXERS = ['user', 'org_admin', 'entra_admin', 'teams_admin', 'platform_admin'];
const STATUSES = ['pass', 'fail', 'warn', 'skipped', 'unknown'];
// The Teams import failure codes the overview can count (section 4.2 plus the existing ones).
const FAILURE_CODES = [
    'not_connected', 'needs_reauth', 'needs_teams_scopes', 'not_organizer', 'no_recording', 'recording_too_large',
    'transcript_access_disabled', 'speaker_attribution_disabled', 'empty_transcription', 'timeout', 'already_imported',
    'provider_not_allowed', 'graph_forbidden', 'meeting_not_available', 'application_access_policy_missing',
    'calendar_forbidden', 'graph_throttled', 'graph_unavailable', 'download_failed', 'too_many_imports',
];

/** The one key a call asked for, which must be in the English catalogue. */
function onlyKey(call: (t: TranslateFn) => unknown): string {
    const { t, keys } = recorder();
    call(t);
    expect(keys).toHaveLength(1);
    expect(DICT[keys[0]], `${keys[0]} is not in the catalogue`).toBeTypeOf('string');
    return keys[0];
}

describe('checkText: every value of the contract has its own key', () => {
    it.each(CHECK_IDS)('check %s', (id) => {
        expect(onlyKey((t) => checkTitle(t, id))).toBe(`teams_setup.check.${id.replace('.', '_')}`);
    });
    it.each(CODES)('code %s', (code) => {
        expect(onlyKey((t) => codeText(t, code, {}))).toBe(`teams_setup.code.${code}`);
    });
    it.each(FIXES)('fix %s', (fix) => {
        expect(onlyKey((t) => fixText(t, `teams_setup.fix.${fix}`))).toBe(`teams_setup.fix.${fix}`);
    });
    it.each(SKIPS)('skip reason %s', (reason) => {
        expect(onlyKey((t) => skipText(t, reason))).toBe(`teams_setup.skip.${reason}`);
    });
    it.each(COVERAGE)('coverage reason %s', (reason) => {
        expect(onlyKey((t) => coverageText(t, reason))).toBe(`teams_setup.coverage.${reason}`);
    });
    it.each(PURPOSES)('purpose %s', (purpose) => {
        expect(onlyKey((t) => purposeText(t, purpose))).toBe(`teams_setup.guide.purpose_${purpose}`);
    });
    it.each(FIXERS)('fixer %s', (fixer) => {
        expect(onlyKey((t) => fixerText(t, fixer))).toBe(`teams_setup.fixer.${fixer}`);
    });
    it.each(STATUSES)('status %s', (status) => {
        expect(onlyKey((t) => statusText(t, status))).toBe(`teams_setup.status.${status}`);
    });
    it('roles and the overall verdicts', () => {
        expect(onlyKey((t) => roleText(t, 'required'))).toBe('teams_setup.guide.role_required');
        expect(onlyKey((t) => roleText(t, 'optional'))).toBe('teams_setup.guide.role_optional');
        expect(onlyKey((t) => roleText(t, 'requested'))).toBe('teams_setup.guide.role_requested');
        for (const o of ['pass', 'warn', 'fail'] as const) expect(onlyKey((t) => overallText(t, o))).toBe(`teams_setup.overall.${o}`);
    });
});

describe('checkText: fallbacks', () => {
    const { t } = recorder();

    it('an unknown or prototype code reads as the generic Graph failure', () => {
        const generic = DICT['teams_setup.code.graph_error'];
        expect(codeText(t, 'something_new', {})).toBe(generic);
        expect(codeText(t, 'toString', {})).toBe(generic);
        expect(codeText(t, null)).toBe(generic);
    });

    it('an unknown check id shows the raw id; an unknown fix or fixer gives nothing', () => {
        expect(checkTitle(t, 'c.future_check')).toBe('c.future_check');
        expect(checkTitle(t, 'constructor')).toBe('constructor');
        expect(fixText(t, 'teams_setup.fix.does_not_exist')).toBeNull();
        expect(fixText(t, null)).toBeNull();
        expect(fixerText(t, 'someone')).toBeNull();
        expect(fixerText(t, null)).toBeNull();
    });
});

describe('checkText: placeholders', () => {
    const { t } = recorder();

    it('fills placeholders from params and joins arrays with a comma', () => {
        expect(codeText(t, 'scope_missing', { permission: 'Calendars.ReadWrite' })).toBe('Microsoft did not grant Calendars.ReadWrite.');
        expect(codeText(t, 'manual_check', { uris: ['https://a.test/x', 'https://a.test/y'] }))
            .toBe('Bee Flow cannot read this from Microsoft. Check that these addresses are registered: https://a.test/x, https://a.test/y');
        expect(codeText(t, 'graph_unavailable', { httpStatus: 502 })).toBe('Microsoft Graph answered with an error (HTTP 502).');
        expect(skipText(t, 'missing_scopes', ['OnlineMeetingRecording.Read.All', 'Calendars.ReadWrite']))
            .toBe('Skipped: the stored connection lacks OnlineMeetingRecording.Read.All, Calendars.ReadWrite.');
    });

    it('drops a placeholder the server left out instead of showing a brace', () => {
        expect(codeText(t, 'secret_invalid', {})).toBe('Microsoft rejected the client secret.');
        expect(codeText(t, 'secret_invalid', { aadsts: 'AADSTS7000215' })).toBe('Microsoft rejected the client secret (AADSTS7000215).');
    });

    it('names the app the access policy must allow, when the server sends its client ID', () => {
        const id = '11111111-2222-3333-4444-555555555555';
        expect(codeText(t, 'application_access_policy_missing', { clientId: id }))
            .toBe(`No Teams application access policy allows the app (${id}) for this member.`);
        expect(codeText(t, 'application_access_policy_missing', {}))
            .toBe('No Teams application access policy allows the app for this member.');
    });

    it('says in words why the test member is not covered', () => {
        expect(codeText(t, 'probe_user_not_covered', { reason: 'no_identity' }))
            .toBe(`That member is not covered by organisation-wide import (${DICT['teams_setup.coverage.no_identity']}).`);
        expect(codeText(t, 'probe_user_not_covered', {})).toBe('That member is not covered by organisation-wide import.');
    });

    it('says why the last automatic import run skipped the account, with the permissions it lacks', () => {
        const at = '2026-11-10T09:00:00.000Z';
        const when = new Date(at).toLocaleString();
        expect(codeText(t, 'auto_import_skipped', { reason: 'missing_scopes', at, missing: ['OnlineMeetingRecording.Read.All'] }))
            .toBe(`The last automatic import run (${when}) did not use your account. Skipped: the stored connection lacks OnlineMeetingRecording.Read.All.`);
        // Reasons that differ only in the fix read differently too.
        expect(codeText(t, 'auto_import_skipped', { reason: 'credential_revoked', at }))
            .toBe(`The last automatic import run (${when}) did not use your account. ${DICT['teams_setup.skip.credential_revoked']}`);
        expect(codeText(t, 'auto_import_skipped', { reason: 'session_unavailable', at }))
            .toBe(`The last automatic import run (${when}) did not use your account. ${DICT['teams_setup.skip.session_unavailable']}`);
        expect(codeText(t, 'auto_import_skipped', {})).toBe('The last automatic import run did not use your account.');
    });

    it('a skipped check names the check it waits for by its title', () => {
        expect(codeText(t, 'prerequisite_failed', { prerequisite: 'a.connection' }))
            .toBe(`Not tested until this check passes: ${DICT['teams_setup.check.a_connection']}.`);
        // A check this client does not know shows its raw id; without the param the general sentence.
        expect(codeText(t, 'prerequisite_failed', { prerequisite: 'c.future_check' })).toBe('Not tested until this check passes: c.future_check.');
        expect(codeText(t, 'prerequisite_failed', {})).toBe(DICT['teams_setup.code.prerequisite_failed']);
    });

    it('formats a time param for reading and leaves an unreadable one alone', () => {
        const out = formatParams({ at: '2026-11-10T09:30:00.000Z', count: 3, self: true, uris: ['a', 'b'] });
        expect(out.at).toBe(new Date('2026-11-10T09:30:00.000Z').toLocaleString());
        expect(out).toMatchObject({ count: '3', self: 'true', uris: 'a, b' });
        expect(formatParams({ at: 'not a date' }).at).toBe('not a date');
        expect(formatParams(null)).toEqual({});
    });
});

describe('checkText: import failure codes', () => {
    const { t } = recorder();

    it.each(FAILURE_CODES)('%s says the same as the import panel', (code) => {
        expect(failureText(t, code)).toBe(importErrorText(t, code));
        expect(failureText(t, code)).not.toBe(DICT['meetings.import_error_failed']);
    });

    it('an unknown code gets the generic failure sentence', () => {
        expect(failureText(t, 'something_new')).toBe(DICT['meetings.import_error_failed']);
        expect(failureText(t, 'hasOwnProperty')).toBe(DICT['meetings.import_error_failed']);
    });
});
