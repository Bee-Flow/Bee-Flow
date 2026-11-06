/**
 * recorder.mts: the write path of the KB query log.
 *
 * A search function calls `beginKbQueryLog` with what it was asked and what it found; the
 * answering step later calls `handle.finish(...)`. Both are best effort: nothing in here
 * ever throws into a search or a chat turn, and a search that logs nothing costs one map
 * lookup (a 30 s cache of "which of these knowledge bases log").
 *
 * What is written: one row per logging knowledge base, all rows of one search sharing a
 * `search_group_id`. A row holds only the passages of its own KB, so the manager of KB A never
 * sees a passage of KB B. Nothing is written without the `kb_query_log` licence, even when
 * the setting is still on.
 *
 * Outcome before `finish`: `no_results` when the KB gave no passage; `answered` for the
 * retrieval-only channels (there is no answer to wait for); `no_results` for answering
 * channels until `finish` says what happened.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { CHUNK_TEXT_CAP, QUERY_CAP, RETRIEVAL_ONLY_CHANNELS, cap, type Channel, type Outcome } from './vocab.mts';
import type { FinishPatch, InsertRow, LogChunk } from '../../../stores/kb/queryLog/index.mts';

const nodeRequire = createRequire(import.meta.url);

export const LICENCE_FEATURE = 'kb_query_log';
export const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 2000;

export interface BeginInput {
    channel: Channel;
    channelRef?: Record<string, unknown> | null;
    userId?: string | null;
    orgId?: string | null;
    kbIds: string[];
    query: string;
    /** Search results as the search functions return them (snake_case or camelCase). */
    chunks: Array<Record<string, any>>;
    retrievalMs?: number | null;
}

export interface Handle {
    searchGroupId: string;
    finish: (patch: Omit<FinishPatch, 'outcome'> & { outcome: Outcome }) => Promise<void>;
    /** Resolves when the (fire-and-forget) insert has settled. For tests and for finish. */
    settled: () => Promise<void>;
}

export interface RecorderDeps {
    store: {
        getLoggingKbs: (ids: string[]) => Promise<Array<{ id: string; organizationId: string | null; retentionDays: number }>>;
        kbIdsForDocuments: (docIds: string[], kbIds: string[]) => Promise<Map<string, string>>;
        insertEntries: (rows: InsertRow[]) => Promise<number>;
        finishGroup: (groupId: string, patch: FinishPatch) => Promise<number>;
    };
    hasFeature: (scope: { organizationId?: string | null; userId?: string | null }, feature: string) => Promise<boolean>;
    log: { warn: (msg: string, ...rest: unknown[]) => void };
    now: () => number;
}

function defaultDeps(): RecorderDeps {
    return {
        store: nodeRequire('../../../stores/kb/queryLog/index.mts'),
        hasFeature: (scope, feature) => nodeRequire('../../../license/index.js').hasFeature(scope, feature),
        log: nodeRequire('../../../telemetry/log.js'),
        now: () => Date.now(),
    };
}

let deps: RecorderDeps | null = null;
const d = (): RecorderDeps => deps ?? (deps = defaultDeps());

/** Test hook: replace dependencies; no argument restores the real ones (and clears the caches). */
export function _setRecorderDeps(next?: Partial<RecorderDeps> | null): void {
    deps = next ? { ...defaultDeps(), ...next } : null;
    invalidateKbQueryLogCache();
}

type KbEntry = { id: string; organizationId: string | null; retentionDays: number } | null;
const kbCache = new Map<string, { at: number; entry: KbEntry }>();
const licenceCache = new Map<string, { at: number; ok: boolean }>();

/** Forget what is cached about one knowledge base, or about all of them. Call after a settings change. */
export function invalidateKbQueryLogCache(kbId?: string): void {
    if (kbId === undefined) { kbCache.clear(); licenceCache.clear(); return; }
    kbCache.delete(kbId);
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value as string);
    map.set(key, value);
}

async function loggingKbs(kbIds: string[]): Promise<Array<NonNullable<KbEntry>>> {
    const now = d().now();
    const unknown = kbIds.filter((id) => { const hit = kbCache.get(id); return !hit || now - hit.at > CACHE_TTL_MS; });
    if (unknown.length) {
        const found = await d().store.getLoggingKbs(unknown);
        const byId = new Map(found.map((k) => [k.id, k]));
        for (const id of unknown) remember(kbCache, id, { at: now, entry: byId.get(id) ?? null });
    }
    return kbIds.map((id) => kbCache.get(id)?.entry ?? null).filter((e): e is NonNullable<KbEntry> => !!e);
}

async function licensed(orgId: string | null, userId: string | null): Promise<boolean> {
    const key = `${orgId ?? ''}|${userId ?? ''}`;
    const now = d().now();
    const hit = licenceCache.get(key);
    if (hit && now - hit.at <= CACHE_TTL_MS) return hit.ok;
    const ok = !!(await d().hasFeature({ organizationId: orgId ?? undefined, userId: userId ?? undefined }, LICENCE_FEATURE));
    remember(licenceCache, key, { at: now, ok });
    return ok;
}

function toLogChunk(c: Record<string, any>): LogChunk {
    return {
        chunkId: c.id ?? c.chunk_id ?? c.chunkId ?? null,
        documentId: c.document_id ?? c.documentId ?? null,
        documentVersionId: c.document_version_id ?? c.documentVersionId ?? null,
        sourceUri: c.source_uri ?? c.sourceUri ?? null,
        title: c.title ?? null,
        score: typeof c.score === 'number' ? c.score : null,
        page: c.page_start ?? c.page ?? null,
        text: cap(c.content ?? c.text, CHUNK_TEXT_CAP),
    };
}

/**
 * A user id that is not a person: the support responder's `support-ai:<thread>`, an embed visitor's
 * `guest_...`. The log names a real user or nobody.
 */
const NOT_A_USER = /^(support-ai:|guest([_:-]|$)|embed[_:-]|anon(ymous)?([_:-]|$))/i;

/** The id to log for `id`: itself when it can be a person, otherwise null. */
export function loggableUserId(id: unknown): string | null {
    return typeof id === 'string' && id && !NOT_A_USER.test(id) ? id : null;
}

/** True when every KB is, by a fresh cached answer, not logging: the only check the caller waits for. */
function knownNotLogging(kbIds: string[]): boolean {
    const now = d().now();
    return kbIds.every((id) => { const hit = kbCache.get(id); return !!hit && now - hit.at <= CACHE_TTL_MS && hit.entry === null; });
}

/** The rows of one search: one per logging, licensed KB of an organisation. Empty = nothing to log. */
async function prepareRows(input: BeginInput, kbIds: string[], userId: string | null, searchGroupId: string): Promise<InsertRow[]> {
    // A KB without an organisation (a personal one) is never logged: there is nobody to manage, review or erase it.
    const logging = (await loggingKbs(kbIds)).filter((kb) => !!kb.organizationId);
    if (logging.length === 0) return [];
    const permitted: typeof logging = [];
    for (const kb of logging) if (await licensed(kb.organizationId, userId)) permitted.push(kb);
    if (permitted.length === 0) return [];

    const chunks = Array.isArray(input.chunks) ? input.chunks : [];
    const docToKb = await d().store.kbIdsForDocuments(
        chunks.map((c) => c.document_id ?? c.documentId).filter(Boolean), permitted.map((k) => k.id));
    // A search over exactly one KB owns every chunk it returned, even one without a document id.
    const soleKb = kbIds.length === 1 ? kbIds[0] : null;
    const perKb = new Map<string, LogChunk[]>(permitted.map((k) => [k.id, []]));
    for (const c of chunks) {
        const kbId = docToKb.get(String(c.document_id ?? c.documentId)) ?? (soleKb && perKb.has(soleKb) ? soleKb : null);
        if (kbId) perKb.get(kbId)?.push(toLogChunk(c));
    }

    const retrievalOnly = (RETRIEVAL_ONLY_CHANNELS as readonly string[]).includes(input.channel);
    const createdAt = new Date(d().now());
    return permitted.map((kb) => {
        const own = perKb.get(kb.id) ?? [];
        return {
            searchGroupId, organizationId: kb.organizationId, kbId: kb.id, userId,
            channel: input.channel, channelRef: input.channelRef ?? {}, createdAt,
            query: cap(input.query, QUERY_CAP), chunks: own, retrievalMs: input.retrievalMs ?? null,
            outcome: own.length > 0 && retrievalOnly ? 'answered' : 'no_results', retentionDays: kb.retentionDays,
        };
    });
}

/**
 * Start the log of one search. Resolves at once, without a database round-trip: to a handle, or to
 * null when the in-memory cache already knows nothing is to be logged (or on bad input). The lookups
 * (which KBs log, the licence, the document-to-KB map) and the insert run behind the handle; when they
 * conclude there is nothing to log, the handle is a no-op. Never rejects.
 */
export async function beginKbQueryLog(input: BeginInput): Promise<Handle | null> {
    try {
        const kbIds = [...new Set((input?.kbIds || []).filter((id) => typeof id === 'string' && id))];
        if (kbIds.length === 0 || knownNotLogging(kbIds)) return null;
        const userId = loggableUserId(input.userId);
        const searchGroupId = randomUUID();

        // Fire and forget: the search does not wait for the log.
        const insert: Promise<boolean> = Promise.resolve()
            .then(() => prepareRows(input, kbIds, userId, searchGroupId))
            .then(async (rows) => (rows.length > 0 && (await d().store.insertEntries(rows)) > 0))
            .catch((err) => { d().log.warn(`[KbQueryLog] not logged (${(err as Error).name}): ${(err as Error).message}`); return false; });

        let finished: Promise<void> | null = null;
        return {
            searchGroupId,
            settled: async () => { await insert; },
            finish: (patch) => finished ??= (async () => {
                try {
                    if (!(await insert)) return;
                    await d().store.finishGroup(searchGroupId, patch);
                } catch (err) {
                    d().log.warn(`[KbQueryLog] finish failed: ${(err as Error).message}`);
                }
            })(),
        };
    } catch (err) {
        try { d().log.warn(`[KbQueryLog] begin failed: ${(err as Error).message}`); } catch { /* never throws */ }
        return null;
    }
}
