// The wire shapes of /api/projects/:id/chats (routes/projects/chats.js),
// kept apart from the hooks in projectChats.ts, which re-exports them.

/** When the AI answers: never, when asked, on its own when it can help, or after every message. */
export type TeamChatAiMode = 'off' | 'mention' | 'auto' | 'always';
/** `system` is a notice such as "the AI now joins on its own": it has a code, no text. */
export type TeamChatAuthorKind = 'user' | 'assistant' | 'system';
/** Why the AI spoke: asked outright, or on its own (after a quiet moment, or an unanswered question). */
export type TeamChatAiTrigger = 'ask' | 'mention' | 'always' | 'auto_quiet' | 'auto_unanswered';
export type TeamChatNotice = 'ai_auto_on';

export interface TeamChatLastMessage {
    authorKind: TeamChatAuthorKind;
    authorUserId?: string | null;
    excerpt: string;
    notice?: TeamChatNotice | string | null;
}

export interface TeamChat {
    id: string;
    title: string;
    aiMode: TeamChatAiMode;
    /**
     * How the AI acts in this chat now: `aiMode`, unless the organisation has
     * since withdrawn that mode, in which case the chat acts as `mention`.
     * Older servers leave it out.
     */
    effectiveAiMode?: TeamChatAiMode;
    agentId: string | null;
    createdBy: string;
    archived: boolean;
    messageCount: number;
    lastMessageAt: string | null;
    lastMessage: TeamChatLastMessage | null;
    /** Messages the caller has not read yet (a count; older servers sent a flag). */
    unread: number | boolean;
    /** The title could not be decrypted; the server sent no text for it. */
    unreadable?: boolean;
    /** Until when "not helpful" feedback paused the AI joining on its own. */
    autoPausedUntil?: string | null;
    createdAt: string;
    updatedAt: string;
}

/** What the organisation lets a chat choose. */
export interface TeamChatAiPolicy { autoAllowed: boolean; alwaysAllowed: boolean }

export interface TeamChatMessage {
    id: string;
    seq: number;
    authorKind: TeamChatAuthorKind;
    authorUserId: string | null;
    agentId: string | null;
    content: string;
    mentions: string[];
    replyTo: string | null;
    createdAt: string;
    editedAt: string | null;
    deleted: boolean;
    clientMsgId?: string | null;
    /** The content could not be decrypted; the server sent no text for it. */
    unreadable?: boolean;
    /** An answer: why the AI spoke. */
    aiTrigger?: TeamChatAiTrigger | null;
    /** An automatic answer: the reason code it joined for. */
    aiReason?: string | null;
    /** A system message: which notice. */
    notice?: TeamChatNotice | string | null;
    /** An automatic answer: the caller's own feedback on it. */
    myFeedback?: 'helpful' | 'not_helpful' | null;
}

/** What the author sends; `clientMsgId` makes a resend idempotent. */
export interface SendTeamChatMessage {
    clientMsgId: string;
    content: string;
    mentions: string[];
    replyTo: string | null;
    askAi: boolean;
}

/** A message typed here that the server has not confirmed (yet). */
export interface PendingTeamChatMessage extends SendTeamChatMessage {
    authorUserId: string | null;
    createdAt: string;
    status: 'sending' | 'failed';
    error?: string;
    errorCode?: string | null;
}

export interface TeamChatMessages {
    /** Confirmed messages, ascending by seq, no duplicates. */
    messages: TeamChatMessage[];
    pending: PendingTeamChatMessage[];
    /** Older messages exist that are not loaded. */
    hasOlder: boolean;
}

export type TeamChatAiStatus = 'queued' | 'skipped' | 'busy';
export interface TeamChatAiResult { status: TeamChatAiStatus; reason?: string }

export interface CreateTeamChat { title?: string; aiMode: TeamChatAiMode; agentId?: string | null; message?: string }

/** An AI answer the AI gave on its own, rather than one somebody asked for. */
export function isAutomaticAnswer(m: Pick<TeamChatMessage, 'authorKind' | 'aiTrigger'>): boolean {
    return m.authorKind === 'assistant' && (m.aiTrigger === 'auto_quiet' || m.aiTrigger === 'auto_unanswered');
}
