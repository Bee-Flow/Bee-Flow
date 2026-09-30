/**
 * The two runtime streams whose frames are data-only `{ type, … }` JSON:
 * an `ai_browse` step (server/routes/studioAppBrowse.js) and an app's AI
 * chat component (server/routes/studioAppsRun.js POST /:id/ai/chat). Both are
 * SSE-over-POST through core/api/sse.
 */

import { field } from '@/core/api/contract';
import { streamSse } from '@/core/api/sse';

import { appPath } from './paths';
import type { OpenRecord } from '../model/apiTypes';
import type { StepInput } from '../model/runtimeTypes';

/** A data-only frame, discriminated by its own `type`. */
export interface TypedFrame extends OpenRecord {
    type: string;
}

export interface FrameStreamOptions {
    signal?: AbortSignal;
    onFrame: (frame: TypedFrame) => void;
}

/** A browse waits up to 45 s for a browser slot; the server heartbeats every 15 s. */
const BROWSE_IDLE_TIMEOUT_MS = 60_000;

async function pump(path: string, body: unknown, opts: FrameStreamOptions & { idleTimeoutMs?: number }) {
    const frames = streamSse(path, { body, signal: opts.signal, idleTimeoutMs: opts.idleTimeoutMs });
    for await (const frame of frames) {
        const data = field.recordOrNull(frame.data);
        const type = data?.type;
        if (!data || typeof type !== 'string' || type === 'ping') continue;
        opts.onFrame({ ...data, type });
    }
}

/**
 * Run one `ai_browse` step. Frames: queued | start | frame | action | end |
 * result (`{ ok, result | error }`) | done.
 */
export async function streamBrowseStep(
    appId: string,
    actionId: string,
    input: StepInput,
    opts: FrameStreamOptions,
): Promise<void> {
    const { draft, ...rest } = input;
    const qs = draft ? '?draft=1' : '';
    const body = { ...rest, formValues: rest.formValues ?? {}, vars: rest.vars ?? {} };
    const path = `${appPath(appId)}/actions/${encodeURIComponent(actionId)}/step/stream${qs}`;
    await pump(path, body, { ...opts, idleTimeoutMs: BROWSE_IDLE_TIMEOUT_MS });
}

export interface AppChatInput {
    nodeId: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    draft?: boolean;
}

/** One turn of an app's `ai_chat` component. Frames: text `{ text }` | error `{ error }` | done. */
export async function streamAppChat(appId: string, input: AppChatInput, opts: FrameStreamOptions): Promise<void> {
    const qs = input.draft ? '?draft=1' : '';
    await pump(`${appPath(appId)}/ai/chat${qs}`, { nodeId: input.nodeId, messages: input.messages }, opts);
}
