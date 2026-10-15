import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { Bot, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import AgentDesigner from './AgentDesigner/index';
import HubScaffold from '../admin/shared/HubScaffold';

/** The signed-in user, as far as the agent hub reads it. */
interface HubUser {
    isAdmin?: boolean;
    role?: string;
    permissions?: string[];
    allowedAgentTypes?: string[];
}

interface AgentConfigHubProps {
    hasPermission?: (permission: string) => boolean;
    user?: HubUser | null;
    activeSection?: string;
    onNavigate?: (path: string) => void;
}

/**
 * AgentConfigHub — Unified agent configuration page
 * Wraps all agent-type panels behind a compact left sidebar.
 */
const SECTIONS: { id: string; labelKey: string; icon: LucideIcon; color: string }[] = [
    { id: 'chat', labelKey: 'admin.agents_chat', icon: Bot, color: '#6366f1' },
    { id: 'system', labelKey: 'admin.agents_system', icon: Settings, color: '#8b5cf6' },
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
        <HubScaffold
            sections={visibleSections}
            activeId={active}
            onSelect={(id) => { if (onNavigate) onNavigate(`admin/${id}`); }}
            labelFor={(sec) => t(sec.labelKey as string).split(' ')[0]}
            titleFor={(sec) => t(sec.labelKey as string)}
            truncateLabel
        >
            {active === 'chat' && (
                <div style={{ position: 'absolute', inset: 0 }}>
                    <AgentDesigner onBack={null} hasPermission={hasPermission} />
                </div>
            )}
            {active === 'system' && (
                <div style={{ position: 'absolute', inset: 0 }}>
                    <AgentDesigner key="system-agents" onBack={null} systemMode={true} hasPermission={hasPermission} />
                </div>
            )}
        </HubScaffold>
    );
};

export default AgentConfigHub;
