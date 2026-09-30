/**
 * The AI builder (server/routes/ai/appStudioBuilder/, mounted at
 * /api/studio-apps/builder): the persisted session snapshot, and one
 * conversational build turn streamed over SSE.
 *
 * The stream goes through core/api/sse (the one framer; the SSO token and the
 * 401 lock screen ride along). Refusals before the stream opens — 400
 * `invalid_request`/`invalid_image`, 402 `subscription_limit`, 404 — throw an
 * ApiError with that status; a failure after it opened arrives as an `error`
 * event with a taxonomy `code`.
 */

import { api } from '@/core/api/client';
import { streamSse } from '@/core/api/sse';

import { expectedRefusal, STUDIO_BASE } from './paths';
import { readBuilderEvent, readBuilderSession } from './readersBuilder';
import type { BuilderEvent, BuilderSession, BuilderTurnInput } from '../model/builderTypes';

const BUILDER_BASE = `${STUDIO_BASE}/builder`;

/**
 * Silence longer than this kills the turn. The server heartbeats every 10 s
 * (a comment AND a `ping` event), so this only fires on a dead connection.
 */
const BUILDER_IDLE_TIMEOUT_MS = 90_000;

/** The snapshot to rehydrate the chat from; null when the app has none yet (404). */
export async function getBuilderSession(appId: string, signal?: AbortSignal): Promise<BuilderSession | null> {
    try {
        return readBuilderSession(
            await api.get<unknown>(`${BUILDER_BASE}/session/${encodeURIComponent(appId)}`, { signal }),
        );
    } catch (err) {
        expectedRefusal(err, [404]);
        return null;
    }
}

export interface BuilderStreamOptions {
    signal?: AbortSignal;
    /** Every parsed event in arrival order. The heartbeat `ping` is not delivered. */
    onEvent: (event: BuilderEvent) => void;
}

/**
 * Run one builder turn. Resolves when the stream ends (after `done`, or after
 * an `error` event), rejects on a pre-stream refusal or a dropped connection.
 * Aborting the signal closes the socket, which stops the model server-side.
 */
export async function streamBuilderTurn(input: BuilderTurnInput, opts: BuilderStreamOptions): Promise<void> {
    const frames = streamSse(`${BUILDER_BASE}/stream`, {
        body: input,
        signal: opts.signal,
        idleTimeoutMs: BUILDER_IDLE_TIMEOUT_MS,
    });
    for await (const frame of frames) {
        if (frame.event === 'ping') continue;
        opts.onEvent(readBuilderEvent(frame.event, frame.data));
    }
}
