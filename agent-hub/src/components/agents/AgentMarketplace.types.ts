import type { AgentListRow } from './AgentStudio/agentCardFacts';
import type { AppUserLike } from '../projects/workspace/types';
import type React from 'react';

export interface MarketAgent extends AgentListRow {
    id: string;
    name: string;
    _type?: string;
    owner_id?: string;
    tools?: string[];
    updated_at?: string | null;
}

export interface MarketCategory { id: string; name: string; icon?: string }

export interface AgentCardProps {
    agentId: string;
    name: string;
    avatar: string | null;
    description?: string;
    typeLabel: string;
    isFavorite: boolean;
    isOwner: boolean;
    onSelect: () => void;
    onToggleFavorite: (id: string) => void;
    onUnpublish?: (id: string) => void;
    onEdit?: () => void;
}

export interface AgentMarketplaceProps {
    agents?: MarketAgent[];
    favorites?: string[];
    categories?: MarketCategory[];
    onToggleFavorite: (id: string) => void;
    onSelect: (agent: MarketAgent) => void;
    onUnpublish?: (id: string) => void;
    onEditAgent?: (agent?: MarketAgent | null) => void;
    user?: AppUserLike | null;
    onClose: React.MouseEventHandler<HTMLButtonElement>;
}
