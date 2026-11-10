'use strict';
/**
 * Graph errors as diagnostics outcomes (contract 3.6): the codes the import
 * pipeline throws today and the ones it gains this round, the HTTP statuses of
 * a calendar listing, and the option B (`app`) variants.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/graphOutcome.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromGraphError } = require('./graphOutcome.mts');

const coded = (code, extra = {}) => Object.assign(new Error(`Fixture subject 7: ${code}`), { code, ...extra });
const graph = (status) => Object.assign(new Error('Microsoft Graph API error'), { graphStatus: status });
const pick = (o) => ({ status: o.status, code: o.code, fix: o.fix, fixer: o.fixer, ...(o.params ? { params: o.params } : {}) });

test('NOT_CONNECTED is needs_reauth for a delegated session, an admin matter for the app token', () => {
    assert.deepEqual(pick(fromGraphError(new Error('NOT_CONNECTED'), { context: 'calendar' })),
        { status: 'fail', code: 'needs_reauth', fix: 'reconnect_microsoft', fixer: 'user' });
    assert.deepEqual(pick(fromGraphError(new Error('NOT_CONNECTED'), { context: 'app' })),
        { status: 'fail', code: 'needs_reauth', fix: 'see_microsoft_error', fixer: 'org_admin' });
});

test('the pipeline codes map to their report codes', () => {
    const rows = [
        ['needs_teams_scopes', 'meeting', 'fail', 'needs_teams_scopes', 'admin_consent_needed', 'entra_admin'],
        ['needs_teams_scopes', 'app', 'fail', 'needs_teams_scopes', 'grant_application_permission', 'entra_admin'],
        ['transcript_access_disabled', 'meeting', 'warn', 'transcript_api_disabled', 'enable_transcript_api', 'teams_admin'],
        ['speaker_attribution_disabled', 'meeting', 'warn', 'speaker_attribution_off', 'enable_speaker_attribution', 'teams_admin'],
        ['application_access_policy_missing', 'app', 'fail', 'application_access_policy_missing', 'grant_access_policy', 'teams_admin'],
        // Teams licence and meeting policies: a Teams administrator's work, not Entra's.
        ['graph_forbidden', 'meeting', 'fail', 'graph_forbidden', 'graph_forbidden', 'teams_admin'],
        ['not_organizer', 'meeting', 'fail', 'graph_forbidden', 'graph_forbidden', 'teams_admin'],
        ['not_found', 'meeting', 'fail', 'meeting_not_available', 'meeting_not_available', 'user'],
        ['graph_throttled', 'meeting', 'warn', 'graph_throttled', 'try_again_later', 'user'],
    ];
    for (const [code, context, status, out, fix, fixer] of rows) {
        assert.deepEqual(pick(fromGraphError(coded(code, { status: 403 }), { context })), { status, code: out, fix, fixer }, `${code} (${context})`);
    }
});

test('calendar statuses: throttled, expired, forbidden, unavailable with the status', () => {
    for (const s of [429, 503, 504]) {
        assert.equal(fromGraphError(graph(s), { context: 'calendar' }).code, 'graph_throttled');
        assert.equal(fromGraphError(graph(s), { context: 'calendar' }).status, 'warn');
    }
    assert.deepEqual(pick(fromGraphError(graph(401), { context: 'calendar' })), { status: 'fail', code: 'needs_reauth', fix: 'reconnect_microsoft', fixer: 'user' });
    assert.deepEqual(pick(fromGraphError(graph(403), { context: 'calendar' })), { status: 'fail', code: 'calendar_forbidden', fix: 'calendar_access', fixer: 'entra_admin' });
    assert.deepEqual(pick(fromGraphError(graph(403), { context: 'app' })), { status: 'fail', code: 'calendar_forbidden', fix: 'calendar_application_access', fixer: 'entra_admin' });
    assert.deepEqual(pick(fromGraphError(graph(500), { context: 'calendar' })), { status: 'fail', code: 'graph_unavailable', fix: 'try_again_later', fixer: 'user', params: { httpStatus: 500 } });
});

test("'failed' is graph_unavailable and always carries httpStatus (0 when unknown)", () => {
    assert.deepEqual(fromGraphError(coded('failed', { status: 502 }), { context: 'meeting' }).params, { httpStatus: 0 });
    assert.deepEqual(fromGraphError(coded('failed', { graphStatus: 500 }), { context: 'meeting' }).params, { httpStatus: 500 });
    assert.equal(fromGraphError(coded('failed', { graphStatus: 503 }), { context: 'meeting' }).code, 'graph_throttled', 'throttling wins, as in the table order');
});

test('anything else is graph_error, and the message never reaches the outcome', () => {
    const out = fromGraphError(new Error('Fixture subject 7 with member@fixture.test'), { context: 'meeting' });
    assert.deepEqual(pick(out), { status: 'fail', code: 'graph_error', fix: 'try_again_later', fixer: 'user' });
    assert.doesNotMatch(JSON.stringify(fromGraphError(coded('graph_forbidden'), { context: 'meeting' })), /Fixture subject/);
    assert.equal(fromGraphError(null, { context: 'meeting' }).code, 'graph_error');
});
