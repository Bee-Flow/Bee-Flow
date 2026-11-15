/** The Azure screens' shared start: who may open them, the org, and the configuration. */

import { hasLicenseFeature, useAccess } from '@/core/access';
import { useTranslation } from '@/core/i18n';

import { useAzureConfig } from './azureHooks';
import { useIntegrationAccess } from './useIntegrationAccess';

export function useAzureScreen() {
    const t = useTranslation();
    const access = useIntegrationAccess();
    const orgId = access.azure ? access.orgId : null;
    // Microsoft SSO is Enterprise (`sso_saml`), as on the web and Security > SSO:
    // without it the SSO section is not offered and the server refuses its save.
    // Until the entitlements (or, when they are unavailable, the licence) have
    // answered, the feature reads as "no": wait instead of showing the lock.
    const snapshot = useAccess();
    const ssoAvailable = hasLicenseFeature(snapshot, 'sso_saml');
    const ssoPending = !ssoAvailable && (snapshot.entitlementsState === 'loading'
        || (snapshot.entitlementsState === 'unavailable' && snapshot.licenseState === 'loading'));
    return {
        orgId,
        allowed: access.azure,
        ssoAvailable,
        ssoPending,
        ssoDenied: {
            icon: 'Shield' as const,
            title: t('sso_licence.microsoft_locked_title', 'Microsoft sign-in is not part of this licence'),
            message: t(
                'sso_licence.microsoft_locked_message',
                'Single sign-on with Microsoft needs the SSO feature of an Enterprise licence. Without it the sign-in app cannot be set up here or under Security > SSO.',
            ),
        },
        /**
         * An org admin is turned away by the deployment on cloud, and by the
         * role on self-hosted (the setup is instance-wide): say which.
         */
        denied: access.admin && !access.azure
            ? {
                  icon: 'Cloud' as const,
                  title: access.isSelfHosted
                      ? t('mobile.orgIntegrations.azure_platform_title', 'Azure Configuration is for the platform administrator')
                      : t('mobile.orgIntegrations.azure_self_hosted', 'Azure Configuration is for self-hosted installations'),
                  message: t(
                      'mobile.orgIntegrations.azure_platform',
                      'On this deployment the Azure configuration is managed by the platform administrator.',
                  ),
              }
            : undefined,
        query: useAzureConfig(orgId),
        subtitle: t('settings.azure_config', 'Azure Configuration'),
    };
}
