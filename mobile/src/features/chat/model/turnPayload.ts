/**
 * The body of one direct-chat turn — POST /ai/chat/direct/stream. Mirrors the
 * payload agent-hub's useChatEngine builds; the field names are the contract.
 */

import type { WireAttachment } from './attachments';
import type { MediaPayload } from './mediaSettings';
import type { ComposerSettings, SendTurnPayload } from './types';

export interface DirectTurnInput {
    text: string;
    attachments: WireAttachment[];
    conversationId: string | null;
    settings: ComposerSettings;
    history: SendTurnPayload['history'];
    /**
     * `history` is a truncation the server must apply — an edit, or a retry
     * of an answer it saved — so it is sent even for a saved conversation.
     */
    historyOverride?: boolean;
    memoryEnabled: boolean;
    activeSkillIds: readonly string[];
    /** The project the chat is filed in: the server reads the project's context with it. */
    projectId?: string | null;
    /** "Retry with a different model": this turn only, the composer's tier unchanged. */
    tierOverride?: string | null;
    /** The media generators' defaults, as the web's scopedStorage keys carry them. */
    media?: MediaPayload;
}

export function directTurnPayload(input: DirectTurnInput): SendTurnPayload {
    const { settings, conversationId } = input;
    return {
        message: input.text,
        conversationId: conversationId ?? undefined,
        modelTier: input.tierOverride || settings.modelTier,
        attachments: input.attachments,
        // History rule, from agent-hub's useChatEngine: send it for a
        // brand-new conversation, or for an edit/retry. For a persisted one
        // otherwise the server reads conversation_messages, which is the
        // durable copy and avoids drift.
        history: conversationId && !input.historyOverride ? undefined : input.history,
        webSearchEnabled: settings.webSearchEnabled,
        memoryWriteEnabled: input.memoryEnabled,
        // streamTurn.js destructures both: access-validated KB retrieval in
        // promptAssembly.js, and skill injection in the tool stack. Without
        // them a knowledge-base document could not be asked about anywhere.
        ...(settings.knowledgeBaseIds.length ? { knowledgeBaseIds: settings.knowledgeBaseIds } : {}),
        ...(input.activeSkillIds.length ? { activeSkillIds: [...input.activeSkillIds] } : {}),
        ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.media ?? {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
}
