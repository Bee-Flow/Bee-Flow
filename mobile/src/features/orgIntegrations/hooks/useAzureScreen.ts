/** The Azure screens' shared start: who may open them, the org, and the configuration. */

import { useTranslation } from '@/core/i18n';

import { useAzureConfig } from './azureHooks';
import { useIntegrationAccess } from './useIntegrationAccess';

export function useAzureScreen() {
    const t = useTranslation();
    const access = useIntegrationAccess();
    const orgId = access.azure ? access.orgId : null;
    return {
        orgId,
        allowed: access.azure,
        /** The deployment, not the person, rules it out on cloud: say so. */
        denied: access.admin && !access.isSelfHosted
            ? {
                  icon: 'Cloud' as const,
                  title: t('mobile.orgIntegrations.azure_self_hosted', 'Azure Configuration is for self-hosted installations'),
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
