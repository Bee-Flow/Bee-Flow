import { useState, type ReactNode } from 'react';
import OrgInfoPanel, { SECTIONS as INFO_SECTIONS } from '../../components/admin/org/OrgInfoPanel';
import OrgAcademyPanel from './OrgAcademyPanel';
import GitHubSyncPanel from '../../components/integrations/github/GitHubSyncPanel';
import OrgMcpAccessPanel from '../../components/mcpAccess/OrgMcpAccessPanel';
import McpLibraryPage from '../../components/mcpLibrary/McpLibraryPage';
import SaveBar from '@/components/shared/SaveBar';
import { orgStandingFactsOf } from '@/components/admin/organisation/orgSections';
import OrgMeetingNotesSection from './OrgMeetingNotesSection';
import OrgNextcloudSection from './OrgNextcloudSection';
import OrgPageHeading from './OrgPageHeading';
import type { FormMessage, OrgInfoSaveState } from '../../components/admin/org/orgInfo/useOrgInfoForm';
import type { SettingsUser } from './shell/settingsShellTypes';

/* ── OrganisationSection ─────────────────────────────────────────────────── */
// The info sections whose fields belong to OrgInfoPanel's org form, saved by
// the save bar below (see showOrgSaveBar).
const ORG_FORM_SECTIONS = ['license', 'auth', 'info'];

// The pages that draw their own title outside the admin dashboard (McpLibraryPage
// without a `view`, the Privacy Shield's title row): a heading here would name them twice.
const SELF_NAMED_SECTIONS: ReadonlySet<string> = new Set(['mcp', 'privacy']);

// The section of an organisation the admin dashboard's Organisation tab opens
// (components/admin/organisation/OrgSectionBody, which draws Integrations and
// Microsoft 365 itself), the licence page a phone keeps in Settings, and the
// Organisation Info tab of /app/org-settings on a phone. activeSection names
// the section as the Settings tab ids did: an OrgInfoPanel section, 'academy',
// 'mcp', 'mcp_access', 'github_sync', 'nextcloud_sync', 'meeting_templates'.
interface OrganisationSectionProps {
    user: (SettingsUser & { enabledIntegrations?: string[] }) | null | undefined;
    activeSection?: string;
    /**
     * The organisation to work on: given by the admin dashboard (the chosen
     * one); left out, the user's own, as Settings always did.
     */
    orgId?: string | null;
    /**
     * The organisation is the viewer's home organisation. The parts the server
     * ties to the caller's own organisation (the summary templates, Nextcloud
     * pairing codes, the Teams setup) are offered for that one only.
     */
    homeOrg?: boolean;
}

type OrgSaveState = Omit<OrgInfoSaveState, 'message' | 'handleSave'> & { message: FormMessage | null; handleSave: OrgInfoSaveState['handleSave'] | null };

/** The save bar's line for the last save: a mark and the panel's text. */
function saveBarMessage(message: FormMessage | null) {
    if (!message) return null;
    return { type: message.type, text: `${message.type === 'success' ? '✓' : '⚠'} ${message.text}` };
}

interface OrgAdminPageProps {
    user: OrganisationSectionProps['user'];
    orgId: string | null | undefined;
    homeOrg: boolean;
    platformAdmin: boolean;
}

/** The sections only an organisation admin (or the platform admin) gets, by their Settings id. */
const ORG_ADMIN_PAGES: Readonly<Record<string, (p: OrgAdminPageProps) => ReactNode>> = {
    // Academy — org learning overview
    academy: (p) => <OrgAcademyPanel user={p.user} />,
    // MCP library — the organisation's remote MCP servers (the platform admin's server-wide tab too)
    mcp: (p) => <McpLibraryPage isServerAdmin={p.platformAdmin} />,
    // MCP access — the organisation-wide rules for external MCP clients
    mcp_access: () => <OrgMcpAccessPanel />,
    github_sync: (p) => <GitHubSyncPanel user={p.user} />,
    // Nextcloud: the user sync of a bound organisation, or pairing one to the viewer's own.
    nextcloud_sync: (p) => <OrgNextcloudSection user={p.user} orgId={p.orgId} homeOrg={p.homeOrg} />,
    // Meeting notes: the summary templates, then a card per meeting source the
    // organisation can use. The admin dashboard names the organisation; Settings on a phone does not.
    meeting_templates: (p) => <OrgMeetingNotesSection user={p.user} orgId={p.orgId} homeOrg={p.homeOrg} inDashboard={p.orgId !== undefined} />,
};

const OrganisationSection = ({ user, activeSection = 'license', orgId, homeOrg = true }: OrganisationSectionProps) => {
    const [orgState, setOrgState] = useState<OrgSaveState>({ hasChanges: false, saving: false, message: null, handleSave: null });

    // One standing for the rail and the page (admin/organisation/orgSections): an
    // organisation admin (`all`, `org_admin` or an organisation-admin role) or the
    // platform admin. Another admin_* permission opens none of these pages.
    const standing = orgStandingFactsOf(user);
    const isOrgAdmin = standing.canSeeOrg || standing.isPlatformAdmin;
    const adminPage = isOrgAdmin && Object.hasOwn(ORG_ADMIN_PAGES, activeSection)
        ? ORG_ADMIN_PAGES[activeSection]({ user, orgId, homeOrg, platformAdmin: standing.isPlatformAdmin })
        : null;

    const isInfoSection = INFO_SECTIONS.some(s => s.id === activeSection);
    // The save bar serves only the sections whose fields live in
    // OrgInfoPanel's org form (License & Usage, Sign-in Method, Organisation
    // Info) — the ones that report through onStateChange. Every other info
    // section brings its own Save and has to: the Privacy Shield's Save must
    // be DISABLED when its config could not be loaded and hidden in read-only
    // mode, and Encryption, AI & Collaboration and Answer Reuse each save
    // their own editor. OrgInfoPanel stays mounted between info sections, so
    // showing the bar there put an unsaved Org Info edit's "Save changes"
    // above an editor it does not save.
    const showOrgSaveBar = ORG_FORM_SECTIONS.includes(activeSection);
    // The admin dashboard names the organisation and frames the page with its header.
    const inDashboard = orgId !== undefined;
    const showsPage = isInfoSection || adminPage !== null;
    const showHeading = !inDashboard && showsPage && !SELF_NAMED_SECTIONS.has(activeSection);

    return (
        <div>
            {showHeading && <OrgPageHeading section={activeSection} />}

            {/* Sticky at the top, so Save stays in reach on the long License and Info pages. */}
            {showOrgSaveBar && (
                <SaveBar
                    dirty={orgState.hasChanges}
                    saving={orgState.saving}
                    message={saveBarMessage(orgState.message)}
                    onSave={() => orgState.handleSave?.()}
                />
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

            {adminPage}
        </div>
    );
};

export default OrganisationSection;
