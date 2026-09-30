/**
 * One voice turn's frames, folded into what the session acts on afterwards.
 *
 * Pure, so "what does the phone do with this frame" can be answered without a
 * microphone. The live parts (transcript, reply, tools) are shown while the
 * turn streams; the rest decides what happens when it ends — speak, note that
 * nothing was heard, report a failure, or just listen again.
 */

import {
    describeTtsGap,
    readDone,
    readTextDelta,
    readToolResult,
    readToolUse,
    readTranscript,
    readTts,
    readTtsUnavailable,
} from './events';
import { EMPTY_TURN, type LiveTurn, type TtsEvent, type VoiceHistoryEntry, type VoiceMessage } from './types';

export interface TurnFold {
    live: LiveTurn;
    /** The live parts changed since the last publish. */
    dirty: boolean;
    heardNothing: boolean;
    tts: TtsEvent | null;
    ttsNotice: string | null;
    /** The server's cleaned reply, from `done`. */
    finalText: string;
    /** An `error` frame's message. */
    failed: string | null;
    /** A language to pin for the rest of the call (see useVoiceSession). */
    language: string | null;
}

export function startFold(): TurnFold {
    return {
        live: { ...EMPTY_TURN },
        dirty: false,
        heardNothing: false,
        tts: null,
        ttsNotice: null,
        finalText: '',
        failed: null,
        language: null,
    };
}

type FrameStep = (fold: TurnFold, data: unknown) => void;

/**
 * Voxtral guesses the language per clip and gets short ones wrong, so only a
 * real sentence (8+ characters) may name the language that gets pinned.
 */
const transcript: FrameStep = (fold, data) => {
    const payload = readTranscript(data);
    fold.live.transcript = payload.text;
    fold.dirty = true;
    if (payload.language && payload.text.length >= 8) {
        fold.language = payload.language.toLowerCase().slice(0, 2);
    }
};

const textDelta: FrameStep = (fold, data) => {
    const { delta } = readTextDelta(data);
    if (!delta) return;
    fold.live.reply += delta;
    fold.dirty = true;
};

const toolUse: FrameStep = (fold, data) => {
    const payload = readToolUse(data);
    fold.live.tools = [...fold.live.tools, { id: payload.id || payload.name, name: payload.name, status: 'running' }];
    fold.dirty = true;
};

const toolResult: FrameStep = (fold, data) => {
    const payload = readToolResult(data);
    fold.live.tools = fold.live.tools.map((t) =>
        t.id === payload.id || t.name === payload.name
            ? { ...t, status: payload.ok ? 'done' : 'error', summary: payload.summary ?? t.summary }
            : t,
    );
    fold.dirty = true;
};

/** Prefer the server's cleaned text: it is what TTS actually said, with any leaked JSON stripped. */
const done: FrameStep = (fold, data) => {
    const payload = readDone(data);
    fold.finalText = payload.assistantText?.trim() ? payload.assistantText : fold.live.reply;
    if (payload.transcript) fold.live.transcript = payload.transcript;
};

const STEPS: Readonly<Record<string, FrameStep | null>> = {
    transcript,
    no_speech: (fold) => {
        fold.heardNothing = true;
    },
    text: textDelta,
    // The model's scratchpad: nowhere to read it in a hands-free UI, and it is
    // not what gets spoken.
    thinking: null,
    tool_use: toolUse,
    tool_result: toolResult,
    // Per-round latency metrics — meaningless to someone holding a phone.
    llm_done: null,
    tts: (fold, data) => {
        fold.tts = readTts(data);
    },
    tts_unavailable: (fold, data) => {
        fold.ttsNotice = describeTtsGap(readTtsUnavailable(data));
    },
    done,
    error: (fold, data) => {
        const message = (data as { message?: unknown } | null)?.message;
        fold.failed = typeof message === 'string' ? message : 'Voice turn failed';
    },
};

/** Fold one frame. Returns false for an event this client does not know. */
export function applyVoiceFrame(fold: TurnFold, event: string, data: unknown): boolean {
    if (!Object.prototype.hasOwnProperty.call(STEPS, event)) return false;
    STEPS[event]?.(fold, data);
    return true;
}

/**
 * What a finished turn commits: the transcript and the reply as messages, and
 * the same two as history for the next turn. The history is the ONLY copy of
 * the conversation (the server is stateless), so a reply with no text adds
 * nothing to it even when it ran tools.
 */
export function commitTurn(
    fold: TurnFold,
    at: number,
    newId: () => string,
): { messages: VoiceMessage[]; history: VoiceHistoryEntry[] } {
    const spoken = fold.live.transcript.trim();
    const reply = (fold.finalText || fold.live.reply).trim();
    const tools = [...fold.live.tools];
    const messages: VoiceMessage[] = [];
    const history: VoiceHistoryEntry[] = [];
    if (spoken) {
        messages.push({ id: newId(), role: 'user', content: spoken, at });
        history.push({ role: 'user', content: spoken });
    }
    if (reply || tools.length) {
        messages.push({
            id: newId(),
            role: 'assistant',
            content: reply,
            tools: tools.length ? tools : undefined,
            at: at + 1,
        });
        if (reply) history.push({ role: 'assistant', content: reply });
    }
    return { messages, history };
}
