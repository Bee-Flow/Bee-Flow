import { Info } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import FeatureKillSwitches from '@/components/integrations/FeatureKillSwitches';
import ServerLicensePanel from '@/components/licensing/ServerLicensePanel';
import { SettingsGroup } from '@/components/shared/SettingsList';
import { ALERT_INFO } from '@/components/mcpLibrary/ui';

/**
 * SelfHostedCeilingEditor — the self-hosted ceiling. On self-hosted the ceiling
 * is the server licence tier, raised/lowered by activating a licence; plus the
 * global feature kill-switches that operators flip for the whole install. Both
 * reuse their existing self-contained components; the licence panel carries
 * its own "Server licence" header, so only the line on what it means here sits
 * above it.
 */
export default function SelfHostedCeilingEditor() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-4" aria-label={t('admin_org.ceiling_licence_title', 'Server licence')}>
                <p className={ALERT_INFO}>
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                        {t('admin_org.ceiling_licence_intro', 'The active licence tier is the capability ceiling for every organisation on this install. Distribute what it unlocks to members and groups under')} <strong>{t('admin_org.ceiling_grants', 'Grants')}</strong>.
                    </span>
                </p>
                <ServerLicensePanel />
            </section>

            <SettingsGroup title={t('admin_org.ceiling_global_switches', 'Global feature switches')}>
                <FeatureKillSwitches />
            </SettingsGroup>
        </div>
    );
}
