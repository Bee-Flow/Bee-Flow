import type { ChatMessage as EngineMessage } from '../../../hooks/useChatEngine/types';

/**
 * One chat message as MessageItem reads it: the chat engine's message plus the
 * members that only travel on its index signature (history rows, multi-agent
 * turns, guardrail and DLP marks).
 */
export type ChatMessage = EngineMessage & {
    timestamp?: string | number;
    model?: string | null;
    respondingAgentName?: string | null;
    respondingAgentAvatar?: string | null;
    isDeleted?: boolean;
    isGuardrailViolation?: boolean;
    willRedact?: boolean;
    deleteIn?: number;
    compactionArtifact?: unknown;
    dlpRedactedCount?: number;
    testChat?: unknown;
    terminalActivity?: unknown;
};

/** One map a turn embedded (the engine types `mapEmbeds` as unknown[]). */
export interface MapEmbed { embedUrl?: string; title?: string; mapsLink?: string }
