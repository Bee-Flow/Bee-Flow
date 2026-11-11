// The content of the admin dashboard's current tab, in one of two frames:
//   area  the panel fills the pane and owns its layout (the hubs with their
//         own section sidebar, Monitoring, Compliance, Support, ...);
//   page  a single settings page: the pane scrolls and gives the page the
//         same padding a StudioShell section gets (p-6, md:p-8). The
//         Organisation tab is one: its sections are rows of the rail.
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
import OrganisationHub from '@/components/admin/organisation/OrganisationHub';
import type { AdminCurrentUser } from '@/components/admin/org/userManagement/types';

export interface AdminTabContentProps {
    activeTab: string;
    user: AdminCurrentUser | null;
    hasPermission: (perm: string) => boolean;
    agentSection: string;
    onNavigate: (path: string, opts?: { replace?: boolean }) => void;
    adminPath: { seg1?: string; seg2?: string; seg3?: string };
}

function Frame({ tab, page = false, children }: { tab: string; page?: boolean; children: ReactNode }) {
    return (
        <div className={`absolute inset-0 ${page ? 'overflow-auto' : 'overflow-hidden'}`} data-testid={`admin-tab-${tab}`}>
            {page ? <div className="p-6 md:p-8">{children}</div> : children}
        </div>
    );
}

type Panel = { render: (p: AdminTabContentProps) => ReactNode; page?: boolean };

/** The panel of each tab; a tab without one renders nothing here (product-website escapes the chrome). */
const PANELS: Record<string, Panel> = {
    agents: { render: (p) => <AgentConfigHub user={p.user} hasPermission={p.hasPermission} activeSection={p.agentSection} onNavigate={p.onNavigate} /> },
    organisation: { render: (p) => <OrganisationHub user={p.user} activeSection={p.adminPath.seg2} />, page: true },
    'ai-config': { render: (p) => <AIConfigPanel activeSection={p.adminPath.seg2} activeProvider={p.adminPath.seg3} onNavigate={p.onNavigate} /> },
    security: { render: (p) => <SecurityHub user={p.user} activeSection={p.adminPath.seg2} userSection={p.adminPath.seg3} onNavigate={p.onNavigate} /> },
    integrations: { render: (p) => <IntegrationsAdminPanel activeSection={p.adminPath.seg2} onNavigate={p.onNavigate} /> },
    access: { render: (p) => <AccessPermissionsPanel user={p.user} activeSection={p.adminPath.seg2} onNavigate={p.onNavigate} /> },
    monitoring: { render: (p) => <MonitoringPanel user={p.user} activeSection={p.adminPath.seg2} onNavigate={p.onNavigate} /> },
    compliance: { render: (p) => <ComplianceHub activeSection={p.adminPath.seg2} focusCheckId={p.adminPath.seg3} onNavigate={p.onNavigate} /> },
    subscriptions: { render: (p) => <SubscriptionsPanel activeSection={p.adminPath.seg2} onNavigate={p.onNavigate} /> },
    support: { render: (p) => <SupportInboxPanel focusThreadId={p.adminPath.seg2 || null} /> },
    licenses: { render: () => <ServerLicensePanel />, page: true },
    modules: { render: () => <ModulesPanel />, page: true },
    appearance: { render: () => <AppearancePanel /> },
    languages: { render: () => <LanguagesPanel /> },
    'website-analytics': { render: () => <AnalyticsPanel /> },
    'release-notes': { render: () => <ReleaseNotesPanel />, page: true },
};

export default function AdminTabContent(props: AdminTabContentProps) {
    const panel = Object.hasOwn(PANELS, props.activeTab) ? PANELS[props.activeTab] : null;
    if (!panel) return null;
    return <Frame tab={props.activeTab} page={panel.page}>{panel.render(props)}</Frame>;
}
