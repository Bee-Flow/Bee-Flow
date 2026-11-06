/**
 * hook.mts: the glue between a search function and the KB query log.
 *
 * `logSearch` is what a search function calls with its `log` option: it records the search and
 * hangs the handle on the returned value (non-enumerable `_queryLog`, like `_metrics`), so the
 * caller can carry it to the place where the answer is known. `finishLogs` / `trackAnswer` /
 * `turnLogs` are the answer side. Everything here is best effort: nothing throws into a search
 * or a chat turn, and nothing on the answer path waits for the database.
 */

import { beginKbQueryLog, type Handle } from './recorder.mts';
import type { Channel, Outcome } from './vocab.mts';

/** The `log` option the search functions accept. */
export interface LogOption {
    channel: Channel;
    channelRef?: Record<string, unknown> | null;
    orgId?: string | null;
    userId?: string | null;
    /** A turn collector (see `turnLogsOf`): the handle is registered on it as soon as the search is recorded. */
    carrier?: object | null;
}

export interface SearchRecord {
    kbIds: string[];
    query: string;
    chunks: Array<Record<string, any>>;
    retrievalMs?: number | null;
    /** The person asking, when the search function knows better than `log.userId`. */
    userId?: string | null;
}

export interface AnswerRecord {
    answer?: string | null;
    citations?: unknown[] | null;
    model?: string | null;
    answerMs?: number | null;
    outcome: Outcome;
    errorCode?: string | null;
}

/** A handle, or null; also accepts what `logSearch` attached to a result. */
export type MaybeHandle = Handle | null | undefined;

/** Record one search. Resolves to the handle (also attached to `target`) or null. Never rejects. */
export async function logSearch(target: object, log: LogOption | null | undefined, search: SearchRecord): Promise<Handle | null> {
    if (!log || !log.channel || !target) return null;
    try {
        const handle = await beginKbQueryLog({
            channel: log.channel, channelRef: log.channelRef ?? null,
            userId: log.userId ?? search.userId ?? null, orgId: log.orgId ?? null,
            kbIds: search.kbIds, query: search.query, chunks: search.chunks, retrievalMs: search.retrievalMs ?? null,
        });
        if (handle) {
            attachHandle(target, handle);
            if (log.carrier) turnLogsOf(log.carrier).add(handle);
        }
        return handle;
    } catch {
        return null;
    }
}

/** Hang a handle on a value as a non-enumerable `_queryLog` (it never serialises). */
export function attachHandle<T extends object>(target: T, handle: Handle | null): T {
    if (handle && target && typeof target === 'object') {
        Object.defineProperty(target, '_queryLog', { value: handle, enumerable: false, configurable: true, writable: true });
    }
    return target;
}

/** The handle a search function attached to its result, or null. */
export function handleOf(value: unknown): Handle | null {
    const h = value && typeof value === 'object' ? (value as { _queryLog?: Handle })._queryLog : null;
    return h && typeof h.finish === 'function' ? h : null;
}

/** A short, non-sensitive code for a failed model call. */
export function errorCodeOf(err: unknown): string {
    const e = err as { code?: unknown; status?: unknown; name?: unknown } | null;
    if (e && (typeof e.code === 'string' || typeof e.code === 'number') && String(e.code)) return String(e.code).slice(0, 64);
    if (e && typeof e.status === 'number') return `http_${e.status}`;
    return (e && typeof e.name === 'string' && e.name ? e.name : 'error').slice(0, 64);
}

/** Citations as the log keeps them: ids, titles and scores, not the passage text (the chunks hold that). */
export function slimCitations(citations: unknown): unknown[] | undefined {
    if (!Array.isArray(citations) || citations.length === 0) return undefined;
    return citations.map((c) => {
        if (!c || typeof c !== 'object') return c;
        const { content, snippet, preview, text, ...rest } = c as Record<string, unknown>;
        void content; void snippet; void preview; void text;
        return rest;
    });
}

/** Finish every handle with the same answer. Fire and forget; finish never throws. */
export function finishLogs(handles: MaybeHandle | Iterable<MaybeHandle>, patch: AnswerRecord): void {
    const list = handles && typeof (handles as Iterable<MaybeHandle>)[Symbol.iterator] === 'function'
        ? [...(handles as Iterable<MaybeHandle>)] : [handles as MaybeHandle];
    const seen = new Set<Handle>();
    for (const h of list) {
        if (!h || seen.has(h)) continue;
        seen.add(h);
        h.finish({ ...patch, citations: slimCitations(patch.citations) ?? null }).catch(() => { /* never throws */ });
    }
}

/** Finish with a failed model call. */
export function finishLogsWithError(handles: MaybeHandle | Iterable<MaybeHandle>, err: unknown, startedAt?: number, model?: string | null): void {
    finishLogs(handles, {
        outcome: 'error', errorCode: errorCodeOf(err), model: model ?? null,
        answerMs: startedAt ? Date.now() - startedAt : null,
    });
}

/**
 * Run the answering step and finish the handles with what it produced (or with the error it
 * threw, which is rethrown). `answerOf` maps the step's result to the answer text.
 */
export async function trackAnswer<T>(
    handles: MaybeHandle | Iterable<MaybeHandle>,
    opts: { model?: string | null; answerOf: (result: T) => string | null | undefined; citationsOf?: (result: T) => unknown[] | null | undefined },
    run: () => Promise<T>,
): Promise<T> {
    const t0 = Date.now();
    let result: T;
    try {
        result = await run();
    } catch (err) {
        finishLogsWithError(handles, err, t0, opts.model);
        throw err;
    }
    try {
        finishLogs(handles, {
            outcome: 'answered', answer: opts.answerOf(result) ?? null, citations: opts.citationsOf?.(result) ?? null,
            model: opts.model ?? null, answerMs: Date.now() - t0,
        });
    } catch { /* logging never breaks the answer */ }
    return result;
}

/**
 * The handles of one turn (an agent turn can search several times). Lives as a non-enumerable
 * property on a turn-scoped carrier object, so it threads through code that already passes the carrier.
 */
export interface TurnLogs {
    add: (handle: MaybeHandle) => void;
    handles: () => Handle[];
    finish: (patch: AnswerRecord) => void;
    fail: (err: unknown, startedAt?: number, model?: string | null) => void;
}

const SLOT = '_kbQueryLogs';

/** The collector on `carrier` (created on first use). */
export function turnLogsOf(carrier: object): TurnLogs {
    const holder = carrier as Record<string, TurnLogs | undefined>;
    const existing = holder[SLOT];
    if (existing) return existing;
    const set = new Set<Handle>();
    const logs: TurnLogs = {
        add: (h) => { if (h) set.add(h); },
        handles: () => [...set],
        finish: (patch) => { if (set.size) finishLogs(set, patch); },
        fail: (err, startedAt, model) => { if (set.size) finishLogsWithError(set, err, startedAt, model); },
    };
    Object.defineProperty(carrier, SLOT, { value: logs, enumerable: false, configurable: true });
    return logs;
}

/** The collector on `carrier` when there is one; null otherwise (so a turn without logging allocates nothing). */
export function peekTurnLogs(carrier: unknown): TurnLogs | null {
    if (!carrier || typeof carrier !== 'object') return null;
    return (carrier as Record<string, TurnLogs | undefined>)[SLOT] ?? null;
}

/** Register a handle on the collector of `carrier`; a no-op without a handle or a carrier. */
export function registerHandle(carrier: unknown, handle: MaybeHandle): void {
    if (handle && carrier && typeof carrier === 'object') turnLogsOf(carrier).add(handle);
}

/** Finish every search of a turn with the answer; a no-op when the turn searched nothing. */
export function finishTurnLogs(carrier: unknown, patch: AnswerRecord): void {
    peekTurnLogs(carrier)?.finish(patch);
}

/** Finish every search of a turn as failed; a no-op when the turn searched nothing. */
export function failTurnLogs(carrier: unknown, err: unknown, startedAt?: number, model?: string | null): void {
    peekTurnLogs(carrier)?.fail(err, startedAt, model);
}

/**
 * Run the answering step of a turn and finish every search registered on `carrier` with its result
 * (or with the error it threw, which is rethrown). Like `trackAnswer`, but the handles are looked up
 * when the step is done, because the step itself (a tool loop) is what registers them.
 */
export async function trackTurn<T>(
    carrier: unknown,
    opts: { model?: string | null; modelOf?: (result: T) => string | null | undefined; answerOf: (result: T) => string | null | undefined; citationsOf?: (result: T) => unknown[] | null | undefined },
    run: () => Promise<T>,
): Promise<T> {
    const t0 = Date.now();
    let result: T;
    try {
        result = await run();
    } catch (err) {
        failTurnLogs(carrier, err, t0, opts.model);
        throw err;
    }
    try {
        finishTurnLogs(carrier, {
            outcome: 'answered', answer: opts.answerOf(result) ?? null, citations: opts.citationsOf?.(result) ?? null,
            model: opts.modelOf?.(result) ?? opts.model ?? null, answerMs: Date.now() - t0,
        });
    } catch { /* logging never breaks the answer */ }
    return result;
}

/** The log option of a support-reply search: the requester is the person asking (null for an anonymous one). */
export function supportQueryLog(
    thread: { id: string; organization_id?: string | null; requester_user_id?: string | null },
    cfg: { orgId?: string | null },
    carrier: object,
): LogOption {
    return {
        channel: 'support', channelRef: { threadId: thread.id },
        orgId: thread.organization_id || cfg.orgId || null, userId: thread.requester_user_id || null, carrier,
    };
}

/**
 * The `log` part of the context of an agent's `kb_search` tool call: the turn's carrier and channel come
 * from the dispatcher (`context.queryLog`), the person asking is the asker, not an acting identity.
 * Empty when the turn gave no carrier, so a call outside a logged turn writes nothing.
 */
export function agentToolLog(context: {
    queryLog?: { carrier: object; channel: Channel; asker?: string | null } | null;
    agentId?: string | null; conversationId?: string | null; orgId?: string | null; askerUserId?: string | null; userId?: string | null;
}): { log?: LogOption } {
    const turn = context.queryLog;
    if (!turn) return {};
    return {
        log: {
            channel: turn.channel, carrier: turn.carrier,
            channelRef: { agentId: context.agentId || null, conversationId: context.conversationId || null },
            orgId: context.orgId || null,
            // An explicit asker (also null: an anonymous requester) wins over the turn's own, possibly synthetic, user id.
            userId: 'asker' in turn ? (turn.asker ?? null) : (context.askerUserId || context.userId || null),
        },
    };
}
