import React, { useState } from 'react';
import { settingsPathForTab } from '../../authedApp/settingsRoutes';
import OrgInfoPanel, { SECTIONS as INFO_SECTIONS } from '../../components/admin/org/OrgInfoPanel';
import OrgUsersPanel from '../../components/admin/org/OrgUsersPanel';
import OrgAcademyPanel from './OrgAcademyPanel';
import N8nSection from './N8nSection';
import UsageSection from './UsageSection';
import GitHubSyncPanel from '../../components/integrations/github/GitHubSyncPanel';
import NextcloudSyncPanel from '../../components/integrations/nextcloud/NextcloudSyncPanel';
import OrgMcpAccessPanel from '../../components/mcpAccess/OrgMcpAccessPanel';
import MeetingNotesAdminPanel from '../../components/meetings/MeetingNotesAdminPanel';
import GoogleMeetAdminPanel from '../../components/meetings/GoogleMeetAdminPanel';
import TeamsAdminPanel from '../../components/meetings/TeamsAdminPanel';
import SummaryTemplatesAdminPanel from '../../components/meetings/SummaryTemplatesAdminPanel';
import OrgNcIntegrationsPanel from '../../components/integrations/nextcloud/OrgNcIntegrationsPanel';
import OrgNcPairingPanel from '../../components/integrations/nextcloud/OrgNcPairingPanel';
import GroupAccessMatrix from '../../components/admin/org/GroupAccessMatrix';
import McpLibraryPage from '../../components/mcpLibrary/McpLibraryPage';
import Tabs from '../../components/shared/Tabs';
import { API_BASE, authFetch } from '../../utils/helpers';
import { useTranslation } from '../../hooks/useTranslation';
import type { FormMessage, OrgInfoSaveState } from '../../components/admin/org/orgInfo/useOrgInfoForm';
import type { SettingsUser } from './shell/settingsShellTypes';

/* ── Google Maps integration card ────────────────────────────────────────── */
const GoogleMapsRow = () => {
    const { t } = useTranslation();
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [hasKey, setHasKey] = useState(false);
    const [open, setOpen] = useState(false);

    React.useEffect(() => {
        authFetch(`${API_BASE}/ai/config`)
            .then(r => r.json())
            .then(d => setHasKey(!!d.hasGoogleMapsKey))
            .catch(() => {});
    }, []);

    const save = async () => {
        if (!key.trim()) return;
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ googleMapsApiKey: key }),
            });
            if (res.ok) { setHasKey(true); setKey(''); setOpen(false); }
        } catch (e) { console.error(e); }
        setSaving(false);
    };

    return (
        <div>
            <button
                className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors [background:var(--bg-secondary)]"
                onClick={() => setOpen(v => !v)}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
            >
                <div className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" fill="none" className="w-[18px] h-[18px]">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335" />
                        <circle cx="12" cy="9" r="2.5" fill="#fff" />
                    </svg>
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text-primary)]">Google Maps</p>
                    <p className="text-[11px] truncate text-[var(--text-muted)]">
                        {hasKey ? t('org.integ_maps_configured') : t('org.integ_maps_desc')}
                    </p>
                </div>
                {hasKey && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 [background:rgba(5,150,105,0.1)] [color:#059669]!">{t('settings.connected')}</span>
                )}
                <svg className="flex-shrink-0" style={{ color: 'var(--text-muted)', width: '13px', height: '13px', transition: 'transform 150ms', transform: open ? 'rotate(90deg)' : 'none' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
            </button>
            {open && (
                <div className="px-5 pb-4 pt-2 space-y-2 [background:var(--bg-secondary)] [border-top:1px_solid_var(--border-subtle)]">
                    <div className="flex gap-2">
                        <input
                            type="password" value={key} onChange={e => setKey(e.target.value)}
                            placeholder={hasKey ? '••••••••••••••••' : t('org.integ_maps_desc')}
                            className="flex-1 px-3 py-2 rounded-lg border outline-none text-[13px] [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                            onKeyDown={e => e.key === 'Enter' && save()}
                        />
                        <button onClick={save} disabled={saving || !key.trim()}
                            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]">
                            {saving ? '…' : t('org.save_changes')}
                        </button>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)]">
                        {t('settings.org_integrations.maps_enable', 'Enable')} <strong>Directions API</strong>, <strong>Places API</strong> &amp; <strong>Maps Embed API</strong> {t('settings.org_integrations.maps_in', 'in')}{' '}
                        <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener noreferrer"
                            className="underline text-[var(--accent-primary)]">Google Cloud Console</a>
                    </p>
                </div>
            )}
        </div>
    );
};

/* ── OrganisationSection ─────────────────────────────────────────────────── */
// The info sections whose fields belong to OrgInfoPanel's org form, saved by
// the generic save bar below (see showOrgSaveBar).
const ORG_FORM_SECTIONS = ['license', 'auth', 'info'];

// activeSection is now controlled entirely by the parent sidebar.
// Possible values: 'license' | 'auth' | 'privacy' | 'info' | 'users' | 'integrations'
interface OrganisationSectionProps {
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    activeSection?: string;
    usageInitialReport?: string;
}

const OrganisationSection = ({ user, activeSection = 'license', usageInitialReport = '' }: OrganisationSectionProps) => {
    const { t } = useTranslation();
    const [orgState, setOrgState] = useState<Omit<OrgInfoSaveState, 'message' | 'handleSave'> & { message: FormMessage | null; handleSave: OrgInfoSaveState['handleSave'] | null }>({ hasChanges: false, saving: false, message: null, handleSave: null });
    // Integrations sub-tab: 'access' (who can use which integration) | 'settings' (provider credentials / instance URLs)
    const [intTab, setIntTab] = useState('access');

    const perms = user?.permissions || [];
    const isFullAdmin = perms.includes('all') || perms.some(p => p.startsWith('admin_'));
    const isOrgAdmin = perms.includes('org_admin') || isFullAdmin;

    const ei = user?.enabledIntegrations;
    const showN8n = !ei || ei.includes('n8n');
    const showGoogleMaps = !ei || ei.includes('google-maps');
    // NC-bound orgs get an additional org-admin panel for Nextcloud
    // integration management (Fase G). Standalone orgs never see it.
    const isNcOrg = !!user?.ncOrg?.instanceId;

    const isInfoSection = INFO_SECTIONS.some(s => s.id === activeSection);
    // The generic save bar serves only the sections whose fields live in
    // OrgInfoPanel's org form (License & Usage, Sign-in Method, Organisation
    // Info) — the ones that report through onStateChange. Every other info
    // section brings its own Save and has to: the Privacy Shield's Save must
    // be DISABLED when its config could not be loaded and hidden in read-only
    // mode, and Encryption, AI & Collaboration and Answer Reuse each save
    // their own editor. OrgInfoPanel stays mounted between info sections, so
    // showing the bar there put an unsaved Org Info edit's "Save changes"
    // above an editor it does not save.
    const showOrgSaveBar = ORG_FORM_SECTIONS.includes(activeSection);

    return (
        <div>
            {/* Save bar — shown above the form sections when they have changes;
                sticky so it stays in reach on the long License and Info pages. */}
            {showOrgSaveBar && (orgState.hasChanges || orgState.saving || orgState.message) && (
                <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 rounded-xl mb-4 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                    {orgState.message && (
                        <span className={`text-[12px] font-medium flex items-center gap-1.5 ${orgState.message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>
                            {orgState.message.type === 'success' ? '✓' : '⚠'} {orgState.message.text}
                        </span>
                    )}
                    {orgState.hasChanges && !orgState.message && (
                        <span className="text-[12px] font-medium flex items-center gap-1.5 text-[var(--warning-ink)]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] flex-shrink-0" />
                            {t('org.unsaved_changes')}
                        </span>
                    )}
                    <div className="flex-1" />
                    <button
                        onClick={() => orgState.handleSave?.()}
                        disabled={orgState.saving || !orgState.hasChanges}
                        className="px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all disabled:opacity-40 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                    >
                        {orgState.saving ? t('org.saving') : t('org.save_changes')}
                    </button>
                </div>
            )}

            {/* Org info sub-sections */}
            {isInfoSection && (
                <OrgInfoPanel
                    user={user}
                    activeSection={activeSection}
                    onStateChange={setOrgState}
                />
            )}

            {/* Users & Groups */}
            {activeSection === 'users' && (
                <OrgUsersPanel user={user} basePath={settingsPathForTab('org_users')} />
            )}

            {/* Academy — org learning overview */}
            {activeSection === 'academy' && isOrgAdmin && (
                <OrgAcademyPanel user={user} />
            )}

            {/* Usage & Monitoring */}
            {activeSection === 'usage' && (
                <UsageSection initialReport={usageInitialReport} />
            )}

            {/* Integrations */}
            {activeSection === 'integrations' && isOrgAdmin && (
                <div className="space-y-4">
                    <div>
                        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('org.integ_title')}</h2>
                        <p className="mt-1 text-sm text-[var(--text-muted)]">{t('org.integ_subtitle')}</p>
                    </div>
                    <Tabs
                        value={intTab}
                        onChange={setIntTab}
                        ariaLabel={t('org.integ_title')}
                        items={[
                            { id: 'access', label: t('org.integ_tab_access') },
                            { id: 'settings', label: t('org.integ_tab_settings') },
                        ]}
                    />

                    {/* Integration access — the integrations the subscription
                        enables (MCP servers included as ordinary integrations).
                        The org-admin grants each to the whole organisation or a
                        specific group right here. The page title above and the
                        selected tab already name it, so the matrix shows no
                        heading of its own. */}
                    {intTab === 'access' && (
                        <GroupAccessMatrix
                            kinds={['integration']}
                            hideLocked
                            hideHeading
                            subtitle={t('org.integ_access_subtitle', 'Give an integration to your whole organisation or to a specific group. These are the integrations your subscription includes.')}
                        />
                    )}

                    {/* Integration settings — configure the integrations
                        themselves (credentials, instance URLs, workflows). */}
                    {intTab === 'settings' && (
                        <div className="space-y-4">
                            <div className="rounded-xl px-5 py-3 flex items-start gap-3 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                                <svg className="flex-shrink-0 mt-0.5 w-[16px] h-[16px] [color:#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <p className="text-[12px] text-[var(--text-muted)]">
                                    {t('settings.org_integrations.settings_intro', 'Configure the integrations themselves — credentials, instance URLs and workflows.')}
                                </p>
                            </div>

                            {/* Provider configuration (Nextcloud, n8n, Google Maps).
                                The bordered n8n / Maps list only renders when it
                                has a row: an NC org with neither enabled showed
                                an empty box under its Nextcloud panel. */}
                            <div className="space-y-4">
                                {isNcOrg && <OrgNcIntegrationsPanel user={user} />}
                                {!showN8n && !showGoogleMaps && !isNcOrg && (
                                    <div className="rounded-xl px-5 py-4 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
                                        <p className="text-[13px] text-[var(--text-muted)]">
                                            {t('org.integ_none')}
                                        </p>
                                    </div>
                                )}
                                {(showN8n || showGoogleMaps) && (
                                    <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)]">
                                        {showN8n && (
                                            <div style={{ borderBottom: showGoogleMaps ? '1px solid var(--border-subtle)' : 'none' }}>
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
                                        {showGoogleMaps && <GoogleMapsRow />}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* MCP library — the organisation's remote MCP servers */}
            {activeSection === 'mcp' && isOrgAdmin && (
                <McpLibraryPage isServerAdmin={!!user?.isAdmin || user?.role === 'admin' || perms.includes('all')} />
            )}

            {/* MCP access — the organisation-wide rules for external MCP clients */}
            {activeSection === 'mcp_access' && isOrgAdmin && (
                <OrgMcpAccessPanel />
            )}

            {/* GitHub Sync */}
            {activeSection === 'github_sync' && isOrgAdmin && (
                <GitHubSyncPanel user={user} />
            )}

            {/* Nextcloud Sync. The sync panel leads: its "Nextcloud Sync"
                header is the page title, and it holds what an admin opens this
                page for. Pairing a further Nextcloud is rare, so it follows. */}
            {activeSection === 'nextcloud_sync' && isOrgAdmin && (
                <>
                    <NextcloudSyncPanel user={user} />
                    {(isNcOrg || isFullAdmin) && <div className="mt-6"><OrgNcPairingPanel /></div>}
                    <MeetingNotesAdminPanel user={user} />
                </>
            )}

            {/* Meeting templates: the org and group summary templates, then the
                org-level Google Meet and Microsoft Teams meeting-notes settings.
                Those two need no Nextcloud, so they cannot sit under Nextcloud
                Sync, a row only NC-bound orgs (and super-admins) get. Talk stays
                there: it only exists with a Nextcloud. */}
            {activeSection === 'meeting_templates' && isOrgAdmin && (
                <>
                    <SummaryTemplatesAdminPanel />
                    <GoogleMeetAdminPanel user={user} />
                    <TeamsAdminPanel user={user} />
                </>
            )}
        </div>
    );
};

export default OrganisationSection;
