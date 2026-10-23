import type { SidebarProps, ResolvedSidebarProps } from '../Sidebar.types';

// The props that have a default; every other prop is passed through as given.
const DEFAULTS = {
    isMobile: false,
    favorites: [], agents: [],
    studioRoute: null,
    // { projectId, tab, onSelectTab, onBack, onOpenProject, onOpenSearch,
    // notebooksEnabled } on one project's pages, otherwise null.
    projectRail: null,
    hasPermission: null,
    directConversations: [],
    projects: [],
    conversationLabels: [],
    chatHistoryMode: 'per-agent',
    allAgentConversations: [],
    showSettings: false,
    showAgentDesigner: false,
    showSkillsPanel: false,
    showMarketplace: false,
};

export function withDefaults(props: SidebarProps) {
    const out = { ...props };
    const slots = out as Record<string, unknown>;
    for (const [k, v] of Object.entries(DEFAULTS)) if (slots[k] === undefined) slots[k] = v;
    return out as ResolvedSidebarProps;
}
