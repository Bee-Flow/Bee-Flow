export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export type VoiceStates = Record<'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR', VoiceState>;

/** What POST /ai/voice/session answers with. */
export interface VoiceSessionInfo {
    agentName?: string;
    model?: string;
    voice?: string;
    language?: string;
    systemPrompt?: string;
    agentId?: string;
}

export interface VoiceTool {
    id: string;
    name?: string;
    input?: unknown;
    status?: string;
    round?: number;
    summary?: string;
}

export interface VoiceLatency {
    sttMs: number | null;
    ttftMs: number | null;
    ttsMs: number | null;
    totalMs: number;
}

/** One message of the host chat, as far as the voice turn reads it. */
export interface VoiceHistoryMessage {
    role?: string;
    content?: unknown;
    isHidden?: boolean;
    isStreaming?: boolean;
}

export interface VoiceTurn {
    user: { role: 'user'; content: string; source: 'voice' };
    assistant: { role: 'assistant'; content: string; source: 'voice'; tools: VoiceTool[] } | null;
}

export interface UseVoiceSessionArgs {
    getHistory?: () => VoiceHistoryMessage[];
    onTurnComplete?: (turn: VoiceTurn) => void;
}

export interface ConnectOptions {
    agentId?: string | null;
    voice?: string | null;
    language?: string | null;
}

/** The fields of a turn's SSE events that this hook reads. */
export interface VoiceEventData {
    text?: string;
    latencyMs?: number;
    language?: string;
    delta?: string;
    id?: string;
    name?: string;
    input?: unknown;
    round?: number;
    ok?: boolean;
    summary?: string;
    rounds?: Array<{ ttftMs?: number }>;
    audioBase64?: string;
    mimeType?: string;
    reason?: string;
    message?: string;
    assistantText?: unknown;
}
