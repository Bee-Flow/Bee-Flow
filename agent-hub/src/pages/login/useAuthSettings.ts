import { useMemo, useState } from 'react';
import { API_BASE } from '../../utils/helpers';
import { usePublicOrganizationsQuery, useSetupStatusQuery } from '../../api/queries/loginReads';
import useAdjustOnChange from '../../hooks/useAdjustOnChange';

/** One Microsoft button on the login page; empty label/logo mean the defaults. */
export interface MicrosoftLogin {
    id: string;
    label?: string;
    logo?: string;
}

/** What /auth/setup-status answers; only the fields this screen reads. */
interface SetupStatus {
    isSetupComplete?: boolean;
    isOAuthConfigured?: boolean;
    isGoogleConfigured?: boolean;
    isMicrosoftConfigured?: boolean;
    microsoftLogins?: MicrosoftLogin[];
    serverUrl?: string;
    allowSignups?: boolean;
    allowOrgSignups?: boolean;
    allowConsumerSignups?: boolean;
    consumerLoginMethods?: string[];
    allowPasswordLogin?: boolean;
    deploymentMode?: string;
    branding?: { logo?: string };
    availableLocales?: { code: string }[];
    signupCaptcha?: { enabled?: boolean } & Record<string, unknown>;
}

/** The Microsoft buttons; an older server answers without the list: one default button when configured. */
function microsoftLoginsOf(data: SetupStatus): MicrosoftLogin[] {
    if (Array.isArray(data.microsoftLogins)) return data.microsoftLogins;
    return data.isMicrosoftConfigured ? [{ id: 'default' }] : [];
}

const NO_LOCALES: { code: string }[] = [];
const NO_LOGINS: MicrosoftLogin[] = [];
const NO_ORGS: unknown[] = [];
const DEFAULT_CONSUMER_METHODS = ['password', 'google', 'microsoft'];

/** The logo as an address: a server path is served from API_BASE. */
function logoOf(data: SetupStatus | null | undefined): string | null {
    const logo = data?.branding?.logo;
    if (!logo) return null;
    return logo.startsWith('/') ? `${API_BASE}${logo}` : logo;
}

/** The sign-in methods the deployment offers; none before the server answered. */
function loginMethodsOf(data: SetupStatus | null) {
    if (!data) return { isOAuthConfigured: false, isGoogleConfigured: false, isMicrosoftConfigured: false, microsoftLogins: NO_LOGINS, serverUrl: '' };
    return {
        isOAuthConfigured: data.isOAuthConfigured,
        isGoogleConfigured: data.isGoogleConfigured,
        isMicrosoftConfigured: data.isMicrosoftConfigured,
        microsoftLogins: microsoftLoginsOf(data),
        serverUrl: data.serverUrl || '',
    };
}

/** Who may sign up and how; an error status (null) allows everything, no answer yet leaves the two gates unknown. */
function signupRulesOf(data: SetupStatus | null, answered: boolean) {
    return {
        allowSignups: answered ? data?.allowSignups !== false : null,
        allowOrgSignups: data?.allowOrgSignups !== false,
        allowConsumerSignups: data?.allowConsumerSignups !== false,
        consumerLoginMethods: Array.isArray(data?.consumerLoginMethods) ? data.consumerLoginMethods : DEFAULT_CONSUMER_METHODS,
        allowPasswordLogin: answered ? data?.allowPasswordLogin !== false : null,
    };
}

/** Branding, locales and the signup challenge. */
function lookOf(data: SetupStatus | null) {
    return {
        availableLocales: data?.availableLocales ?? NO_LOCALES,
        deploymentMode: data?.deploymentMode || 'cloud',
        orgLogo: logoOf(data),
        captchaConfig: data?.signupCaptcha ?? null,
    };
}

/**
 * What the server says about this deployment before anyone signs in:
 * which login methods exist, whether signups are open, branding, locales and the
 * public organisation list. One read of each per mount, the list after the status.
 * An error status shows everything (the safe fallback); a network failure leaves
 * the settings unloaded.
 */
export function useAuthSettings() {
    const statusQuery = useSetupStatusQuery<SetupStatus>();
    // Answered: an ok body, or null for an error status.
    const answered = statusQuery.isSuccess;
    const data = statusQuery.data ?? null;
    const signupOrgs = usePublicOrganizationsQuery(answered).data ?? NO_ORGS;

    // The setup wizard opens when the server says setup is not complete; the screen can close it again.
    const needsSetup = !!data && !data.isSetupComplete;
    const [setupMode, setSetupMode] = useState(needsSetup);
    useAdjustOnChange([data], () => { if (needsSetup) setSetupMode(true); });
    const [, setIsSetupComplete] = useState<boolean | undefined>(true);

    const settings = useMemo(
        () => ({ ...loginMethodsOf(data), ...signupRulesOf(data, answered), ...lookOf(data) }),
        [data, answered],
    );

    return { ...settings, setupMode, setSetupMode, setIsSetupComplete, authSettingsLoaded: answered, signupOrgs };
}
