import type { BuilderStreamData } from '../builderStream';
import { errorTextOf as safeText } from '../builderStream';
import { readEventStream } from '../../api/readEventStream';
import { API_BASE, authFetch } from '../../utils/helpers';
import { handleBuilderEvent } from './events';
import type {
    AppBuilderDoneInfo,
    AppBuilderEventCtx,
    AppBuilderSendOptions,
    AppBuilderStreamDeps,
    Continuation,
    TurnOutcome,
} from './types';
import { logger } from '../../utils/logger';

// Shown when the build stream drops mid-flight (gateway timeout / network
// cut). Every draft is persisted server-side as it lands, so nothing is lost —
// guide the user instead of surfacing a raw "HTTP 504".
const STREAM_DROP_MESSAGE = 'The connection to the AI builder dropped while it was working. Your progress is saved — send your message again to continue.';

// The request body exceeded the server's parser limit — in practice only ever
// oversized attachments, since the rest of a turn is a few KB of JSON.
const OVERSIZE_MESSAGE = 'That message was too large to send — attach fewer or smaller images and try again.';

export interface RunTurnParams {
    message: string;
    options: AppBuilderSendOptions;
    failTurn: (msg: string, code?: string) => void;
}

function requestBody(
    deps: AppBuilderStreamDeps,
    message: string,
    options: AppBuilderSendOptions,
): string {
    const plan = options.plan && typeof options.plan === 'object' ? options.plan : undefined;
    const context = options.context && typeof options.context === 'object' ? options.context : undefined;
    const images = Array.isArray(options.images) && options.images.length ? options.images : undefined;
    return JSON.stringify({
        // A continuation carries no user text — the server resumes
        // from the continueToken; a plan approval may also be textless.
        message: message || undefined,
        appId: deps.appId || undefined,
        builderSessionId: deps.sessionIdRef.current || undefined,
        modelTier: options.modelTier || 'auto',
        // The editor's current focus (selection / screen / bound table).
        context,
        // Plan-first UX: force/suppress the plan (quick actions send
        // 'never'); approve an edited plan; resume a phased build.
        planMode: options.planMode || undefined,
        plan,
        continueToken: options.continueToken || undefined,
        // Screenshots the user pasted/attached, as data URLs.
        images,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam',
    });
}

/** The user-facing text for a request that threw (a stop() abort says nothing). */
function failureText(failure: Error): string {
    const looksLikeDrop = /network|fetch|terminated|timeout|aborted|closed/i.test(failure.message || '');
    return looksLikeDrop ? STREAM_DROP_MESSAGE : (failure.message || 'Stream failed');
}

/** POST the turn and feed every SSE event to its handler; a dropped stream fails the turn. */
async function streamResponse(ctx: AppBuilderEventCtx, ac: AbortController, message: string): Promise<void> {
    const { outcome, fail, options } = ctx;
    const resp = await authFetch(`${API_BASE}/api/studio-apps/builder/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody(ctx, message, options),
        signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
        const isGateway = resp.status === 504 || resp.status === 502 || resp.status === 408;
        // A 413 never reaches the route (the body parser rejects it), so
        // it has no server-authored message — say what actually happened.
        if (resp.status === 413) fail(OVERSIZE_MESSAGE);
        else fail(isGateway ? STREAM_DROP_MESSAGE : (await safeText(resp)) || `HTTP ${resp.status}`);
        return;
    }
    for await (const { event, data } of readEventStream<BuilderStreamData>(resp, { signal: ac.signal })) {
        handleBuilderEvent(ctx, event, data);
    }
    // The stream closed without a terminal event — a proxy cut the
    // connection mid-build. Fail the turn so the editor unlocks.
    // A stop() abort is not a drop: stop() already settled the turn.
    if (!outcome.sawDone && !outcome.errored && !ac.signal.aborted) fail(STREAM_DROP_MESSAGE);
}

/**
 * Stream ONE turn against the builder route. Returns `{ continuation }` — the
 * `{ token, nextPhase }` payload when the model exhausted its budget mid-plan
 * and the build should auto-resume, else null. `failTurn` is shared with the
 * caller so an error in any leg of a continued build settles the whole action.
 */
export async function runBuilderTurn(
    deps: AppBuilderStreamDeps,
    { message, options, failTurn }: RunTurnParams,
): Promise<{ continuation: Continuation | null; doneInfo: AppBuilderDoneInfo | null }> {
    if (deps.abortRef.current) {
        try { deps.abortRef.current.abort(); } catch (err) { logger.debug('already settled', err); }
    }
    const ac = new AbortController();
    deps.abortRef.current = ac;

    const outcome: TurnOutcome = { sawDone: false, errored: false, continuation: null, doneInfo: null };
    // Wrap the shared failTurn so a terminal `error` event doesn't ALSO
    // trip the "stream closed without done" drop path below (two errors).
    // `code` is the server's taxonomy code (in-stream errors only).
    const fail = (msg: string, code?: string) => { outcome.errored = true; failTurn(msg, code); };
    const ctx = { ...deps, options, outcome, fail };

    try {
        await streamResponse(ctx, ac, message);
    } catch (e) {
        const failure = e instanceof Error ? e : new Error(String(e));
        if (failure.name !== 'AbortError' && !outcome.errored) fail(failureText(failure));
    }
    return { continuation: outcome.continuation, doneInfo: outcome.doneInfo };
}
