/**
 * Voice endpoints.
 *
 * Paths are the FULL client-visible ones. The AI router is mounted at `/ai`
 * (server/index.js:445) and the voice router at `/voice` under it
 * (server/routes/ai.js:77), so the routes declared as `/availability`,
 * `/session` and `/turn` are reached at `/ai/voice/*`. Several comments in the
 * server say `/api/ai/...`; the mount line is the truth.
 *
 * `/turn` is the awkward one: a multipart POST whose RESPONSE is an SSE
 * stream. The body is assembled in multipart.ts and sent through the app's
 * one SSE transport (core/api/sse.ts) as a raw body, so the frames are cut by
 * the same framer as every other stream.
 */

import { File } from 'expo-file-system';

import { api, ApiError } from '@/core/api/client';
import { streamSse, type SseFrame } from '@/core/api/sse';

import { buildMultipart, field, type MultipartPart } from './multipart';
import { readAvailability, readSession } from './readers';
import type { VoiceAvailability, VoiceHistoryEntry, VoiceSession } from '../model/types';

export async function getAvailability(signal?: AbortSignal): Promise<VoiceAvailability | null> {
    return readAvailability(await api.get<unknown>('/ai/voice/availability', { signal, retry: false }));
}

export interface CreateSessionInput {
    agentId?: string | null;
    voice?: string | null;
    language?: string | null;
}

/**
 * Mint a session. Cheap and side-effect-free — it resolves the agent's system
 * prompt and model so every turn does not have to, and nothing is stored.
 */
export async function createSession(
    input: CreateSessionInput = {},
    signal?: AbortSignal,
): Promise<VoiceSession> {
    const session = readSession(
        await api.post<unknown>(
            '/ai/voice/session',
            {
                agentId: input.agentId ?? null,
                voice: input.voice ?? null,
                language: input.language ?? null,
            },
            { signal, retry: false },
        ),
    );
    if (!session?.sessionId) throw new ApiError('The server did not start a voice session.');
    return session;
}

/** One `event:` / `data:` frame off the turn stream. */
export type VoiceFrame = SseFrame;

export interface VoiceTurnRequest {
    /** Local file uri of the finished recording. */
    audioUri: string;
    /** Must start with `audio/` — multer's fileFilter rejects anything else. */
    mimeType: string;
    fileName: string;
    /** Everything said so far. The server has no copy; see types.ts. */
    history: VoiceHistoryEntry[];
    session: VoiceSession;
    /** STT hint. Overrides the session's language when the app has one. */
    language?: string | null;
    signal?: AbortSignal;
}

/** multer's own limit (voice.js:66). Refuse locally rather than upload 25 MB. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * How long to wait with no bytes at all before declaring the turn dead.
 *
 * Much longer than the chat stream's 60s default would suggest, because this
 * route sends NO heartbeat: after `llm_done` the server synthesises the whole
 * reply before the `tts` frame, and that gap is legitimately silent. A timeout
 * shorter than the slowest synthesis would abort turns that were about to
 * succeed.
 */
const IDLE_TIMEOUT_MS = 90_000;

/**
 * Text fields first, audio last. multer buffers the whole body before the
 * handler runs so the order does not strictly matter here, but every
 * streaming multipart parser in the chain behaves better when the small
 * fields arrive before the megabyte.
 */
function turnParts(req: VoiceTurnRequest, audio: Uint8Array): MultipartPart[] {
    const { session, language } = req;
    return [
        // `history` is a JSON STRING field, not repeated parts — voice.js:289
        // does JSON.parse(req.body.history) and falls back to [] on a throw,
        // which would silently drop the whole conversation's context.
        field('history', JSON.stringify(req.history)),
        field('model', session.model),
        field('systemPrompt', session.systemPrompt),
        ...(language ? [field('language', language)] : []),
        ...(session.voice ? [field('voice', session.voice)] : []),
        ...(session.agentId ? [field('agentId', session.agentId)] : []),
        { kind: 'file', name: 'audio', filename: req.fileName, contentType: req.mimeType, bytes: audio },
    ];
}

/**
 * Send one spoken turn and yield the server's frames as they arrive.
 *
 * Everything that fails before the stream opens answers with JSON — 403 (no
 * voice_chat capability), 409 (`mistral_not_configured`, whose `message` is
 * the human half), 401, 402 — and the transport turns it into the same error
 * (and the same 401 lock screen) as any other request.
 */
export async function* streamVoiceTurn(req: VoiceTurnRequest): AsyncGenerator<VoiceFrame> {
    const audio = await new File(req.audioUri).bytes();
    if (audio.byteLength === 0) throw new ApiError('The recording was empty.');
    if (audio.byteLength > MAX_AUDIO_BYTES) {
        throw new ApiError('That was too long to send. Try a shorter question.');
    }

    // Explicit Content-Type, with our own boundary: expo/fetch only derives
    // one when the body is a FormData, and its FormData converter cannot read
    // a React Native `{uri}` part anyway.
    const rawBody = buildMultipart(turnParts(req, audio));
    // Cancelling the stream (hanging up) closes the socket, which is what
    // makes the server's tool loop stop: nobody keeps paying for an answer.
    yield* streamSse('/ai/voice/turn', { rawBody, signal: req.signal, idleTimeoutMs: IDLE_TIMEOUT_MS });
}
