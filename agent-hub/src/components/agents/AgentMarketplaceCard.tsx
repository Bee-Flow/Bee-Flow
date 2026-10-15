import React from 'react';
import { getAgentInitials, getAgentColor } from '../../utils/helpers';
import { isImageAvatar, resolveAvatarSrc } from '../../utils/agentAvatar';
import { EyeOff, Heart, Pencil } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';

export interface MarketAgentCardProps {
    agentId: string;
    name: string;
    avatar: string | null | undefined;
    description?: string | null;
    typeLabel: string;
    isFavorite: boolean;
    isOwner: boolean;
    onSelect: () => void;
    onToggleFavorite: (agentId: string) => void;
    onUnpublish?: (agentId: string) => void;
    onEdit?: () => void;
}

/* ── Agent Card ── */
const AgentCard = React.memo(({ agentId, name, avatar, description, typeLabel, isFavorite, isOwner, onSelect, onToggleFavorite, onUnpublish, onEdit }: MarketAgentCardProps) => {
    const { t } = useTranslation();
    return (
    <div
        onClick={onSelect}
        className="group relative p-4 rounded-xl border cursor-pointer transition-shadow duration-150 hover:shadow-md flex flex-col"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)', minHeight: '130px' }}
        data-testid={`agent-card-${agentId}`}
    >
        <div className="absolute top-3 right-3 flex items-center gap-1 z-10">
            {isOwner && onEdit && (
                <button
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    className="p-1.5 rounded-lg transition-opacity opacity-0 group-hover:opacity-100 hover:brightness-90 bg-[var(--bg-tertiary)]"
                    title={t('agent.agent_marketplace_edit_agent', 'Edit agent')}
                    data-testid={`agent-edit-${agentId}`}
                >
                    <Pencil className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                </button>
            )}
            {isOwner && onUnpublish && (
                <button
                    onClick={(e) => { e.stopPropagation(); onUnpublish(agentId); }}
                    className="p-1.5 rounded-lg transition-opacity opacity-0 group-hover:opacity-100 bg-[var(--bg-tertiary)]"
                    title={t('agent.agent_marketplace_unpublish_agent', 'Unpublish agent')}
                >
                    <EyeOff className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                </button>
            )}
            <button
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(agentId); }}
                className={`p-1.5 rounded-lg transition-opacity ${isFavorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                style={{ background: 'var(--bg-tertiary)' }}
            >
                <Heart className={`w-3.5 h-3.5 ${isFavorite ? 'text-red-500 fill-red-500' : ''}`} style={isFavorite ? {} : { color: 'var(--text-muted)' }} />
            </button>
        </div>

        <div className="flex items-start gap-3">
            {(() => {
                const isImg = isImageAvatar(avatar);
                return (
                    <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0 overflow-hidden"
                        style={{
                            background: avatar && !isImg ? 'transparent' : (!avatar ? getAgentColor(name) : 'transparent'),
                            color: avatar ? undefined : 'white',
                            fontSize: avatar && !isImg ? '1.2rem' : undefined,
                        }}
                    >
                        {isImg
                            ? <img src={resolveAvatarSrc(avatar)} alt="" className="w-full h-full object-cover" />
                            : (avatar || getAgentInitials(name))}
                    </div>
                );
            })()}
            <div className="flex-1 min-w-0 pr-16">
                <h3 className="font-semibold text-[13px] truncate text-[var(--text-primary)]" title={name}>{name}</h3>
                <p className="text-xs mt-0.5 line-clamp-2 leading-relaxed text-[var(--text-secondary)]">
                    {description || 'AI agent ready to assist.'}
                </p>
            </div>
        </div>
    </div>
);
});

export default AgentCard;
