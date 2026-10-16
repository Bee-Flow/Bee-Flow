import { useCallback, useMemo } from 'react';
import type { TemplateRecord } from './templateTypes';

/**
 * The options of the template chat: a direct chat that routes through the
 * dedicated template endpoint once a template is open, and sends the template
 * id and the picked meeting notes along with every turn. (The page itself
 * calls useChatEngine, so the reviewed list of chat-engine hosts stays true.)
 */
export function useTemplateChatOptions(selectedChatTier: string, fillTemplate: TemplateRecord | null, selectedNoteIds: string[]) {
    return {
        selectedAgent: null,
        currentConversation: null,
        onConversationCreated: useCallback(() => {}, []),
        getNotebookPayload: useCallback(() => ({}), []),
        onNotebookUpdate: useCallback(() => {}, []),
        directMode: useMemo(() => ({
            enabled: true,
            modelTier: selectedChatTier,
            customEndpoint: fillTemplate ? '/ai/chat/template/stream' : undefined,
            getExtraPayload: () => fillTemplate ? {
                templateId: fillTemplate.id,
                meetingNoteIds: selectedNoteIds,
            } : {},
        }), [selectedChatTier, fillTemplate?.id, selectedNoteIds]),
        onDirectConversationCreated: useCallback(() => {}, []),
    };
}
