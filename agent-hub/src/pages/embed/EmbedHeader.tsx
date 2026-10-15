import { Sun, Moon } from 'lucide-react';
import React from 'react';
import { isImageAvatar, resolveAvatarSrc, pickAgentAvatar } from '../../utils/agentAvatar';

/** The agent the embed shows: the embed payload mapped to the shape WelcomeScreen and MessageItem expect. */
export type EmbedAgent = {
    id: string;
    name?: string;
    description?: string;
    avatar?: string;
    starter_prompts: string[];
    copy_enabled: number;
};

interface EmbedHeaderProps {
    agent: EmbedAgent;
    theme: string;
    onToggleTheme: () => void;
}

/** Minimal header: the agent's avatar, name and description, the theme switch and the product mark. */
export default function EmbedHeader({ agent, theme, onToggleTheme }: EmbedHeaderProps) {
    return (
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex-shrink-0">
            <div className="flex items-center gap-3">
                {(() => {
                    const av = pickAgentAvatar(agent);
                    if (isImageAvatar(av)) {
                        return (
                            <div className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center shadow-md">
                                <img src={resolveAvatarSrc(av)} alt="" className="w-full h-full object-cover" />
                            </div>
                        );
                    }
                    if (av) {
                        return (
                            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-xl shadow-md">
                                {av}
                            </div>
                        );
                    }
                    return (
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-sm font-semibold text-white shadow-md">
                            {(agent.name || 'A').charAt(0).toUpperCase()}
                        </div>
                    );
                })()}
                <div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{agent.name}</div>
                    {agent.description && (
                        <div className="text-xs text-[var(--text-muted)] truncate max-w-[200px]">{agent.description}</div>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-3">
                <button
                    onClick={onToggleTheme}
                    className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--bg-tertiary)]"
                    title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                    {theme === 'dark' ? (
                        <Sun className="w-4 h-4 text-[var(--text-muted)]" />
                    ) : (
                        <Moon className="w-4 h-4 text-[var(--text-muted)]" />
                    )}
                </button>
                <div className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] font-medium opacity-50">
                    <span>🐝</span>
                    <span>Bee Flow</span>
                </div>
            </div>
        </div>
    );
}
