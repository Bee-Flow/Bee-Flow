import OrgNcIntegrationsPanel from '../../components/integrations/nextcloud/OrgNcIntegrationsPanel';
import HomeOrgOnlyNotice from '../../components/admin/organisation/HomeOrgOnlyNotice';
import { ServerWideDivider, ServerWideMark } from '../../components/admin/dashboard/serverWideNav';
import { useTranslation } from '../../hooks/useTranslation';
import { isPlatformAdmin } from '../../utils/adminAccess';
import GoogleMapsRow from './GoogleMapsRow';
import N8nSection from './N8nSection';
import type { SettingsUser } from './shell/settingsShellTypes';

interface OrgIntegrationSettingsProps {
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    /** The organisation to configure (the admin dashboard's); left out, the user's own. */
    orgId?: string | null;
    /**
     * The organisation is the viewer's home organisation. n8n is stored under
     * the caller's own organisation on the server (it takes no organisation
     * from the request), so for another one it is not offered.
     */
    homeOrg?: boolean;
    /** The admin dashboard: the instance-wide Google Maps key sits apart, under the "Whole server" divider. */
    markServerWide?: boolean;
}

interface IntegrationRows {
    showN8n: boolean;
    showGoogleMaps: boolean;
    showNc: boolean;
    /** The Maps row sits in the n8n list (Settings), not apart (the dashboard). */
    mapsInList: boolean;
}

/** Which rows this viewer gets for this organisation. */
function integrationRows(user: OrgIntegrationSettingsProps['user'], homeOrg: boolean, markServerWide: boolean): IntegrationRows {
    const ei = user?.enabledIntegrations;
    const platformAdmin = isPlatformAdmin(user);
    // The Maps key is instance-wide (POST /ai/config takes a platform admin), so
    // only a platform admin gets the row; for anyone else every save is refused.
    const showGoogleMaps = platformAdmin && (!ei || ei.includes('google-maps'));
    return {
        showN8n: homeOrg && (!ei || ei.includes('n8n')),
        showGoogleMaps,
        // NC-bound orgs get an additional org-admin panel for Nextcloud
        // integration management. For another organisation than the viewer's
        // own the session says nothing about its binding: a platform admin gets
        // the panel, as with the Nextcloud Sync row (showNcSync).
        showNc: homeOrg ? !!user?.ncOrg?.instanceId : platformAdmin,
        mapsInList: showGoogleMaps && !markServerWide,
    };
}

function SettingsIntro() {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl px-5 py-3 flex items-start gap-3 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
            <svg className="flex-shrink-0 mt-0.5 w-[16px] h-[16px] [color:#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-[12px] text-[var(--text-muted)]">
                {t('settings.org_integrations.settings_intro', 'Configure the integrations themselves — credentials, instance URLs and workflows.')}
            </p>
        </div>
    );
}

/** The bordered n8n / Maps list; only drawn when it has a row. */
function N8nMapsList({ showN8n, mapsInList }: { showN8n: boolean; mapsInList: boolean }) {
    const { t } = useTranslation();
    if (!showN8n && !mapsInList) return null;
    return (
        <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)]">
            {showN8n && (
                <div className={`${mapsInList ? '[border-bottom:1px_solid_var(--border-subtle)]' : '[border-bottom:none]'}`}>
                    <div className="flex items-center gap-3 px-5 py-3.5 bg-[var(--bg-secondary)]">
                        <img src="/n8n-color.png" alt="n8n" className="w-[20px] h-[20px] [object-fit:contain] [flex-shrink:0]" />
                        <div className="flex-1">
                            <p className="text-[13px] font-medium text-[var(--text-primary)]">n8n</p>
                            <p className="text-[11px] text-[var(--text-muted)]">{t('org.integ_n8n_desc')}</p>
                        </div>
                    </div>
                    <div className="px-5 pb-4 bg-[var(--bg-secondary)]">
                        <N8nSection />
                    </div>
                </div>
            )}
            {mapsInList && <GoogleMapsRow />}
        </div>
    );
}

/**
 * "Integration settings": the integrations' own configuration (the Nextcloud
 * integrations of an NC-bound organisation, n8n, the Google Maps key). Settings
 * shows it as the second tab of Organisation > Integrations, the admin
 * dashboard as Organisation > Integrations.
 */
export default function OrgIntegrationSettings({ user, orgId, homeOrg = true, markServerWide = false }: OrgIntegrationSettingsProps) {
    const { t } = useTranslation();
    const { showN8n, showGoogleMaps, showNc, mapsInList } = integrationRows(user, homeOrg, markServerWide);
    const nothing = homeOrg && !showN8n && !mapsInList && !showNc;

    return (
        <div className="space-y-4">
            <SettingsIntro />
            {/* Provider configuration (Nextcloud, n8n, Google Maps). */}
            <div className="space-y-4">
                {showNc && <OrgNcIntegrationsPanel user={user} orgId={orgId} />}
                {!homeOrg && <HomeOrgOnlyNotice />}
                {nothing && (
                    <div className="rounded-xl px-5 py-4 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                        <p className="text-[13px] text-[var(--text-muted)]">{t('org.integ_none')}</p>
                    </div>
                )}
                <N8nMapsList showN8n={showN8n} mapsInList={mapsInList} />
                {showGoogleMaps && markServerWide && (
                    <>
                        <ServerWideDivider />
                        <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)]" data-testid="org-integrations-maps">
                            <GoogleMapsRow mark={<ServerWideMark />} />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
