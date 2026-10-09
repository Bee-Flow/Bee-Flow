import { ChevronDown, X } from 'lucide-react';
import React from 'react';
import { SECTION_HDR, SECTION_LBL } from './sidebarTokens';
import { isImageAvatar, resolveAvatarSrc } from '../../../utils/agentAvatar';

/* ── "My Agents" group: favourite agents with avatar + unfavourite affordance.
   Moved verbatim out of Sidebar's JSX; state stays in Sidebar, props in. ── */
const MyAgentsSection = ({
    t, favoriteAgents, agentsOpen, toggleAgents,
    selectedAgent, onSelectAgent, onToggleFavorite,
}) => (
                <div>
                    <div className={SECTION_HDR} onClick={toggleAgents}>
                        <span className={SECTION_LBL}>{t('sidebar.my_agents')}</span>
                        <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-200 ${agentsOpen ? '' : '-rotate-90'}`} />
                    </div>

                    {agentsOpen && (
                        <div className="px-1.5 pb-1">
                            {favoriteAgents.map(agent => {
                                const sel = selectedAgent?.id === agent.id;
                                const initials = (agent.name?.[0]?.toUpperCase() || '?');
                                const hasImageAvatar = isImageAvatar(agent.avatar);
                                return (
                                    <button
                                        key={agent.id}
                                        onClick={() => onSelectAgent(agent)}
                                        className={`group/a w-full flex items-center gap-3 px-2 py-1.5 rounded-xl transition-all duration-150 text-left relative ${sel ? 'bg-[var(--accent-primary)]/8' : 'hover:bg-[var(--item-hover-bg)]'}`}
                                        data-testid={`agent-row-${agent.id}`}
                                    >
                                        {sel && <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[var(--accent-primary)]" />}
                                        {/* Avatar */}
                                        <div className={`w-8 h-8 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center text-[13px] font-bold ring-1 transition-all duration-150 ${sel ? 'ring-[var(--accent-primary)]/40 shadow-sm shadow-[var(--accent-primary)]/20' : 'ring-black/8 shadow-sm'} ${!hasImageAvatar ? 'bg-gradient-to-br from-[var(--accent-primary)]/15 to-[var(--accent-primary)]/30 text-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`}>
                                            {hasImageAvatar ? (
                                                <img src={resolveAvatarSrc(agent.avatar)} alt="" loading="lazy" className="w-full h-full object-contain" />
                                            ) : (agent.avatar || initials)}
                                        </div>
                                        <span className={`text-[13px] truncate flex-1 leading-snug ${sel ? 'font-semibold' : ''}`} style={{ color: sel ? 'var(--text-primary)' : 'var(--text-secondary)' }} title={agent.name}>
                                            {agent.name}
                                        </span>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onToggleFavorite?.(agent.id); }}
                                            className="opacity-0 group-hover/a:opacity-100 p-1 text-[var(--text-tertiary)] hover:text-red-500 rounded transition-opacity flex-shrink-0"
                                            title={t('sidebar.remove_from_favorites', 'Remove from favorites')}
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <div className="mx-3 my-0.5 border-t border-[var(--border-subtle)]" />
                </div>
);

export default MyAgentsSection;
