// The content of the admin dashboard's current tab, in one of three frames:
//   area   the panel fills the pane and owns its layout (the hubs, whose
//          sections are rail rows now, Monitoring, Compliance, Support, ...);
//   page   a single settings page: the pane scrolls and the page sits in the
//          one page frame (AdminPage: padding, width, the header from the
//          rail label once the panel no longer draws its own);
//   scroll the pane scrolls and the panel frames its pages itself (the
//          Organisation tab, whose OrgSectionBody renders AdminPage).
// Either way edge to edge: no tab sits in an extra framed inset any more.

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
import SectionHeader from '@/components/shared/SectionHeader';
import { useTranslation } from '@/hooks/useTranslation';
import AdminPage, { type AdminPageWidth } from './AdminPage';

export interface AdminTabContentProps {
    activeTab: string;
    hasPermission: (perm: string) => boolean;
    agentSection: string;
    adminPath: { seg1?: string; seg2?: string; seg3?: string };
    /** The current rail row's label: the page header of a tab whose panel no longer draws its own. */
    title?: string;
}

/** A page-framed tab: its width, and whether the frame draws the header (the panel's own is gone). */
interface PageFrame {
    width: AdminPageWidth;
    header?: boolean;
}

type Panel = { render: (p: AdminTabContentProps) => ReactNode; page?: PageFrame | 'scroll' };

function Frame({ tab, page, title, children }: { tab: string; page?: Panel['page']; title?: string; children: ReactNode }) {
    return (
        <div className={`absolute inset-0 ${page ? 'overflow-auto' : 'overflow-hidden'}`} data-testid={`admin-tab-${tab}`}>
            {page && page !== 'scroll'
                ? <AdminPage width={page.width} title={page.header ? title : undefined}>{children}</AdminPage>
                : children}
        </div>
    );
}

/** The page frames of the settings pages; every panel here still draws its own header. */
const SETTINGS_PAGE: PageFrame = { width: 'settings' };
const WIDE_PAGE: PageFrame = { width: 'wide' };

/** The Platform services sections (the child rows of the integrations tab). */
const PLATFORM_SERVICE_SECTIONS: readonly string[] = ['defaults', 'email', 'transcription', 'connected-apps'];
/** The People tab's own tabs of the users screen; the rest are rows of their own. */
const PEOPLE_SECTIONS: readonly string[] = ['users', 'invitations', 'groups', 'org-roles'];

/** The licence row's page: the global feature switches (with the header Integrations > Features gave them), or the server licence. */
function LicensePage({ section }: { section?: string }) {
    const { t } = useTranslation();
    if (section !== 'features') return <ServerLicensePanel />;
    return (
        <div className="flex flex-col gap-6">
            <SectionHeader title={t('admin.integ_features')} description={t('integ.features_section_hint', 'Switch platform features on or off for everyone on this server.')} />
            <FeatureKillSwitches />
        </div>
    );
}

/**
 * The panel of each tab; a tab without one renders nothing here (product-website
 * escapes the chrome). A hub's sections are rail rows, so every hub renders
 * without its own section column (D5); the list/detail tools keep theirs.
 */
const PANELS: Record<string, Panel> = {
    agents: { render: (p) => <AgentConfigHub nav={false} hasPermission={p.hasPermission} activeSection={p.agentSection} /> },
    organisation: { render: (p) => <OrganisationHub activeSection={p.adminPath.seg2} />, page: 'scroll' },
    people: { render: (p) => <UserManagement sections={PEOPLE_SECTIONS} activeSection={p.adminPath.seg2} /> },
    'ai-config': { render: (p) => <AIConfigPanel nav={false} activeSection={p.adminPath.seg2} activeProvider={p.adminPath.seg3} /> },
    security: { render: (p) => <SecurityHub nav={false} activeSection={p.adminPath.seg2} userSection={p.adminPath.seg3} /> },
    integrations: { render: (p) => <IntegrationsAdminPanel sections={PLATFORM_SERVICE_SECTIONS} activeSection={p.adminPath.seg2} />, page: WIDE_PAGE },
    access: { render: (p) => <AccessPermissionsPanel tabs activeSection={p.adminPath.seg2} /> },
    monitoring: { render: (p) => <MonitoringPanel nav={false} activeSection={p.adminPath.seg2} /> },
    compliance: { render: (p) => <ComplianceHub activeSection={p.adminPath.seg2} focusCheckId={p.adminPath.seg3} /> },
    subscriptions: { render: (p) => <SubscriptionsPanel activeSection={p.adminPath.seg2} /> },
    support: { render: (p) => <SupportInboxPanel focusThreadId={p.adminPath.seg2 || null} /> },
    licenses: { render: (p) => <LicensePage section={p.adminPath.seg2} />, page: SETTINGS_PAGE },
    modules: { render: () => <ModulesPanel />, page: WIDE_PAGE },
    appearance: { render: (p) => <AppearancePanel section={p.adminPath.seg2 === 'icon-packs' ? 'icon-packs' : 'look'} /> },
    languages: { render: () => <LanguagesPanel /> },
    organisations: { render: () => <UserManagement sections={['organizations']} activeSection="organizations" /> },
    roles: { render: (p) => <UserManagement sections={['roles', 'permissions']} activeSection={p.adminPath.seg2 || 'roles'} /> },
    'mcp-servers': { render: () => <ServerMcpPanel />, page: WIDE_PAGE },
    'nextcloud-instances': { render: (p) => <NextcloudInstancesPanel section={p.adminPath.seg2} orgId={p.adminPath.seg3} /> },
    'website-analytics': { render: () => <AnalyticsPanel /> },
    'release-notes': { render: () => <ReleaseNotesPanel />, page: SETTINGS_PAGE },
};

export default function AdminTabContent(props: AdminTabContentProps) {
    const panel = Object.hasOwn(PANELS, props.activeTab) ? PANELS[props.activeTab] : null;
    if (!panel) return null;
    return <Frame tab={props.activeTab} page={panel.page} title={props.title}>{panel.render(props)}</Frame>;
}
