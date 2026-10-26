import type { ChatMessage as EngineMessage } from '@/hooks/useChatEngine/types';
import type { TerminalActivity } from './TerminalProgress';
import type { TestChatInfo } from './TestChatNotice';

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
    testChat?: TestChatInfo | null;
    terminalActivity?: TerminalActivity | null;
};

/** A translate function that takes a string fallback, as the message components call it. */
export type MessageT = (key: string, fallback?: string, params?: Record<string, unknown>) => string;

/** One map a turn embedded (the engine types `mapEmbeds` as unknown[]). */
export interface MapEmbed { embedUrl?: string; title?: string; mapsLink?: string }
