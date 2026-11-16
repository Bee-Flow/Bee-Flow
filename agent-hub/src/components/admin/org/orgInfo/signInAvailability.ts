// Which sign-in methods this server actually offers, for the organisation's
// preferred sign-in method (OrgAuthSection). The answer comes from
// /auth/setup-status, the same read the login page makes (pages/login/
// useAuthSettings), so the page never offers a method the login page hides.

import { useSetupStatusQuery } from '@/api/queries/loginReads';
import { useLicenseContext } from '@/components/licensing/LicenseContext';

/** The methods an organisation can prefer (the server's PREFERRED_AUTH_METHODS). */
export type AuthMethodId = 'password' | 'google' | 'microsoft';

/** Why a method is not offered: turned off, not set up, or outside the licence. */
export type SignInUnavailable = 'password_off' | 'not_set_up' | 'unlicensed';

/** The /auth/setup-status fields this reads. */
export interface SignInSetupStatus {
    isGoogleConfigured?: boolean;
    isMicrosoftConfigured?: boolean;
    microsoftLogins?: unknown[];
    allowPasswordLogin?: boolean;
}

interface AvailabilityOptions {
    /** The server licence holds `sso_saml` (Google and Microsoft sign-in). */
    ssoLicensed: boolean;
    /**
     * The licence decides here: a self-hosted server's own licence. On cloud
     * the organisation's plan does not gate signing in with Google or Microsoft.
     */
    licenceApplies: boolean;
}

/** One Microsoft button per connection; an older server answers without the list. */
function microsoftSetUp(status: SignInSetupStatus): boolean {
    if (Array.isArray(status.microsoftLogins)) return status.microsoftLogins.length > 0;
    return !!status.isMicrosoftConfigured;
}

/**
 * The methods this server does not offer, each with its reason. No answer
 * (still loading, or the read failed) restricts nothing: the value is a
 * preference, and offering a method too many is harmless.
 */
export function unavailableSignInMethods(
    status: SignInSetupStatus | null | undefined,
    { ssoLicensed, licenceApplies }: AvailabilityOptions,
): Partial<Record<AuthMethodId, SignInUnavailable>> {
    if (!status) return {};
    const out: Partial<Record<AuthMethodId, SignInUnavailable>> = {};
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password -- a reason code for a disabled sign-in method, not a password
    if (status.allowPasswordLogin === false) out.password = 'password_off';
    const ssoReason = (setUp: boolean): SignInUnavailable | undefined => {
        if (!setUp) return 'not_set_up';
        return licenceApplies && !ssoLicensed ? 'unlicensed' : undefined;
    };
    const google = ssoReason(!!status.isGoogleConfigured);
    if (google) out.google = google;
    const microsoft = ssoReason(microsoftSetUp(status));
    if (microsoft) out.microsoft = microsoft;
    return out;
}

/** The methods this server does not offer, read live. */
export function useUnavailableSignInMethods(isSelfHosted: boolean) {
    const { data } = useSetupStatusQuery<SignInSetupStatus>();
    const ssoLicensed = useLicenseContext().hasFeature('sso_saml');
    return unavailableSignInMethods(data, { ssoLicensed, licenceApplies: isSelfHosted });
}
