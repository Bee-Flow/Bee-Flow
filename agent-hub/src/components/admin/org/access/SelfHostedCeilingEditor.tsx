import { ArrowRight, Info, ShieldCheck, ToggleLeft } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useLicenseStatus } from '@/api/queries/serverLicense';
import { useShellProps } from '@/authedApp/useShellProps';
import { licenceTierLabel, serverLicenseView, type LicenseStatus } from '@/components/licensing/serverLicenseStatus';
import { Button } from '@/components/shared/Button';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_INFO, CHIP } from '@/components/shared/adminUi';

/** Where the licence key and the feature switches are changed: the Licence & features row. */
const LICENCE_PATH = 'admin/licenses';
const FEATURE_SWITCHES_PATH = 'admin/licenses/features';

function expiryText(t: ReturnType<typeof useTranslation>['t'], expiresAt: string | null | undefined): string | null {
    if (!expiresAt) return null;
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) return null;
    return t('admin_platform.ceiling_licence_expires', 'Expires {date}', { date: date.toLocaleDateString() });
}

/**
 * SelfHostedCeilingEditor — the self-hosted ceiling, read-only. On self-hosted
 * the ceiling is the server licence tier, raised or lowered by applying a
 * licence; operators also switch platform features off for the whole install.
 * Both are changed in one place only, Whole server > Licence & features: this
 * shows the tier the install runs at and links there, so the key and the
 * switches never have two editors.
 */
export default function SelfHostedCeilingEditor() {
    const { t } = useTranslation();
    const { onNavigate } = useShellProps({});
    const statusQuery = useLicenseStatus<LicenseStatus>();
    const view = serverLicenseView(statusQuery.data);
    const expiry = expiryText(t, view.licence?.expiresAt);
    const go = (path: string) => onNavigate?.(path);

    return (
        <SettingsGroup
            title={t('admin_org.ceiling_licence_title', 'Server licence')}
            description={(
                <span className="inline-flex items-start gap-1.5">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                        {t('admin_org.ceiling_licence_intro', 'The active licence tier is the capability ceiling for every organisation on this install. Distribute what it unlocks to members and groups under')} <strong>{t('admin_org.ceiling_grants', 'Grants')}</strong>.
                    </span>
                </span>
            )}
        >
            <SettingsList>
                <SettingRow
                    icon={<ShieldCheck className="h-4 w-4" />}
                    label={(
                        <span className="flex flex-wrap items-center gap-2">
                            {view.licence
                                ? t('admin.server_license.active_badge', 'Server-wide licence active')
                                : t('admin.server_license.inactive_badge', 'No server-wide licence applied')}
                            <span className={CHIP} data-testid="ceiling-licence-tier">{licenceTierLabel(t, view.tier)}</span>
                        </span>
                    )}
                    hint={expiry ?? undefined}
                >
                    <div className="flex @[40rem]/srow:justify-end">
                        <Button variant="secondary" size="sm" iconRight={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => go(LICENCE_PATH)} disabled={!onNavigate}>
                            {t('admin_platform.ceiling_manage_licence', 'Manage licence')}
                        </Button>
                    </div>
                </SettingRow>
                <SettingRow
                    icon={<ToggleLeft className="h-4 w-4" />}
                    label={t('admin_platform.feature_switches', 'Feature switches')}
                    hint={t('admin_platform.ceiling_switches_hint', 'Platform features switched off for everyone on this server are outside every ceiling.')}
                >
                    <div className="flex @[40rem]/srow:justify-end">
                        <Button variant="secondary" size="sm" iconRight={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => go(FEATURE_SWITCHES_PATH)} disabled={!onNavigate}>
                            {t('admin_platform.ceiling_open_switches', 'Open feature switches')}
                        </Button>
                    </div>
                </SettingRow>
            </SettingsList>
            {view.licence && !view.governing ? (
                <p className={ALERT_INFO}>
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('admin.server_license.not_governing', 'This licence is recorded but does not cover organisations on this deployment — each organisation still needs its own subscription.')}</span>
                </p>
            ) : null}
        </SettingsGroup>
    );
}
