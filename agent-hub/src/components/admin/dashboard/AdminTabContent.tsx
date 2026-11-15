// The content of the admin dashboard's current tab, always in the one page
// frame (AdminPage): the page header (the current rail row's label and
// description) and the width, decided here for every row. Two kinds of panel:
//   padded  the frame pads the page (a settings form, a list or a grid; also the
//           hubs whose sections are rail rows: with nav={false} they render the
//           section body only, without padding of their own);
//   fill    the panel owns its scrolling (a list beside a detail, an editor with
//           its own columns, a report with a drawer): it fills the pane under
//           the header.
// The Organisation tab frames its own sections (OrganisationHub, OrgSectionBody)
// with the same header, because the width follows the section it opens.
// Either way edge to edge: no tab sits in an extra framed inset.

import type { ReactNode } from 'react';
import AgentConfigHub from '@/components/agents/AgentConfigHub';
import AIConfigPanel from '@/components/admin/ai-config';
import SecurityHub from '@/components/admin/security/SecurityHub';
import IntegrationsAdminPanel from '@/components/integrations/IntegrationsAdminPanel';
import MonitoringPanel from '@/components/admin/monitoring';
import ComplianceHub from '@/components/admin/compliance';
import SubscriptionsPanel from '@/components/admin/subscriptions';
import LanguagesPanel from '@/components/admin/languages/LanguagesPanel';
import AppearancePanel from '@/components/appearance/studio/AppearancePanel';
import AnalyticsPanel from '@/components/admin/product-website/AnalyticsPanel';
import ReleaseNotesPanel from '@/components/admin/product-website/ReleaseNotesPanel';
import ServerLicensePanel from '@/components/licensing/ServerLicensePanel';
import ModulesPanel from '@/components/admin/modules';
import SupportInboxPanel from '@/components/support/SupportInboxPanel';
import AccessPermissionsPanel from '@/components/admin/org/AccessPermissionsPanel';
import NextcloudInstancesPanel from '@/components/admin/org/NextcloudInstancesPanel';
import UserManagement from '@/components/admin/org/UserManagement';
import OrganisationHub from '@/components/admin/organisation/OrganisationHub';
import FeatureKillSwitches from '@/components/integrations/FeatureKillSwitches';
import ServerMcpPanel from '@/components/mcpLibrary/server/ServerMcpPanel';
import AdminPage, { type AdminPageWidth } from './AdminPage';

export interface AdminTabContentProps {
    activeTab: string;
    hasPermission: (perm: string) => boolean;
    agentSection: string;
    adminPath: { seg1?: string; seg2?: string; seg3?: string };
    /** The current rail row's label: the page header. */
    title?: string;
    /** The current rail row's description, under the header. */
    description?: string;
}

/** How a tab's page is framed: its width, and whether the header carries the row's description. */
interface PageFrame {
    width: AdminPageWidth;
    /** false: the header names the page only (the panel shows the page's description itself). */
    description?: boolean;
}

/** A tab's frame, or a function of its section (the hubs whose sections differ in width). */
type FrameOf = PageFrame | ((section: string) => PageFrame);

type Panel = { render: (p: AdminTabContentProps) => ReactNode; frame: FrameOf | 'own' };

const SETTINGS: PageFrame = { width: 'settings' };
const WIDE: PageFrame = { width: 'wide' };
const FILL: PageFrame = { width: 'fill' };
/** Usage & monitoring: the panel opens on the page's description and scope, beside the period. */
const WIDE_NAME_ONLY: PageFrame = { width: 'wide', description: false };

/** A frame by section: `settings` for the sections listed, the rest `wide`. */
function bySection(settings: readonly string[], fallback: string): (section: string) => PageFrame {
    return (section) => ({ width: settings.includes(section || fallback) ? 'settings' : 'wide' });
}

function Frame({ tab, frame, section, title, description, children }: { tab: string; frame: Panel['frame']; section: string; title?: string; description?: string; children: ReactNode }) {
    const page = frame === 'own' ? null : (typeof frame === 'function' ? frame(section) : frame);
    const scrolls = !page || page.width !== 'fill';
    return (
        <div className={`absolute inset-0 ${scrolls ? 'overflow-auto' : 'overflow-hidden'}`} data-testid={`admin-tab-${tab}`}>
            {page
                ? <AdminPage title={title} description={page.description === false ? undefined : description} width={page.width}>{children}</AdminPage>
                : children}
        </div>
    );
}

/** The Platform services sections (the child rows of the integrations tab). */
const PLATFORM_SERVICE_SECTIONS: readonly string[] = ['defaults', 'email', 'transcription', 'connected-apps'];
/** The People tab's own tabs of the users screen; the rest are rows of their own. */
const PEOPLE_SECTIONS: readonly string[] = ['users', 'invitations', 'groups', 'org-roles'];

/** The licence row's page: the global feature switches (the frame names them: the list only), or the server licence. */
function LicensePage({ section }: { section?: string }) {
    return section === 'features' ? <FeatureKillSwitches bare /> : <ServerLicensePanel />;
}

/** An address segment as a panel prop: an empty one is none. */
const seg = (value: string | undefined): string | undefined => value || undefined;

/**
 * The panel of each tab and its frame; a tab without one renders nothing here
 * (product-website escapes the chrome). A hub's sections are rail rows, so
 * every hub renders without its own section column (D5); the list/detail tools
 * keep theirs and fill the pane.
 */
const PANELS: Record<string, Panel> = {
    agents: { render: (p) => <AgentConfigHub nav={false} hasPermission={p.hasPermission} activeSection={p.agentSection} />, frame: FILL },
    organisation: {
        render: (p) => <OrganisationHub activeSection={p.adminPath.seg2} title={p.title} description={p.description} />,
        frame: 'own',
    },
    people: { render: (p) => <UserManagement sections={PEOPLE_SECTIONS} activeSection={p.adminPath.seg2} />, frame: FILL },
    'ai-config': {
        render: (p) => <AIConfigPanel nav={false} activeSection={p.adminPath.seg2} activeProvider={p.adminPath.seg3} />,
        frame: bySection(['retrieval', 'direct-chat', 'limits'], 'providers'),
    },
    security: {
        render: (p) => <SecurityHub nav={false} activeSection={p.adminPath.seg2} userSection={p.adminPath.seg3} />,
        frame: bySection(['sso'], 'guardrails'),
    },
    integrations: {
        render: (p) => <IntegrationsAdminPanel sections={PLATFORM_SERVICE_SECTIONS} activeSection={p.adminPath.seg2} />,
        frame: bySection(['defaults', 'email'], 'defaults'),
    },
    access: { render: (p) => <AccessPermissionsPanel tabs activeSection={p.adminPath.seg2} />, frame: WIDE },
    // nav={false}: the panel neither pads nor scrolls itself; the frame does both.
    monitoring: { render: (p) => <MonitoringPanel nav={false} activeSection={p.adminPath.seg2} />, frame: WIDE_NAME_ONLY },
    compliance: { render: (p) => <ComplianceHub activeSection={p.adminPath.seg2} focusCheckId={p.adminPath.seg3} />, frame: FILL },
    subscriptions: { render: (p) => <SubscriptionsPanel activeSection={p.adminPath.seg2} />, frame: FILL },
    // admin/support/<view>/<item>; the server's ticket link admin/support/<threadId> is a view the panel resolves.
    support: { render: (p) => <SupportInboxPanel view={p.adminPath.seg2 ?? ''} item={seg(p.adminPath.seg3)} />, frame: FILL },
    licenses: { render: (p) => <LicensePage section={p.adminPath.seg2} />, frame: SETTINGS },
    modules: { render: () => <ModulesPanel />, frame: WIDE },
    appearance: { render: (p) => <AppearancePanel section={p.adminPath.seg2 === 'icon-packs' ? 'icon-packs' : 'look'} />, frame: FILL },
    languages: { render: (p) => <LanguagesPanel locale={seg(p.adminPath.seg2)} section={seg(p.adminPath.seg3)} />, frame: FILL },
    organisations: { render: () => <UserManagement sections={['organizations']} activeSection="organizations" />, frame: FILL },
    roles: { render: (p) => <UserManagement sections={['roles', 'permissions']} activeSection={p.adminPath.seg2 || 'roles'} />, frame: FILL },
    'mcp-servers': { render: () => <ServerMcpPanel />, frame: WIDE },
    'nextcloud-instances': { render: (p) => <NextcloudInstancesPanel section={p.adminPath.seg2} orgId={p.adminPath.seg3} />, frame: FILL },
    'website-analytics': { render: (p) => <AnalyticsPanel activeSection={seg(p.adminPath.seg2)} />, frame: FILL },
    'release-notes': { render: () => <ReleaseNotesPanel />, frame: SETTINGS },
};

export default function AdminTabContent(props: AdminTabContentProps) {
    const panel = Object.hasOwn(PANELS, props.activeTab) ? PANELS[props.activeTab] : null;
    if (!panel) return null;
    return (
        <Frame tab={props.activeTab} frame={panel.frame} section={props.adminPath.seg2 ?? ''} title={props.title} description={props.description}>
            {panel.render(props)}
        </Frame>
    );
}
