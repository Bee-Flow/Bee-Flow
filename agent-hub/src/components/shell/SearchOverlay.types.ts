import type React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SearchMessage {
    content?: string;
    role?: string;
}

export interface SearchConversation {
    id: string;
    kind?: string;
    /** The agent of an agent conversation; a direct chat has none. */
    agent_id: string;
    title?: string;
    messages_json?: string | SearchMessage[];
    agent_name?: string;
    agent_avatar?: string;
    model_tier?: string;
    updated_at: string;
}

export interface SearchResult extends SearchConversation {
    snippet: string;
    matchRole?: string;
    relevanceScore: number;
}

export interface SearchOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectResult: (result: SearchResult) => void;
    agents?: { id: string; name?: string; description?: string; emoji?: string }[];
}

export interface PillGroupProps {
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
    options: { value: string; label: string; }[];
    ariaLabel: string;
}

export interface FilterPillProps {
    icon: LucideIcon;
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
    options: { value: string; label?: string }[];
    disabled?: boolean;
}

export interface ResultRowProps {
    result: SearchResult;
    onSelect: (result: SearchResult) => void;
    query: string;
    idx: number;
    selected: boolean;
    onHover: () => void;
}

export interface EmptyStateProps {
    title: string;
    hint: string;
    action?: { label: string; onClick: () => void; } | null;
}
