import { MessageSquare, Calendar } from 'lucide-react';
import { highlightSnippet } from './searchHighlight';
import { isImageAvatar, resolveAvatarSrc } from '../../utils/agentAvatar';
import { formatRelativeDate } from '../../utils/dateFormatters';
import type { ResultRowProps } from './SearchOverlay.types';

const formatDate = (dateStr: string | number | Date | null) => formatRelativeDate(dateStr, {
    fallbackOptions: { year: 'numeric', month: 'short', day: 'numeric' },
});

export const ResultRow = ({ result, query, idx, selected, onSelect, onHover }: ResultRowProps) => {
    const isDirect = result.kind === 'direct';
    const agentName = result.agent_name || (isDirect ? 'Direct Chat' : 'Agent');
    const avatar = result.agent_avatar;
    const hasImageAvatar = isImageAvatar(avatar);

    return (
        <button
            id={`search-result-${result.id}`}
            data-idx={idx}
            data-testid={`search-result-${result.id}`}
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(result)}
            onMouseEnter={onHover}
            className={`w-full text-left p-3 rounded-lg transition-colors flex gap-3 ${
                selected
                    ? 'bg-[var(--bg-secondary)]'
                    : 'hover:bg-[var(--bg-secondary)]/60'
            }`}
        >
            {/* Icon / Avatar */}
            <div className="flex-shrink-0 mt-0.5">
                {isDirect ? (
                    <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-secondary)]">
                        <MessageSquare className="w-4 h-4" />
                    </div>
                ) : hasImageAvatar ? (
                    <div className="w-8 h-8 rounded-lg overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                        <img src={resolveAvatarSrc(avatar)} alt="" className="w-full h-full object-contain" />
                    </div>
                ) : avatar ? (
                    <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center text-base leading-none">
                        {avatar}
                    </div>
                ) : (
                    <div className="w-8 h-8 rounded-lg bg-[var(--accent-primary)]/10 border border-[var(--border-subtle)] flex items-center justify-center text-xs font-semibold text-[var(--accent-primary)]">
                        {agentName[0]?.toUpperCase() || '?'}
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                        {result.title || 'Untitled Conversation'}
                    </span>
                    <span className={`flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        isDirect
                            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border border-[var(--border-subtle)]'
                            : 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] border border-[var(--accent-primary)]/20'
                    }`}>
                        {isDirect ? (result.model_tier ? `Direct · ${result.model_tier}` : 'Direct') : agentName}
                    </span>
                </div>
                <div
                    className="text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: highlightSnippet(result.snippet || '', query) }}
                />
                <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--text-muted)]">
                    <Calendar className="w-2.5 h-2.5" />
                    {formatDate(result.updated_at)}
                </div>
            </div>
        </button>
    );
};
