import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { Bot, Settings } from 'lucide-react';
import AgentDesigner from './AgentDesigner/index';
import SectionNav from '../shared/SectionNav';
import StudioShell from '../shared/StudioShell';
import type { AgentDesignerProps } from './AgentDesigner/index';

interface AgentConfigHubUser {
    isAdmin?: boolean;
    role?: string;
    permissions?: string[] | null;
    allowedAgentTypes?: string[];
}

interface AgentConfigHubProps {
    hasPermission?: AgentDesignerProps['hasPermission'];
    user?: AgentConfigHubUser | null;
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
    const SECTION_TO_TYPE: Record<string, string> = { chat: 'chat', system: 'system' };

    const isSuperAdmin = user?.isAdmin || user?.role === 'admin' || (user?.permissions || []).includes('all');
    const allowedTypes = user?.allowedAgentTypes || [];
    const hasRestrictions = !isSuperAdmin && allowedTypes.length > 0;

    const visibleSections = hasRestrictions
        ? SECTIONS.filter(s => allowedTypes.includes(SECTION_TO_TYPE[s.id]))
        : SECTIONS;

    const VALID_IDS = visibleSections.map(s => s.id);
    const active = VALID_IDS.includes(activeSection) ? activeSection : (VALID_IDS[0] || 'chat');

    return (
        <StudioShell
            responsive
            sidebarTitle={t('admin.tab_agents')}
            sidebar={(
                <SectionNav
                    label={t('admin.tab_agents')}
                    items={visibleSections.map(sec => ({ id: sec.id, icon: sec.icon, label: t(sec.labelKey) }))}
                    activeId={active}
                    onSelect={(id) => { if (onNavigate) onNavigate(`admin/${id}`); }}
                />
            )}
        >
            <div className="relative h-full">
                {active === 'chat' && (
                    <div className="absolute inset-0">
                        <AgentDesigner onBack={null} hasPermission={hasPermission} />
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
