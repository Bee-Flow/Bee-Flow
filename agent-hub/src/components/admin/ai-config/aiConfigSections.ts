// The sections of the AI configuration page. The id is the URL segment
// (admin/ai-config/<id>), so a section can be linked to and Back works.

import { Boxes, Gauge, Globe, KeyRound, MessageSquare, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type AiConfigSectionId = 'providers' | 'chat-models' | 'embeddings' | 'direct-chat' | 'web-search' | 'limits';

export const AI_CONFIG_SECTIONS: { id: AiConfigSectionId; icon: LucideIcon }[] = [
    { id: 'providers', icon: KeyRound },
    { id: 'chat-models', icon: MessageSquare },
    { id: 'embeddings', icon: Boxes },
    { id: 'direct-chat', icon: MessagesSquare },
    { id: 'web-search', icon: Globe },
    { id: 'limits', icon: Gauge },
];

/** The sections that list models, so the models are read while one of them is open. */
export const MODEL_SECTIONS: ReadonlySet<string> = new Set(['providers', 'chat-models', 'web-search', 'embeddings']);

const LEGACY_TAB_IDS: Record<string, AiConfigSectionId> = {
    chatModels: 'chat-models',
    directChat: 'direct-chat',
    webSearchInference: 'web-search',
};

/** The section a link or an inner "go to ..." button names: a URL id, or one of the old tab names. */
export function sectionIdOf(name: string | undefined): AiConfigSectionId | null {
    if (!name) return null;
    const mapped = LEGACY_TAB_IDS[name] ?? name;
    return AI_CONFIG_SECTIONS.some(s => s.id === mapped) ? (mapped as AiConfigSectionId) : null;
}

export const aiConfigPath = (section: AiConfigSectionId, providerId?: string) =>
    `admin/ai-config/${section}${providerId ? `/${encodeURIComponent(providerId)}` : ''}`;
