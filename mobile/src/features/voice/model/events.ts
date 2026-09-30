/**
 * Typed readers for the voice turn's SSE frames (the send() calls in
 * server/routes/ai/voice.js). Each one answers for any payload — the frame
 * crossed a network boundary — so the turn fold never casts.
 */

import { field, shapeOf } from '@/core/api/contract';

import type {
    DoneEvent,
    TextDeltaEvent,
    ToolResultEvent,
    ToolUseEvent,
    TranscriptEvent,
    TtsEvent,
    TtsUnavailableEvent,
} from './types';

export const readTranscript: (raw: unknown) => TranscriptEvent = shapeOf({
    text: field.str(''),
    language: field.strOrNull,
    duration: field.optNum,
    latencyMs: field.optNum,
});

export const readTextDelta: (raw: unknown) => TextDeltaEvent = shapeOf({
    delta: field.str(''),
});

export const readToolUse: (raw: unknown) => ToolUseEvent = shapeOf({
    id: field.str(''),
    name: field.str(''),
    input: field.raw,
    round: field.optNum,
});

export const readToolResult: (raw: unknown) => ToolResultEvent = shapeOf({
    id: field.str(''),
    name: field.str(''),
    ok: field.bool(false),
    summary: field.optStr,
});

export const readTts: (raw: unknown) => TtsEvent = shapeOf({
    audioBase64: field.str(''),
    mimeType: field.optStr,
    provider: field.optStr,
    latencyMs: field.optNum,
});

export const readTtsUnavailable: (raw: unknown) => TtsUnavailableEvent = shapeOf({
    reason: field.str(''),
});

export const readDone: (raw: unknown) => DoneEvent = shapeOf({
    assistantText: field.optStr,
    transcript: field.optStr,
    toolRounds: field.optNum,
    latencyMs: field.optNum,
});

/**
 * Turn a `tts_unavailable` reason into something an end user can act on.
 *
 * The web client shows admin-facing prose here ("create a voice via POST
 * /v1/audio/voices"); on a phone the person holding it is usually not the
 * person with the API keys, so this says what happened and who can fix it.
 */
export function describeTtsGap(event: TtsUnavailableEvent): string {
    switch (event.reason) {
        case 'no_voice_configured':
            return 'No voice is set up to speak with yet — showing the reply as text. An administrator can add one in Admin → AI Config.';
        case 'tts_failed':
            return 'Speaking the reply failed, so here it is as text.';
        default:
            return 'No text-to-speech is configured on this server, so replies appear as text.';
    }
}
