import MyAgentsSection from './sidebar/MyAgentsSection';
import ProjectsSection from './sidebar/ProjectsSection';
import RecentChats from './sidebar/RecentChats';
import { FavoriteAgentsRail, NewProjectRow, ScrolledAwayStrip, SidebarTopBar } from './sidebar/SidebarChrome';
import { conversationActions, sidebarConversations, type ConversationHandlers, type ConversationSource, type SidebarConversation } from './sidebar/sidebarConversations';
import type { ConvRowHandlers } from './sidebar/RecentChats';
// The Studio rail replaces this sidebar on Studio pages. Main-chunk-safe by
// design — see the import discipline note in studioApps.jsx.
import { type StudioNavUser } from '../admin/Studio/studioNav';
import type { Project } from '../../api/queries/projects';
import { withDefaults } from './sidebar/sidebarDefaults';
import type { ProjectRailRoute, SidebarProps } from './Sidebar.types';
import { useSidebarState, type SidebarPanelProps, type SidebarListsProps } from './Sidebar.types2';
import { accountFooter, sidebarRail, sidebarNav, rowRenderers, orgBrandOf } from './Sidebar.helpers';

const Sidebar = (props: SidebarProps) => {
    const p = withDefaults(props);
    const { s, profileRef, scrollRef } = useSidebarState(p);
    // On mobile, completely hide when closed (hamburger in header opens it)
    if (!p.isOpen && p.isMobile) return null;

    const rail = sidebarRail(p, s, profileRef);
    if (rail !== undefined) return rail;

    const content = <SidebarPanel p={p} s={s} profileRef={profileRef} scrollRef={scrollRef} />;
    if (p.isMobile && p.isOpen) {
        return (
            <div className="fixed inset-0 z-50 flex">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => p.onClose?.()} />
                <div className="relative sidebar-slide-in [z-index:1]">{content}</div>
            </div>
        );
    }
    return content;
};

function SidebarPanel({ p, s, profileRef, scrollRef }: SidebarPanelProps) {
    const { t, setSecondaryRef } = s;
    const { isOpen } = p;
    const { coreNav, secondaryNav } = sidebarNav(p, s);
    const renderNavRow = rowRenderers(p, s);
    const favoriteAgents = p.agents.filter(a => p.favorites.includes(a.id));
    return (
        <div
            className={`h-full flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] flex-shrink-0 transition-all duration-300 ${isOpen ? 'w-72' : 'w-16 cursor-pointer'}`}
            data-testid="sidebar"
            data-surface="subtle"
            data-static
            onClick={(e) => {
                if (!isOpen && !(e.target as HTMLElement).closest('button')) {
                    p.toggleSidebar();
                }
            }}
        >
            <SidebarTopBar t={t} isOpen={isOpen} brand={orgBrandOf(p.user, s.access.deploymentMode)} onDirectChat={p.onDirectChat} toggleSidebar={p.toggleSidebar} />

            {/* ── Nav rows ── (pinned: New Chat + Search) */}
            <nav aria-label={t('sidebar.main_navigation', 'Main navigation')} data-testid="main-navigation" className={`px-2 pt-3 flex-shrink-0 flex flex-col gap-1 ${isOpen ? '' : 'items-center'}`}>
                {coreNav.map(renderNavRow)}
            </nav>

            {!isOpen && favoriteAgents.length > 0 && (
                <FavoriteAgentsRail agents={favoriteAgents} selectedAgentId={p.selectedAgent?.id} onSelectAgent={p.onSelectAgent} />
            )}

            {isOpen && s.hiddenSecondaryKeys.size > 0 && (
                <ScrolledAwayStrip items={secondaryNav.filter(item => s.hiddenSecondaryKeys.has(item.key))} />
            )}

            {/* ── Scrollable middle region (Secondary nav + Projects + My Agents + Chats) ── */}
            <div ref={scrollRef} className="flex-1 min-h-0 flex flex-col overflow-y-auto custom-scrollbar">
                {/* Secondary nav — inside the scroll region so it scrolls away like ChatGPT */}
                {isOpen && secondaryNav.length > 0 && (
                    <nav aria-label={t('sidebar.secondary_navigation', 'Secondary navigation')} className="px-2 pt-1 flex-shrink-0 flex flex-col gap-1">
                        {secondaryNav.map(item => (
                            <div key={item.key} ref={setSecondaryRef(item.key)} data-nav-key={item.key}>
                                {renderNavRow(item)}
                            </div>
                        ))}
                    </nav>
                )}
                <SidebarLists p={p} s={s} favoriteAgents={favoriteAgents} />
            </div>

            {accountFooter(p, s, isOpen, profileRef)}

            <style>{`
                @keyframes sidebarMenuIn {
                    from { opacity: 0; transform: translateY(4px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
}

function SidebarLists({ p, s, favoriteAgents }: SidebarListsProps) {
    const { t } = s;
    const { isOpen } = p;
    const showProjects = isOpen && !s.simpleMode && s.access.hasLicenseFeature('projects') && p.user?.featureFlags?.projects !== false;
    const showMyAgents = isOpen && favoriteAgents.length > 0;
    return (
        <>
            {showProjects && p.projects.length > 0 && (
                <ProjectsSection
                    t={t}
                    projects={p.projects}
                    projectsOpen={s.projectsOpen}
                    toggleProjects={s.toggleProjects}
                    activeProject={p.activeProject}
                    onCreateProject={p.onCreateProject}
                    onOpenProject={p.onOpenProject}
                    onNewChatInProject={p.onNewChatInProject}
                    onBrowseProjects={p.onBrowseProjects}
                />
            )}
            {showProjects && p.projects.length === 0 && (
                <NewProjectRow t={t} onCreateProject={p.onCreateProject} />
            )}

            {/* ── My Agents ── (only when there are favorites, with a divider above) */}
            {showMyAgents && (
                <div className="mx-3 my-1.5 border-t border-[var(--border-subtle)]" />
            )}
            {showMyAgents && (
                <MyAgentsSection
                    t={t}
                    favoriteAgents={favoriteAgents}
                    agentsOpen={s.agentsOpen}
                    toggleAgents={s.toggleAgents}
                    selectedAgent={p.selectedAgent}
                    onSelectAgent={p.onSelectAgent}
                    onToggleFavorite={p.onToggleFavorite}
                />
            )}

            <RecentChats
                t={t}
                isOpen={isOpen}
                convs={sidebarConversations(p)}
                hasChatTarget={!!(p.selectedAgent || p.directChatMode)}
                actions={conversationActions(p)}
                agents={p.agents}
                rowHandlers={{
                    conversationLabels: p.conversationLabels, projects: p.projects, activeProjectId: p.activeProject?.id,
                    onRenameConversation: p.onRenameConversation, onPinConversation: p.onPinConversation,
                    onLabelConversation: p.onLabelConversation, onDeleteLabel: p.onDeleteLabel, onEditLabel: p.onEditLabel,
                    onCreateLabel: p.onCreateLabel, onMoveToProject: p.onMoveToProject, onShareToProject: p.onShareToProject,
                }}
            />
        </>
    );
}

export default Sidebar;
