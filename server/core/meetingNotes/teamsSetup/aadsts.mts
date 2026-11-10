/**
 * What a Microsoft Entra sign-in error code (AADSTS) means for the Teams setup:
 * a stable result code, the remediation key and who can fix it.
 *
 * The codes come from Microsoft's "Microsoft Entra authentication and
 * authorization error codes" page. Callers read the number from the token
 * response's `error_codes[0]` (the page says to handle error codes, not the
 * description text) and never pass the description on.
 */

import type { Fixer } from './checks.mts';

export interface AadstsMeaning {
    code: string;
    fixer: Fixer;
    /** The full i18n key, `teams_setup.fix.<name>`. */
    remediation: string;
}

type Row = readonly [code: string, fix: string, fixer: Fixer];

const MAP: ReadonlyMap<number, Row> = new Map<number, Row>([
    [7000215, ['secret_invalid', 'new_client_secret', 'platform_admin']],
    [7000222, ['secret_expired', 'new_client_secret', 'platform_admin']],
    [7000218, ['secret_missing', 'enter_secret', 'platform_admin']],
    [700016, ['app_not_in_tenant', 'app_not_in_tenant', 'entra_admin']],
    [500011, ['resource_principal_missing', 'app_not_in_tenant', 'entra_admin']],
    [90002, ['tenant_not_found', 'enter_tenant', 'platform_admin']],
    [70001, ['app_disabled', 'app_disabled', 'entra_admin']],
    [7000112, ['app_disabled', 'app_disabled', 'entra_admin']],
    [65001, ['consent_missing', 'admin_consent_needed', 'entra_admin']],
    [90094, ['admin_consent_required', 'admin_consent_needed', 'entra_admin']],
    [90095, ['admin_consent_required', 'admin_consent_needed', 'entra_admin']],
    [65004, ['consent_declined', 'consent_denied', 'entra_admin']],
    [650056, ['permission_not_on_app', 'add_permissions_to_app', 'entra_admin']],
    [650057, ['permission_not_on_app', 'add_permissions_to_app', 'entra_admin']],
    [70011, ['permission_not_on_app', 'add_permissions_to_app', 'entra_admin']],
    [65005, ['permission_not_on_app', 'add_permissions_to_app', 'entra_admin']],
    [53003, ['blocked_by_conditional_access', 'conditional_access', 'entra_admin']],
    [530032, ['blocked_by_conditional_access', 'conditional_access', 'entra_admin']],
    [530035, ['blocked_by_conditional_access', 'conditional_access', 'entra_admin']],
    [50076, ['mfa_required', 'mfa_required', 'user']],
    [50079, ['mfa_required', 'mfa_required', 'user']],
    [50105, ['user_not_assigned', 'assign_user', 'entra_admin']],
    [50011, ['redirect_uri_mismatch', 'register_redirect_uris', 'platform_admin']],
    [50020, ['account_not_in_tenant', 'account_not_in_tenant', 'user']],
    [50034, ['account_not_in_tenant', 'account_not_in_tenant', 'user']],
    [50194, ['single_tenant_app_common', 'enter_tenant', 'platform_admin']],
    [650059, ['app_not_for_tenant', 'app_audience', 'platform_admin']],
]);

const fix = (name: string) => `teams_setup.fix.${name}`;

/** The meaning of an AADSTS number; null (no code at all) and unknown numbers have their own rows. */
export function aadstsMeaning(aadsts: number | null): AadstsMeaning {
    if (aadsts === null || !Number.isFinite(aadsts)) {
        return { code: 'entra_error_no_code', fixer: 'platform_admin', remediation: fix('see_microsoft_error') };
    }
    const row = MAP.get(aadsts);
    if (!row) return { code: 'entra_error', fixer: 'platform_admin', remediation: fix('see_microsoft_error') };
    return { code: row[0], fixer: row[2], remediation: fix(row[1]) };
}

/** `'AADSTS' + n` for a report param, or undefined when there is no code. */
export function aadstsParam(aadsts: number | null): string | undefined {
    return aadsts === null || !Number.isFinite(aadsts) ? undefined : `AADSTS${aadsts}`;
}

/** Every number the map knows (for the tests). */
export function knownAadstsCodes(): number[] {
    return [...MAP.keys()];
}
