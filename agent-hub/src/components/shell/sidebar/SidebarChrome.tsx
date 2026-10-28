// The fixed pieces of the sidebar around its nav rows: the logo bar, the
// narrow mode's favourite agents and the strip of rows that scrolled away.
// Split out of Sidebar.jsx without a change in behaviour.
import { Plus } from 'lucide-react';
import beeFlowIcon from '@/assets/BeeFlow-logo-Icon-2026.svg';
import beeFlowLogo from '@/assets/bee-flow-logo.svg';
import { isImageAvatar, resolveAvatarSrc } from '@/utils/agentAvatar';
import NotificationCenterJs from '../NotificationCenter';
import type { SidebarAgent } from './sidebarConversations';
import type { NavItem } from './sidebarNav';
import { ACCENT_BAR, ROW, ROW_IDLE } from './sidebarTokens';

type Translate = (key: string, fallback?: string) => string;

const NotificationCenter = NotificationCenterJs;

/**
 * White-label override: in self-hosted deploys the org's uploaded logo
 * replaces the Bee Flow logo (with a "Powered by Bee Flow" line below it).
 */
export interface OrgBrand { logoUrl: string; altText: string }

/** The logo bar: the logo (new chat), the bell and the collapse toggle. */
export function SidebarTopBar({ t, isOpen, brand, onDirectChat, toggleSidebar }: {
    t: Translate;
    isOpen: boolean;
    brand: OrgBrand | null;
    onDirectChat?: (() => void) | null;
    toggleSidebar?: (() => void) | null;
}) {
    return (
        <>
            <div className={`px-3 py-3 flex items-center flex-shrink-0 ${isOpen ? 'justify-between' : 'justify-center border-b border-[var(--border-subtle)]/50'}`}>
                {isOpen ? (
                    <>
                        <button
                            onClick={onDirectChat || undefined}
                            className="flex items-center gap-2.5 rounded-xl transition-transform hover:scale-105"
                            aria-label={t('sidebar.new_chat', 'New Chat')}
                        >
                            {brand
                                ? <div className="w-[4.5rem] h-[4.5rem] rounded-xl overflow-hidden flex items-center justify-center bg-[var(--bg-primary)]">
                                      <img src={brand.logoUrl} alt={brand.altText} className="w-full h-full object-contain" />
                                  </div>
                                : <img src={beeFlowLogo} alt="Bee Flow" className="w-[4.5rem] h-[4.5rem] rounded-xl object-cover" />}
                        </button>
                        <div className="flex items-center gap-1">
                            <NotificationCenter variant="icon" />
                            <button
                                onClick={toggleSidebar || undefined}
                                className="p-1.5 hover:bg-[var(--bg-tertiary)] rounded-lg text-[var(--text-tertiary)] transition-colors"
                                aria-label={t('sidebar.toggle_sidebar', 'Toggle sidebar')}
                                data-testid="toggle-sidebar"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></svg>
                            </button>
                        </div>
                    </>
                ) : (
                    <button
                        onClick={toggleSidebar || undefined}
                        className="hover:bg-[var(--bg-tertiary)] rounded-xl text-[var(--text-primary)] transition-all transform hover:scale-105 flex items-center justify-center w-12 h-12 overflow-hidden p-1"
                    >
                        {brand
                            ? <img src={brand.logoUrl} alt={brand.altText} className="w-full h-full rounded-lg object-contain" />
                            : <img src={beeFlowIcon} alt="Bee Flow" className="w-8 h-8 rounded-lg object-contain" />}
                    </button>
                )}
            </div>

            {/* "Powered by Bee Flow" — placed directly under the org logo in
                self-hosted (white-label) mode. Hidden in collapsed sidebar. */}
            {brand && isOpen && (
                <div className="flex-shrink-0 px-3 -mt-1 mb-1 text-[10px] text-left text-[var(--text-tertiary)]">
                    <a
                        href="https://beeflow.nl"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--text-secondary)] transition-colors"
                    >
                        {t('sidebar.powered_by', 'Powered by Bee Flow')}
                    </a>
                </div>
            )}
        </>
    );
}

/** The narrow (collapsed) sidebar's favourite agents, as avatar buttons. */
export function FavoriteAgentsRail({ agents, selectedAgentId, onSelectAgent }: {
    agents: SidebarAgent[];
    selectedAgentId?: string;
    onSelectAgent: (agent: SidebarAgent) => void;
}) {
    return (
        <div className="flex flex-col items-center gap-2 mt-4 pt-4 border-t border-[var(--border-subtle)]/50">
            {agents.map(agent => (
                <button
                    key={agent.id}
                    onClick={() => onSelectAgent(agent)}
                    className={`relative w-10 h-10 rounded-xl flex items-center justify-center text-lg font-semibold transition-all hover:scale-110 overflow-hidden ${selectedAgentId === agent.id ? 'scale-110' : ''}`}
                    title={agent.name}
                >
                    {selectedAgentId === agent.id && <div className={ACCENT_BAR.replace('left-0', '-left-1.5')} />}
                    {isImageAvatar(agent.avatar) ? (
                        <img src={resolveAvatarSrc(agent.avatar) as string} alt="" loading="lazy" className="w-full h-full object-cover" />
                    ) : (agent.avatar || agent.name?.[0]?.toUpperCase())}
                </button>
            ))}
        </div>
    );
}

/** The secondary-nav rows that scrolled out of view, as a compact icon strip. */
export function ScrolledAwayStrip({ items }: { items: NavItem[] }) {
    return (
        <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap flex-shrink-0 border-b border-[var(--border-subtle)]/50">
            {items.map(item => {
                const Icon = item.icon;
                return (
                    <button
                        key={item.key}
                        onClick={item.onClick || undefined}
                        title={item.label}
                        aria-label={item.label}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors flex-shrink-0 ${item.active ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'}`}
                    >
                        {Icon && <Icon className="w-4 h-4" strokeWidth={item.active ? 2.25 : 1.75} />}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * New Project, when there are no projects yet. Same gate as the Projects
 * group, Simple Mode included: on a phone the projects pages redirect to
 * /app, so the row would lead nowhere.
 */
export function NewProjectRow({ t, onCreateProject }: { t: Translate; onCreateProject?: (() => void) | null }) {
    return (
        <div className="px-2 mt-1">
            <button
                onClick={() => onCreateProject?.()}
                className={`${ROW} ${ROW_IDLE} text-[var(--text-tertiary)]`}
            >
                <Plus className="w-4 h-4" />
                <span className="text-[13px]">{t('sidebar.new_project')}</span>
            </button>
        </div>
    );
}
