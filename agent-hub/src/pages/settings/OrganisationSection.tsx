import React, { useState } from 'react';
import OrgInfoPanel, { SECTIONS as INFO_SECTIONS } from '../../components/admin/org/OrgInfoPanel';
import OrgAcademyPanel from './OrgAcademyPanel';
import GitHubSyncPanel from '../../components/integrations/github/GitHubSyncPanel';
import NextcloudSyncPanel from '../../components/integrations/nextcloud/NextcloudSyncPanel';
import OrgMcpAccessPanel from '../../components/mcpAccess/OrgMcpAccessPanel';
import MeetingNotesAdminPanel from '../../components/meetings/MeetingNotesAdminPanel';
import GoogleMeetAdminPanel from '../../components/meetings/GoogleMeetAdminPanel';
import TeamsAdminPanel from '../../components/meetings/TeamsAdminPanel';
import SummaryTemplatesAdminPanel from '../../components/meetings/SummaryTemplatesAdminPanel';
import OrgNcPairingPanel from '../../components/integrations/nextcloud/OrgNcPairingPanel';
import McpLibraryPage from '../../components/mcpLibrary/McpLibraryPage';
import HomeOrgOnlyNotice from '../../components/admin/organisation/HomeOrgOnlyNotice';
import { isOrgAdminRole } from '../../utils/adminAccess';
import { useTranslation } from '../../hooks/useTranslation';
import { useEntitlements } from '../../components/licensing/EntitlementsContext';
import type { FormMessage, OrgInfoSaveState } from '../../components/admin/org/orgInfo/useOrgInfoForm';
import type { SettingsUser } from './shell/settingsShellTypes';

/* ── OrganisationSection ─────────────────────────────────────────────────── */
// The info sections whose fields belong to OrgInfoPanel's org form, saved by
// the generic save bar below (see showOrgSaveBar).
const ORG_FORM_SECTIONS = ['license', 'auth', 'info'];

// The section of an organisation the admin dashboard's Organisation tab opens
// (components/admin/organisation/OrgSectionBody, which draws Integrations and
// Azure itself), the licence page a phone keeps in Settings, and the
// Organisation Info tab of /app/org-settings on a phone. activeSection names
// the section as the Settings tab ids did: an OrgInfoPanel section, 'academy',
// 'mcp', 'mcp_access', 'github_sync', 'nextcloud_sync', 'meeting_templates'.
interface OrganisationSectionProps {
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    activeSection?: string;
    /** The organisation to work on (the admin dashboard's); left out, the user's own, as Settings always did. */
    orgId?: string | null;
    /**
     * The organisation is the viewer's home organisation. The parts the server
     * ties to the caller's own organisation (the summary templates, Nextcloud
     * pairing codes) are offered for that one only.
     */
    homeOrg?: boolean;
}

const OrganisationSection = ({ user, activeSection = 'license', orgId, homeOrg = true }: OrganisationSectionProps) => {
    const { t } = useTranslation();
    const [orgState, setOrgState] = useState<Omit<OrgInfoSaveState, 'message' | 'handleSave'> & { message: FormMessage | null; handleSave: OrgInfoSaveState['handleSave'] | null }>({ hasChanges: false, saving: false, message: null, handleSave: null });

    const perms = user?.permissions || [];
    const isFullAdmin = perms.includes('all') || perms.some(p => p.startsWith('admin_'));
    // An organisation-admin role counts as org_admin, as for the menu that opens these pages (canSeeOrg).
    const isOrgAdmin = perms.includes('org_admin') || isFullAdmin || isOrgAdminRole(user?.orgRole);

    const isNcOrg = !!user?.ncOrg?.instanceId;
    // Talk Meeting Notes sits under Nextcloud Sync, a row every NC-bound org
    // gets, but its API needs the Meeting Notes module and licence. Same
    // predicate as the Meeting Templates section (admin/organisation/orgSections): hidden
    // while the snapshot loads, open when the snapshot failed or is degraded.
    const entitlements = useEntitlements();
    const meetingNotesInPlan = !entitlements.loading
        && (!!entitlements.error || entitlements.degraded || entitlements.inCeiling('meeting_notes'));

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
                    orgId={orgId}
                    activeSection={activeSection}
                    onStateChange={setOrgState}
                />
            )}

            {/* Academy — org learning overview */}
            {activeSection === 'academy' && isOrgAdmin && (
                <OrgAcademyPanel user={user} />
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
            {activeSection === 'github_sync' && isOrgAdmin && <GitHubSyncPanel user={user} />}

            {/* Nextcloud Sync. The sync panel leads: its "Nextcloud Sync"
                header is the page title, and it holds what an admin opens this
                page for. Pairing a further Nextcloud is rare, so it follows. */}
            {activeSection === 'nextcloud_sync' && isOrgAdmin && (
                <>
                    <NextcloudSyncPanel user={user} orgId={orgId} />
                    {(isNcOrg || isFullAdmin) && homeOrg && <div className="mt-6"><OrgNcPairingPanel /></div>}
                    {meetingNotesInPlan && <MeetingNotesAdminPanel user={user} orgId={orgId} />}
                </>
            )}

            {/* Meeting templates: the org and group summary templates, then the
                org-level Google Meet and Microsoft Teams meeting-notes settings.
                Those two need no Nextcloud, so they cannot sit under Nextcloud
                Sync, a row only NC-bound orgs (and super-admins) get. Talk stays
                there: it only exists with a Nextcloud. */}
            {activeSection === 'meeting_templates' && isOrgAdmin && (
                <>
                    {homeOrg ? <SummaryTemplatesAdminPanel /> : <HomeOrgOnlyNotice />}
                    <GoogleMeetAdminPanel user={user} orgId={orgId} />
                    <TeamsAdminPanel user={user} orgId={orgId} />
                </>
            )}
        </div>
    );
};

export default OrganisationSection;
