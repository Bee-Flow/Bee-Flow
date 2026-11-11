/**
 * The run log as its readers see it. Two projections of the same rows:
 *
 *   toRunSummary / toStepView   the Studio's Runs view (the app owner, inside Bee Flow): who ran
 *                               it by display name, never an e-mail address
 *   toMcpRun / toMcpStep        app_list_runs / app_get_run: the answer leaves Bee Flow, so the
 *                               actor is a kind and a per-app reference (8 hex), no user id, no name
 *
 * plus the list query a route or tool sends (readRunQuery) and the keyset cursor. Pure.
 */

import { createHash } from 'node:crypto';
import type { RunListRow, StoredStep, ListFilter } from '../../stores/studioAppData/runLogStore.mts';
import { runLogError } from '../../stores/studioAppData/runPolicy.mts';

export type ActorKind = 'owner' | 'user' | 'visitor' | 'system';
export type Actor = { kind: ActorKind; isYou: boolean; userId?: string; name?: string | null };

export type RunSummary = {
    id: string; actionId: string; origin: string; status: string; endedBy: string | null; draft: boolean; dryRun: boolean;
    definitionVersion: number | null; startedAt: string | null; endedAt: string | null; durationMs: number | null;
    stepCount: number; failedSteps: number; handledErrors: number; truncated: boolean; tracked: boolean;
    error: string | null; errorCode: string | null; errorStep: Record<string, unknown> | null;
    ai: { calls: number; promptTokens: number; completionTokens: number; costByCurrency: Record<string, number> };
    actor: Actor;
};

export type StepView = {
    seq: number; path: string; kind: string; actionId: string | null; stepIndex: number | null; iteration: number | null;
    status: string; durationMs: number; startedAt: string | null; error: string | null; errorCode: string | null;
    attempts: number | null; handled: boolean; mocked: boolean; ai: StoredStep['ai'];
};

function actorOf(row: RunListRow, ownerId: string, callerId: string): Actor {
    if (row.viewerUserId) {
        return {
            kind: row.viewerUserId === ownerId ? 'owner' : 'user', isYou: row.viewerUserId === callerId,
            userId: row.viewerUserId, name: row.viewerName,
        };
    }
    return { kind: row.visitorKey ? 'visitor' : 'system', isYou: false };
}

export function toRunSummary(row: RunListRow, ownerId: string, callerId: string): RunSummary {
    return {
        id: row.id, actionId: row.actionId, origin: row.origin, status: row.status, endedBy: row.endedBy, draft: row.draft,
        dryRun: row.dryRun, definitionVersion: row.definitionVersion, startedAt: row.startedAt, endedAt: row.endedAt,
        durationMs: row.durationMs, stepCount: row.stepCount, failedSteps: row.failedSteps, handledErrors: row.handledErrors,
        // Cleaned again on the way out: a background job's own end error (package 3) is stored as the runner wrote it.
        truncated: row.truncated, tracked: row.tracked, error: runLogError(row.error), errorCode: row.errorCode, errorStep: row.errorStep,
        ai: { calls: row.aiCalls, promptTokens: row.promptTokens, completionTokens: row.completionTokens, costByCurrency: row.costByCurrency },
        actor: actorOf(row, ownerId, callerId),
    };
}

export function toStepView(s: StoredStep): StepView {
    return {
        seq: s.seq, path: s.path, kind: s.kind, actionId: s.actionId, stepIndex: s.stepIndex, iteration: s.iteration,
        status: s.status, durationMs: s.durationMs, startedAt: s.startedAt, error: s.error, errorCode: s.errorCode,
        attempts: s.attempts, handled: s.handled, mocked: s.mocked, ai: s.ai,
    };
}

/** A stable reference for one actor within one app: lets a reader group runs without learning who. */
export function actorRef(appId: string, row: Pick<RunListRow, 'viewerUserId' | 'visitorKey'>): string | null {
    const who = row.viewerUserId ? `u:${row.viewerUserId}` : (row.visitorKey ? `v:${row.visitorKey}` : null);
    return who ? createHash('sha256').update(`studio-run-actor:${appId}:${who}`).digest('hex').slice(0, 8) : null;
}

export function toMcpRun(row: RunListRow, appId: string, ownerId: string, callerId: string): Record<string, unknown> {
    const { actor: full, ...rest } = toRunSummary(row, ownerId, callerId);
    const ref = actorRef(appId, row);
    return {
        ...rest,
        actor: { kind: full.kind, isYou: full.isYou, ...(ref ? { ref } : {}) },
    };
}

export function toMcpStep(s: StoredStep): Record<string, unknown> {
    const v = toStepView(s);
    return {
        path: v.path, kind: v.kind, status: v.status, durationMs: v.durationMs,
        ...(v.actionId ? { actionId: v.actionId } : {}),
        ...(v.iteration !== null ? { iteration: v.iteration } : {}),
        ...(v.error ? { error: v.error } : {}),
        ...(v.errorCode ? { code: v.errorCode } : {}),
        ...(v.attempts ? { attempts: v.attempts } : {}),
        ...(v.handled ? { handled: true } : {}),
        ...(v.mocked ? { mocked: true } : {}),
        ...(v.ai ? { ai: v.ai } : {}),
    };
}

// ── Cursor ──────────────────────────────────────────────────────────────────

export function encodeCursor(row: { startedAt: string | null; id: string }): string | null {
    if (!row.startedAt) return null;
    return Buffer.from(`${row.startedAt}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): { startedAt: string; id: string } | null {
    if (typeof raw !== 'string' || !raw || raw.length > 200) return null;
    try {
        const [startedAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
        if (!startedAt || !id || Number.isNaN(Date.parse(startedAt)) || !/^sar_[a-f0-9]{32}$/.test(id)) return null;
        return { startedAt, id };
    } catch {
        return null;
    }
}

// ── Query ───────────────────────────────────────────────────────────────────

export const RUN_STATUSES: readonly string[] = Object.freeze(['running', 'success', 'error', 'interrupted', 'cancelled', 'refused', 'paused']);

export type RunQuery = {
    actionId?: string; status?: string; origin?: string | string[]; user?: string; since?: string; cursor?: string; limit?: number;
};

/**
 * A list request as a store filter. `user`: me | others | visitors | system | a user id.
 * Returns an error sentence for a cursor that does not decode (the caller answers 400).
 */
export function readRunQuery(q: RunQuery, ctx: { appId: string; callerId: string; idleMs: number; staleMs: number; maxLimit: number; defaultLimit: number }): Omit<ListFilter, never> | { error: string } {
    const origins = (Array.isArray(q.origin) ? q.origin : String(q.origin ?? '').split(','))
        .map((s) => s.trim()).filter(Boolean);
    const before = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !before) return { error: 'cursor is the nextCursor a previous page returned.' };
    let actor: ListFilter['actor'] = null;
    if (q.user === 'me') actor = { kind: 'user', userId: ctx.callerId };
    else if (q.user === 'others') actor = { kind: 'others', userId: ctx.callerId };
    else if (q.user === 'visitors') actor = { kind: 'visitors' };
    else if (q.user === 'system') actor = { kind: 'system' };
    else if (q.user) actor = { kind: 'user', userId: q.user };
    const limit = Math.max(1, Math.min(ctx.maxLimit, Math.floor(Number(q.limit) || ctx.defaultLimit)));
    return {
        appId: ctx.appId, actionId: q.actionId || null, status: q.status || null, origins: origins.length ? origins : null,
        actor, since: q.since || null, before, limit, idleMs: ctx.idleMs, staleMs: ctx.staleMs,
    };
}

type PageStore = {
    listRuns(f: ListFilter): Promise<RunListRow[]>;
};

/** One page: `limit` rows and the cursor of the next page (null on the last). */
export async function listPage(store: PageStore, filter: ListFilter): Promise<{ rows: RunListRow[]; nextCursor: string | null }> {
    const rows = await store.listRuns({ ...filter, limit: filter.limit + 1 });
    const more = rows.length > filter.limit;
    const page = more ? rows.slice(0, filter.limit) : rows;
    return { rows: page, nextCursor: more ? encodeCursor(page[page.length - 1]) : null };
}
