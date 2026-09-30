/**
 * The body of one agent turn — POST /agents/:id/chat/stream, less the
 * `agentId` and `stream` the hook adds. Mirrors the agent branch of
 * agent-hub's useChatEngine; the field names are the contract.
 */

import type { ComposerSettings } from '@/features/chat';

import type { AgentTurnPayload } from './types';

export interface AgentTurnInput {
    text: string;
    attachments: AgentTurnPayload['attachments'];
    conversationId: string | null;
    settings: ComposerSettings;
    history: NonNullable<AgentTurnPayload['history']>;
}

export function agentTurnPayload(input: AgentTurnInput): Omit<AgentTurnPayload, 'agentId' | 'stream'> {
    const { settings, conversationId } = input;
    return {
        message: input.text,
        conversationId: conversationId ?? undefined,
        attachments: input.attachments,
        memoryWriteEnabled: true,
        webSearchEnabled: settings.webSearchEnabled,
        // History only for a brand-new conversation: for a persisted one the
        // server reads conversation_messages, the durable copy.
        ...(conversationId ? {} : { history: input.history }),
        // Omitted unless overridden — the agent's own configured model is the
        // point of an agent.
        ...(settings.modelTier !== 'auto' ? { modelTier: settings.modelTier } : {}),
        ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
}
