import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { Bot, Settings } from 'lucide-react';
import AgentDesigner from './AgentDesigner/index';
import SectionNav from '../shared/SectionNav';
import StudioShell from '../shared/StudioShell';
import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { ServerWideMark, serverWideLast } from '@/components/admin/dashboard/serverWideNav';
import type { AgentDesignerProps } from './AgentDesigner/index';
import { resolveAgentSection } from './agentSections';
import type { AgentSectionUser } from './agentSections';
import { useShellProps } from '@/authedApp/useShellProps';

interface AgentConfigHubProps {
    hasPermission?: AgentDesignerProps['hasPermission'];
    /** `organizations`: every organisation the viewer's lists cover (home plus group organisations, /auth/my-permissions). */
    user?: (AgentSectionUser & { organizations?: readonly unknown[] }) | null;
    activeSection?: string;
    onNavigate?: (path: string) => void;
}

/**
 * AgentConfigHub — Unified agent configuration page
 * Wraps all agent-type panels in a StudioShell with a SectionNav sidebar;
 * the section is the URL (admin/<id>).
 */
const SECTIONS = [
    { id: 'chat', labelKey: 'admin.agents_chat', icon: Bot },
    { id: 'system', labelKey: 'admin.agents_system', icon: Settings },
];

const AgentConfigHub = ({ hasPermission = () => true, user, activeSection = '', onNavigate }: AgentConfigHubProps) => {
    const { t } = useTranslation();
    // Inside the app shell the signed-in person and the navigation come from
    // context; a host outside it (a test, a kit) still hands them as props.
    const { user: viewer, onNavigate: go } = useShellProps({ user, onNavigate });
    const { visible, active } = resolveAgentSection(viewer, activeSection);
    // System agents are server-wide: listed last, under "Whole server", with the server icon.
    const visibleSections = serverWideLast(SECTIONS.filter(sec => visible.includes(sec.id)), sec => adminSectionScope('agents', sec.id) === 'instance');
    // The scope follows the section that is rendered, which the URL may not name.
    useAdminScopeOverride(adminSectionScope('agents', active));
    // The dashboard's organisation: one chosen narrows the list. A list that spans organisations names each
    // agent's: all of them for a platform admin, and the union GET /agents/all gives anyone in several.
    const orgChoice = useAdminOrgChoice();
    const orgId = orgChoice?.orgId ?? null;
    const showOrgNames = orgId === null && (!!orgChoice?.isPlatformAdmin || (viewer?.organizations?.length ?? 0) > 1);

    return (
        <StudioShell
            responsive
            sidebarTitle={t('admin.tab_agents')}
            sidebar={(
                <SectionNav
                    label={t('admin.tab_agents')}
                    items={visibleSections.map(sec => ({
                        id: sec.id,
                        icon: sec.icon,
                        label: t(sec.labelKey),
                        ...(sec.serverWide ? { group: t('admin.scope_instance', 'Whole server'), groupDivider: true, mark: <ServerWideMark /> } : {}),
                    }))}
                    activeId={active}
                    onSelect={(id) => { if (go) go(`admin/${id}`); }}
                />
            )}
        >
            <div className="relative h-full">
                {active === 'chat' && (
                    <div className="absolute inset-0">
                        <AgentDesigner key={`chat:${orgId ?? 'all'}`} onBack={null} hasPermission={hasPermission} orgId={orgId} showOrgNames={showOrgNames} />
                    </div>
                )}
                {active === 'system' && (
                    <div className="absolute inset-0">
                        <AgentDesigner key="system-agents" onBack={null} systemMode={true} hasPermission={hasPermission} />
                    </div>
                )}
            </div>
        </StudioShell>
    );
};

export default AgentConfigHub;
