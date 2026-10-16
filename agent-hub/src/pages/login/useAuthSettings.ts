import { useState, useEffect } from 'react';
import { API_BASE } from '../../utils/helpers';
import { getPublicOrganizations, getSetupStatus } from './loginRequests';

/** What /auth/setup-status answers; only the fields this screen reads. */
interface SetupStatus {
    isSetupComplete?: boolean;
    isOAuthConfigured?: boolean;
    isGoogleConfigured?: boolean;
    isMicrosoftConfigured?: boolean;
    serverUrl?: string;
    allowSignups?: boolean;
    allowOrgSignups?: boolean;
    allowConsumerSignups?: boolean;
    consumerLoginMethods?: unknown;
    allowPasswordLogin?: boolean;
    deploymentMode?: string;
    branding?: { logo?: string };
    availableLocales?: { code: string }[];
    signupCaptcha?: { enabled?: boolean } & Record<string, unknown>;
}

/**
 * What the server says about this deployment before anyone signs in:
 * which login methods exist, whether signups are open, branding, locales and the
 * public organisation list. One request on mount, the effect has no dependencies.
 */
export function useAuthSettings() {
    const [availableLocales, setAvailableLocales] = useState<{ code: string }[]>([]);
    const [setupMode, setSetupMode] = useState(false);
    const [isOAuthConfigured, setIsOAuthConfigured] = useState<boolean | undefined>(false);
    const [serverUrl, setServerUrl] = useState('');
    const [isGoogleConfigured, setIsGoogleConfigured] = useState<boolean | undefined>(false);
    const [isMicrosoftConfigured, setIsMicrosoftConfigured] = useState<boolean | undefined>(false);
    const [, setIsSetupComplete] = useState<boolean | undefined>(true);
    const [allowSignups, setAllowSignups] = useState<boolean | null>(null);
    const [allowOrgSignups, setAllowOrgSignups] = useState(true);
    const [allowConsumerSignups, setAllowConsumerSignups] = useState(true);
    const [consumerLoginMethods, setConsumerLoginMethods] = useState<unknown[]>(['password', 'google', 'microsoft']);
    const [allowPasswordLogin, setAllowPasswordLogin] = useState<boolean | null>(null);
    const [authSettingsLoaded, setAuthSettingsLoaded] = useState(false);
    const [deploymentMode, setDeploymentMode] = useState('cloud');
    const [orgLogo, setOrgLogo] = useState<string | null>(null);
    const [signupOrgs, setSignupOrgs] = useState<unknown[]>([]);
    // Bot challenge for signup. { enabled:false } unless the operator configured
    // a provider (see server/auth/signupCaptcha.js). The server enforces it
    // independently; this only produces the token.
    const [captchaConfig, setCaptchaConfig] = useState<SetupStatus['signupCaptcha'] | null>(null);

    useEffect(() => {
        const checkSetup = async () => {
            try {
                const res = await getSetupStatus();
                if (res.ok) {
                    const data: SetupStatus = await res.json();
                    setIsSetupComplete(data.isSetupComplete);
                    setIsOAuthConfigured(data.isOAuthConfigured);
                    setIsGoogleConfigured(data.isGoogleConfigured);
                    setIsMicrosoftConfigured(data.isMicrosoftConfigured);
                    if (data.serverUrl) setServerUrl(data.serverUrl);
                    if (!data.isSetupComplete) setSetupMode(true);
                    // Also track raw setup-complete flag for wizard
                    setIsSetupComplete(data.isSetupComplete);
                    if (data.allowSignups === false) setAllowSignups(false);
                    else setAllowSignups(true);
                    setAllowOrgSignups(data.allowOrgSignups !== false);
                    setAllowConsumerSignups(data.allowConsumerSignups !== false);
                    if (Array.isArray(data.consumerLoginMethods)) setConsumerLoginMethods(data.consumerLoginMethods);
                    if (data.allowPasswordLogin === false) setAllowPasswordLogin(false);
                    else setAllowPasswordLogin(true);
                    if (data.deploymentMode) setDeploymentMode(data.deploymentMode);
                    if (data.branding?.logo) {
                        setOrgLogo(data.branding.logo.startsWith('/') ? `${API_BASE}${data.branding.logo}` : data.branding.logo);
                    }
                    if (data.availableLocales) setAvailableLocales(data.availableLocales);
                    if (data.signupCaptcha) setCaptchaConfig(data.signupCaptcha);
                } else {
                    // If setup-status fails, show everything (safe fallback)
                    setAllowSignups(true);
                    setAllowPasswordLogin(true);
                }
                setAuthSettingsLoaded(true);

                const orgRes = await getPublicOrganizations();
                if (orgRes.ok) {
                    const orgData: unknown[] = await orgRes.json();
                    setSignupOrgs(orgData);
                }
            } catch (err) {
                console.error('Failed to check setup status:', err);
            }
        };
        checkSetup();
    }, []);

    return {
        availableLocales, setupMode, setSetupMode, setIsSetupComplete,
        isOAuthConfigured, serverUrl, isGoogleConfigured, isMicrosoftConfigured,
        allowSignups, allowOrgSignups, allowConsumerSignups, consumerLoginMethods,
        allowPasswordLogin, authSettingsLoaded, deploymentMode, orgLogo, signupOrgs, captchaConfig,
    };
}
