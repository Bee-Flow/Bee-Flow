/**
 * Voice endpoints.
 *
 * Paths are the FULL client-visible ones. The AI router is mounted at `/ai`
 * (server/index.js:445) and the voice router at `/voice` under it
 * (server/routes/ai.js:77), so the routes declared as `/availability`,
 * `/session` and `/turn` are reached at `/ai/voice/*`. Several comments in the
 * server say `/api/ai/...`; the mount line is the truth.
 *
 * `/turn` is the awkward one and the reason this file exists at all: it is a
 * multipart POST whose RESPONSE is an SSE stream. Neither half of the app's
 * plumbing covers that — api.client reads a whole JSON body, and api/sse.ts
 * JSON-encodes whatever it is given — so the request is assembled and read
 * here, on expo/fetch, which is the only fetch in React Native that hands back
 * `response.body` as a real ReadableStream. The frame parsing below is
 * deliberately the same shape as sse.ts's, because the wire format is the same
 * one and two divergent parsers is how a `\r\n` proxy bug gets fixed once.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';

import type { VoiceAvailability, VoiceHistoryEntry, VoiceSession } from './types';
import { api, ApiError, authHeaders } from '../../api/client';
import { apiUrl } from '../../api/server';

export const voiceKeys = {
    availability: ['voice', 'availability'] as const,
};

export async function getAvailability(signal?: AbortSignal): Promise<VoiceAvailability | null> {
    return api.get<VoiceAvailability>('/ai/voice/availability', { signal, retry: false });
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
    const session = await api.post<VoiceSession>(
        '/ai/voice/session',
        {
            agentId: input.agentId ?? null,
            voice: input.voice ?? null,
            language: input.language ?? null,
        },
        { signal, retry: false },
    );
    if (!session?.sessionId) throw new ApiError('The server did not start a voice session.');
    return session;
}

/** One `event:` / `data:` frame off the turn stream. */
export interface VoiceFrame {
    event: string;
    data: unknown;
}

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
 * Send one spoken turn and yield the server's frames as they arrive.
 *
 * An async generator for the same reason useChatStream's stream is one: the
 * consumer folds frames into a state machine, and a `for await` loop with the
 * machine in local variables is far easier to follow than a switch inside a
 * callback closure.
 */
export async function* streamVoiceTurn(req: VoiceTurnRequest): AsyncGenerator<VoiceFrame> {
    const { audioUri, mimeType, fileName, history, session, language, signal } = req;

    const audio = await new File(audioUri).bytes();
    if (audio.byteLength === 0) throw new ApiError('The recording was empty.');
    if (audio.byteLength > MAX_AUDIO_BYTES) {
        throw new ApiError('That was too long to send. Try a shorter question.');
    }

    // Text fields first, audio last. multer buffers the whole body before the
    // handler runs so the order does not strictly matter here, but every
    // streaming multipart parser in the chain behaves better when the small
    // fields arrive before the megabyte.
    const { body, contentType } = buildMultipart([
        // `history` is a JSON STRING field, not repeated parts — voice.js:289
        // does JSON.parse(req.body.history) and falls back to [] on a throw,
        // which would silently drop the whole conversation's context.
        field('history', JSON.stringify(history)),
        field('model', session.model),
        field('systemPrompt', session.systemPrompt),
        ...(language ? [field('language', language)] : []),
        ...(session.voice ? [field('voice', session.voice)] : []),
        ...(session.agentId ? [field('agentId', session.agentId)] : []),
        { kind: 'file', name: 'audio', filename: fileName, contentType: mimeType, bytes: audio },
    ]);

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller);

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };

    try {
        bumpIdle();
        const res = await expoFetch(apiUrl('/ai/voice/turn'), {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: authHeaders({
                Accept: 'text/event-stream',
                // Explicit, with our own boundary: expo/fetch only derives a
                // Content-Type when the body is a FormData, and its FormData
                // converter cannot read a React Native `{uri}` part anyway.
                'Content-Type': contentType,
            }),
            body,
        });

        if (!res.ok) {
            // Everything that fails before the stream opens answers with JSON:
            // 403 (no voice_chat capability), 409 (`mistral_not_configured`),
            // 401, 402. `message` is the human half of the 409 body.
            let parsed: unknown = null;
            try {
                parsed = await res.json();
            } catch {
                /* not JSON */
            }
            const payload = parsed as { error?: string; message?: string } | null;
            throw new ApiError(payload?.message ?? payload?.error ?? `HTTP ${res.status}`, {
                status: res.status,
                body: parsed,
            });
        }
        if (!res.body) throw new ApiError('The server sent no stream body.');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bumpIdle();
                buffer += decoder.decode(value, { stream: true });

                let sep = findFrameEnd(buffer);
                while (sep !== -1) {
                    const raw = buffer.slice(0, sep.index);
                    buffer = buffer.slice(sep.index + sep.length);
                    const frame = parseFrame(raw);
                    if (frame) yield frame;
                    sep = findFrameEnd(buffer);
                }
            }
            const tail = parseFrame(buffer);
            if (tail) yield tail;
        } finally {
            // Cancelling the reader is what closes the socket, which is what
            // makes the server's tool loop stop. A user who hangs up mid-answer
            // should not keep paying for it.
            await reader.cancel().catch(() => {});
        }
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        signal?.removeEventListener('abort', abortFromCaller);
        controller.abort();
    }
}

// ─── multipart ───────────────────────────────────────────────────────

type MultipartPart =
    | { kind: 'field'; name: string; value: string }
    | {
          kind: 'file';
          name: string;
          filename: string;
          contentType: string;
          bytes: Uint8Array;
      };

function field(name: string, value: string): MultipartPart {
    return { kind: 'field', name, value };
}

/**
 * Build the body by hand.
 *
 * Not paranoia: expo/fetch's FormData converter documents that a React Native
 * `{uri, name, type}` part is NOT supported (expo/src/winter/fetch/
 * convertFormData.ts), and the alternatives it does support leave the part's
 * Content-Type up to whatever the runtime infers from the extension. multer is
 * configured to reject any part whose mimetype does not start with `audio/`
 * (voice.js:67), so an inferred `application/octet-stream` fails the turn with
 * an error the user cannot act on. Assembling the bytes here makes the header
 * ours. A turn is at most ~60s of 64 kbit/s mono — half a megabyte — so
 * holding it in memory costs nothing.
 */
function buildMultipart(parts: MultipartPart[]): {
    // `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`. Since TypeScript 5.7
    // the typed arrays are generic over their backing buffer, and the bare form
    // widens to `Uint8Array<ArrayBufferLike>` — which `BodyInit` does not accept,
    // because a SharedArrayBuffer-backed view cannot be sent. The array built
    // below is `new Uint8Array(total)` and so is genuinely ArrayBuffer-backed;
    // this annotation keeps that fact instead of throwing it away at the
    // boundary and casting it back at the fetch call.
    body: Uint8Array<ArrayBuffer>;
    contentType: string;
} {
    const boundary = `----BeeFlowVoice${Math.random().toString(36).slice(2, 18)}`;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const part of parts) {
        if (part.kind === 'field') {
            chunks.push(
                encoder.encode(
                    `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`,
                ),
                encoder.encode(part.value),
                encoder.encode('\r\n'),
            );
        } else {
            chunks.push(
                encoder.encode(
                    `--${boundary}\r\n` +
                        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                        `Content-Type: ${part.contentType}\r\n\r\n`,
                ),
                part.bytes,
                encoder.encode('\r\n'),
            );
        }
    }
    chunks.push(encoder.encode(`--${boundary}--\r\n`));

    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── frame parsing (mirrors src/api/sse.ts) ──────────────────────────

function findFrameEnd(buffer: string): { index: number; length: number } | -1 {
    const lf = buffer.indexOf('\n\n');
    const crlf = buffer.indexOf('\r\n\r\n');
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
}

/** Returns null for a comment-only frame or the empty tail after the last one. */
function parseFrame(raw: string): VoiceFrame | null {
    if (!raw.trim()) return null;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const name = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (name === 'event') event = value;
        else if (name === 'data') dataLines.push(value);
    }

    if (!dataLines.length) return null;
    const payload = dataLines.join('\n');
    let data: unknown = payload;
    try {
        data = JSON.parse(payload);
    } catch {
        /* the server always sends JSON; a proxy error page might not */
    }
    return { event, data };
}
