/**
 * Voice-mode shapes, written from the server rather than guessed:
 *   server/routes/ai/voice.js — the three routes, the SSE frames and the
 *   multipart fields POST /ai/voice/turn actually reads off `req.body`.
 *
 * The one thing to keep in mind while reading these: voice is STATELESS on the
 * server. `/ai/voice/session` mints an id and resolves the agent's prompt, but
 * nothing about the conversation is stored — every turn re-sends the whole
 * `history` array. Which means the types below are not a mirror of a server
 * table; they are the only copy of the conversation that exists.
 */

/** GET /ai/voice/availability — the cheap probe the screen gates on. */
export interface VoiceAvailability {
    enabled: boolean;
    /** 'ok' | 'mistral_not_configured' | 'error'. */
    reason: string;
    sttProvider: string;
    ttsProvider: string;
    defaultModel: string;
}

/** POST /ai/voice/session. Defaults for the turns that follow. */
export interface VoiceSession {
    sessionId: string;
    model: string;
    voice: string | null;
    language: string | null;
    /** Already composed with the voice formatting + draft-first rules. */
    systemPrompt: string;
    agentId: string | null;
    agentName: string | null;
    /** Server-declared cap on one recording. 60 at the time of writing. */
    maxTurnSeconds: number;
    /** 15 minutes. Advisory — see useVoiceSession for what we do with it. */
    sessionTimeoutMs: number;
}

/**
 * What the phone is doing right now. One word each, because this is the label
 * under the orb and it has to be readable at arm's length.
 *
 *   offline    — no session; the mic is cold.
 *   connecting — minting a session and opening the mic.
 *   listening  — mic hot, capturing (or waiting for the first syllable).
 *   thinking   — audio sent; transcript, reply and TTS are on the wire.
 *   speaking   — the reply is playing back.
 */
export type VoicePhase = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking';

/** A tool the model ran mid-turn, as `tool_use` / `tool_result` describe it. */
export interface VoiceToolActivity {
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    /** ≤100-char server-built summary. Never the raw result. */
    summary?: string;
}

/** One finished side of a turn, kept only on the device. */
export interface VoiceMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    tools?: VoiceToolActivity[];
    /** Epoch ms, for ordering only — nothing renders a clock. */
    at: number;
}

/**
 * The `history` field, JSON-stringified into the multipart body. Deliberately
 * only role+content: voice.js spreads each entry straight into the Mistral
 * messages array, so anything extra would be sent to the model verbatim.
 */
export interface VoiceHistoryEntry {
    role: 'user' | 'assistant';
    content: string;
}

/** The turn in flight: partials that have not been committed to `messages`. */
export interface LiveTurn {
    /** From the `transcript` event — what the server heard us say. */
    transcript: string;
    /** Accumulated `text` deltas. */
    reply: string;
    tools: VoiceToolActivity[];
}

export const EMPTY_TURN: LiveTurn = { transcript: '', reply: '', tools: [] };

// ─── SSE payloads ────────────────────────────────────────────────────
// One interface per event that carries something we use. Named for the event
// so a future reader can diff them against the send() calls in voice.js.

export interface TranscriptEvent {
    text: string;
    /** BCP-47-ish, often just the two-letter code. May be absent. */
    language?: string | null;
    duration?: number;
    latencyMs?: number;
}

export interface TextDeltaEvent {
    delta: string;
}

export interface ToolUseEvent {
    id: string;
    name: string;
    input?: unknown;
    round?: number;
}

export interface ToolResultEvent {
    id: string;
    name: string;
    ok: boolean;
    summary?: string;
}

export interface TtsEvent {
    audioBase64: string;
    /** Always audio/mpeg from voxtralTts, but do not assume it. */
    mimeType?: string;
    provider?: string;
    latencyMs?: number;
}

/** Why nothing will be spoken. All three are normal, none is an error. */
export type TtsUnavailableReason =
    | 'no_voice_configured'
    | 'tts_failed'
    | 'no_provider_configured'
    | string;

export interface TtsUnavailableEvent {
    reason: TtsUnavailableReason;
}

/**
 * The terminal frame. Two shapes: the full one at the end of a real turn, and
 * a bare `{latencyMs}` on the no-speech short-circuit (voice.js:309).
 */
export interface DoneEvent {
    /** Server-cleaned reply — matches what TTS said, so prefer it over deltas. */
    assistantText?: string;
    transcript?: string;
    toolRounds?: number;
    latencyMs?: number;
}

export interface ErrorEvent {
    message?: string;
}
