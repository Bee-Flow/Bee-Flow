// "Integrations" section of the IntegrationsAdminPanel: the integrations a new
// organisation starts with, one settings list per category with a switch per
// integration. Who may use an integration is managed under Access.
import { Info } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_INFO, QUIET_BTN } from '@/components/mcpLibrary/ui';
import SectionHeader from '@/components/shared/SectionHeader';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import type { GlobalDefaultsSectionProps } from './adminPanel.types';

export default function GlobalDefaultsSection({
    enableAllDefaults, disableAllDefaults, categories, allIntegrations,
    isDefaultEnabled, toggleDefault,
}: GlobalDefaultsSectionProps) {
    const { t } = useTranslation();
    const actions = (
        <div className="flex items-center gap-1">
            <button type="button" onClick={enableAllDefaults} className={QUIET_BTN}>{t('integ.global_defaults_enable_all', 'Enable All')}</button>
            <button type="button" onClick={disableAllDefaults} className={QUIET_BTN}>{t('integ.global_defaults_disable_all', 'Disable All')}</button>
        </div>
    );
    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SectionHeader
                title={t('integ.global_defaults_global_defaults', 'Global Defaults')}
                description={t('integ.global_defaults_default_integrations_for_new', 'Default integrations for new organizations. Changes here don\'t affect existing orgs.')}
                status={actions}
            />

            {categories.map(cat => (
                <SettingsGroup key={cat} title={cat}>
                    <SettingsList>
                        {allIntegrations.filter(i => i.category === cat).map(integ => (
                            <SettingRow inline key={integ.id} icon={integ.icon || undefined} label={integ.label} hint={integ.description}>
                                <div className="flex justify-end">
                                    <Toggle checked={isDefaultEnabled(integ.id)} onChange={() => toggleDefault(integ.id)} ariaLabel={integ.label} />
                                </div>
                            </SettingRow>
                        ))}
                    </SettingsList>
                </SettingsGroup>
            ))}

            {/* Per-organisation and per-group access lives in Admin → Access & Permissions. */}
            <div className={ALERT_INFO}>
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <p className="m-0">
                    {t('integ.global_defaults_who_may_use_each_integration_per', 'Who may use each integration — per organisation, per group, or for all members — is now managed in')}
                    <strong> {t('integ.global_defaults_admin_access_permissions', 'Admin → Access & Permissions')}</strong>{t('integ.global_defaults_the_defaults_above_only_seed', '. The defaults above only seed integrations for newly created organisations.')}
                </p>
            </div>
        </div>
    );
}
