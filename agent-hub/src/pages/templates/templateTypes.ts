import type { RetryModelTiers } from '../../components/chat/MessageItem/MessageActionsRow';
import type { ChatMessage } from '../../hooks/useChatEngine/types';

/** A template parameter as the server stores it: a bare name, or name plus description. */
export type TemplateParam = string | { name?: string; description?: string };

/** One Word template as the templates API returns it. */
export interface TemplateRecord {
    id: string;
    name?: string;
    fileName?: string;
    createdAt?: string;
    parameters: TemplateParam[];
    description?: string;
    instructions?: string;
    knowledgeBaseIds?: string[];
    [key: string]: unknown;
}

/** The chat transcript row the page works with. */
export type TemplateChatMessage = ChatMessage;

// Normalize parameter — supports both string "Name" and { name, description } formats
export function getParam(p: TemplateParam): { name: string; description: string } {
    if (typeof p === 'string') return { name: p, description: '' };
    return { name: p.name || String(p), description: p.description || '' };
}

/** Chat tiers the model picker offers, keyed by tier id. */
export type ModelTiers = RetryModelTiers;
