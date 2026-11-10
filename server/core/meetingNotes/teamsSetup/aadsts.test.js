'use strict';
/**
 * Every row of the AADSTS map (contract 4.1), an unknown number and no code.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/aadsts.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { aadstsMeaning, aadstsParam, knownAadstsCodes } = require('./aadsts.mts');

const TABLE = [
    [7000215, 'secret_invalid', 'new_client_secret', 'platform_admin'],
    [7000222, 'secret_expired', 'new_client_secret', 'platform_admin'],
    [7000218, 'secret_missing', 'enter_secret', 'platform_admin'],
    [700016, 'app_not_in_tenant', 'app_not_in_tenant', 'entra_admin'],
    [500011, 'resource_principal_missing', 'app_not_in_tenant', 'entra_admin'],
    [90002, 'tenant_not_found', 'enter_tenant', 'platform_admin'],
    [70001, 'app_disabled', 'app_disabled', 'entra_admin'],
    [7000112, 'app_disabled', 'app_disabled', 'entra_admin'],
    [65001, 'consent_missing', 'admin_consent_needed', 'entra_admin'],
    [90094, 'admin_consent_required', 'admin_consent_needed', 'entra_admin'],
    [90095, 'admin_consent_required', 'admin_consent_needed', 'entra_admin'],
    [65004, 'consent_declined', 'consent_denied', 'entra_admin'],
    [650056, 'permission_not_on_app', 'add_permissions_to_app', 'entra_admin'],
    [650057, 'permission_not_on_app', 'add_permissions_to_app', 'entra_admin'],
    [70011, 'permission_not_on_app', 'add_permissions_to_app', 'entra_admin'],
    [65005, 'permission_not_on_app', 'add_permissions_to_app', 'entra_admin'],
    [53003, 'blocked_by_conditional_access', 'conditional_access', 'entra_admin'],
    [530032, 'blocked_by_conditional_access', 'conditional_access', 'entra_admin'],
    [530035, 'blocked_by_conditional_access', 'conditional_access', 'entra_admin'],
    [50076, 'mfa_required', 'mfa_required', 'user'],
    [50079, 'mfa_required', 'mfa_required', 'user'],
    [50105, 'user_not_assigned', 'assign_user', 'entra_admin'],
    [50011, 'redirect_uri_mismatch', 'register_redirect_uris', 'platform_admin'],
    [50020, 'account_not_in_tenant', 'account_not_in_tenant', 'user'],
    [50034, 'account_not_in_tenant', 'account_not_in_tenant', 'user'],
    [50194, 'single_tenant_app_common', 'enter_tenant', 'platform_admin'],
    [650059, 'app_not_for_tenant', 'app_audience', 'platform_admin'],
];

test('every row of the table maps to its code, remediation and fixer', () => {
    for (const [n, code, fix, fixer] of TABLE) {
        assert.deepEqual(aadstsMeaning(n), { code, fixer, remediation: `teams_setup.fix.${fix}` }, `AADSTS${n}`);
    }
    assert.deepEqual(knownAadstsCodes().sort((a, b) => a - b), TABLE.map((r) => r[0]).sort((a, b) => a - b), 'no extra rows');
});

test('an unknown number is entra_error, no code is entra_error_no_code', () => {
    assert.deepEqual(aadstsMeaning(123456), { code: 'entra_error', fixer: 'platform_admin', remediation: 'teams_setup.fix.see_microsoft_error' });
    assert.deepEqual(aadstsMeaning(null), { code: 'entra_error_no_code', fixer: 'platform_admin', remediation: 'teams_setup.fix.see_microsoft_error' });
});

test('the report param is AADSTS plus the number, and absent without one', () => {
    assert.equal(aadstsParam(7000222), 'AADSTS7000222');
    assert.equal(aadstsParam(null), undefined);
});
