// The sections of the AI configuration page. The id is the URL segment
// (admin/ai-config/<id>), so a section can be linked to and Back works.

import { Database, Gauge, KeyRound, MessageSquare, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AI_CONFIG_LEGACY_SECTIONS } from '@/components/admin/dashboard/adminPathAliases';

/** The sections; the old ones (chat-models, embeddings, web-search) are AI_CONFIG_LEGACY_SECTIONS. */
export type AiConfigSectionId = 'providers' | 'models' | 'retrieval' | 'direct-chat' | 'limits';

export const AI_CONFIG_SECTIONS: { id: AiConfigSectionId; icon: LucideIcon }[] = [
    { id: 'providers', icon: KeyRound },
    { id: 'models', icon: MessageSquare },
    { id: 'retrieval', icon: Database },
    { id: 'direct-chat', icon: MessagesSquare },
    { id: 'limits', icon: Gauge },
];

/** The sections that list models, so the models are read while one of them is open. */
export const MODEL_SECTIONS: ReadonlySet<string> = new Set(['providers', 'models', 'retrieval']);

/** The section a link or an inner "go to ..." button names: a URL id, or one of the old tab names (dashboard/adminPathAliases). */
export function sectionIdOf(name: string | undefined): AiConfigSectionId | null {
    if (!name) return null;
    const mapped = Object.hasOwn(AI_CONFIG_LEGACY_SECTIONS, name) ? AI_CONFIG_LEGACY_SECTIONS[name] : name;
    return AI_CONFIG_SECTIONS.some(s => s.id === mapped) ? (mapped as AiConfigSectionId) : null;
}

export const aiConfigPath = (section: AiConfigSectionId, providerId?: string) =>
    `admin/ai-config/${section}${providerId ? `/${encodeURIComponent(providerId)}` : ''}`;
