// "Defaults for new organisations" section of Platform services: the
// integrations an organisation is created with (a copy) or follows live when it
// has no list of its own, one settings list per category with a switch per
// integration that saves at once. Who may use an integration is chosen under
// Access; an integration the server cannot serve yet (no OAuth app, key or
// binding) carries a "Not set up on this server" chip. The dashboard's page
// frame draws the header (the rail label), so the section opens with what the
// defaults do.
import { ArrowRight, Info } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useShellProps } from '@/authedApp/useShellProps';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { availabilityReasonText } from '@/utils/integrationAvailability';
import { ALERT_INFO, CHIP, QUIET_BTN } from '@/components/shared/adminUi';
import { Button } from '@/components/shared/Button';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import type { GlobalDefaultsSectionProps } from './adminPanel.types';

/** Where an organisation's integrations are chosen: Access > Ceiling. */
const ACCESS_PATH = 'admin/access/ceiling';

/**
 * The catalogue integrations this server cannot serve. Whether an integration
 * is set up is a fact of the server, the same for every organisation, so the
 * availability of the dashboard's organisation (or the viewer's own) answers
 * it; without either, or while it loads, nothing is marked.
 */
function useNotSetUpOnServer(): (id: string) => boolean {
    const choice = useAdminOrgChoice();
    const orgId = choice?.orgId ?? choice?.homeOrganization?.id ?? null;
    const integrations = useOrgIntegrationAvailability(orgId).data?.integrations;
    return (id: string) => integrations?.[id]?.serverConfigured === false;
}

export default function GlobalDefaultsSection({
    enableAllDefaults, disableAllDefaults, categories, allIntegrations,
    isDefaultEnabled, toggleDefault,
}: GlobalDefaultsSectionProps) {
    const { t } = useTranslation();
    const { onNavigate } = useShellProps({});
    const notSetUp = useNotSetUpOnServer();
    const notSetUpText = availabilityReasonText(t, 'not_configured');
    return (
        <div className="flex flex-col gap-6" data-testid="platform-defaults">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="m-0 max-w-2xl text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    {t('admin_platform.defaults_intro', 'Organisations created on this server start with a copy of these. An organisation without a list of its own follows them live, existing ones included.')}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={enableAllDefaults} className={QUIET_BTN}>{t('admin_platform.defaults_enable_all', 'Turn all on')}</button>
                    <button type="button" onClick={disableAllDefaults} className={QUIET_BTN}>{t('admin_platform.defaults_disable_all', 'Turn all off')}</button>
                </div>
            </div>

            {categories.map(cat => (
                <SettingsGroup key={cat} title={cat}>
                    <SettingsList>
                        {allIntegrations.filter(i => i.category === cat).map(integ => (
                            <SettingRow
                                inline
                                key={integ.id}
                                icon={integ.icon || undefined}
                                label={(
                                    <span className="flex flex-wrap items-center gap-2">
                                        {integ.label}
                                        {notSetUp(integ.id) ? <span className={CHIP} data-testid={`not-set-up-${integ.id}`}>{notSetUpText}</span> : null}
                                    </span>
                                )}
                                hint={integ.description}
                            >
                                <div className="flex justify-end">
                                    <Toggle checked={isDefaultEnabled(integ.id)} onChange={() => toggleDefault(integ.id)} ariaLabel={integ.label} />
                                </div>
                            </SettingRow>
                        ))}
                    </SettingsList>
                </SettingsGroup>
            ))}

            <div className={ALERT_INFO}>
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
                    <p className="m-0">
                        {t('admin_platform.defaults_access_note', 'Who may use each integration (per organisation, per group or for all members) is chosen under Access. These defaults only decide what a new organisation starts with.')}
                    </p>
                    {onNavigate ? (
                        <Button variant="ghost" size="sm" iconRight={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => onNavigate(ACCESS_PATH)}>
                            {t('admin_platform.open_access', 'Open Access')}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
