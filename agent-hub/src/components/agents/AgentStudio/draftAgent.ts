import type { TranslateFn } from '@/hooks/useTranslation';
import { DEFAULT_AGENT_EMOJI } from '@/utils/agentAvatar';

/**
 * A local-only draft agent: it is not persisted until the user hits Save in
 * the editor. Until then it has no id, doesn't appear in the list, and edits
 * stay in memory.
 */
export function newDraftAgent(t: TranslateFn) {
    return {
        id: null,
        name: t('agent_studio.untitled'),
        description: '',
        system_prompt: '',
        embed_enabled: 0,
        is_published: 0,
        shared_groups: [],
        config: {
            avatar: DEFAULT_AGENT_EMOJI,
            enabledIntegrations: [],
            knowledge_base_ids: [],
            attachedSkillIds: [],
            memoryEnabled: false,
        },
    };
}
