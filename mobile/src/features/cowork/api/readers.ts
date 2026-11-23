/**
 * Contract readers for Cowork.
 *
 * The schedule spec is an allow-list mirror of `rowToSchedule` — the same
 * field list serverContract.test.ts pins on the server side. The tab renders
 * every one of these directly, so a missing field degrades to a stated default
 * ("Untitled cowork", inactive, zero runs) instead of an undefined mid-render.
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    ComposedCowork,
    CoworkNeed,
    CoworkReceipt,
    CoworkRun,
    CoworkSchedule,
    SharedItem,
    SharedView,
} from '../model/types';

const scheduleSpec = {
    id: field.str(''),
    userId: field.str(''),
    title: field.str('Untitled cowork'),
    prompt: field.str(''),
    repeatInterval: field.strOrNull,
    daysOfWeek: field.strArrayOrNull,
    timeOfDay: field.strOrNull,
    nextRunAt: field.strOrNull,
    lastRunAt: field.strOrNull,
    lastResult: field.strOrNull,
    lastStatus: field.strOrNull,
    isActive: field.bool(false),
    modelTier: field.strOrNull,
    runCount: field.num(0),
    timezone: field.strOrNull,
    agentId: field.strOrNull,
    conversationId: field.strOrNull,
    createdAt: field.strOrNull,
};

export const readSchedule: (raw: unknown) => CoworkSchedule = shapeOf(scheduleSpec);
const readScheduleList: (raw: unknown) => CoworkSchedule[] = shapeListOf(scheduleSpec);

/** The list route has answered both a bare array and `{ schedules }`. */
export function readSchedules(raw: unknown): CoworkSchedule[] {
    return readScheduleList(Array.isArray(raw) ? raw : pick(raw, 'schedules'));
}

/**
 * A run's history row. Every field is optional on the type, and each reads as
 * absent (or null) rather than as a default, because the history screen falls
 * back field by field — finishedAt, then startedAt, then createdAt.
 */
const readReview = nullable(
    shapeOf({
        reason: field.strOrNull,
        question: field.strOrNull,
        summary: field.strOrNull,
        resolution: field.strOrNull,
    }),
);

const readRunList: (raw: unknown) => CoworkRun[] = shapeListOf({
    id: field.optStr,
    status: field.optStr,
    result: field.strOrNull,
    error: field.strOrNull,
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    createdAt: field.strOrNull,
    review: readReview,
});

/** The history route has answered both a bare array and `{ runs, total }`. */
export function readRuns(raw: unknown): CoworkRun[] {
    return readRunList(Array.isArray(raw) ? raw : pick(raw, 'runs'));
}

/** The composer's proposal; everything optional, nothing defaulted. */
export const readComposed: (raw: unknown) => ComposedCowork = shapeOf({
    title: field.optStr,
    prompt: field.optStr,
    repeatInterval: field.strOrNull,
    daysOfWeek: field.strArrayOrNull,
    timeOfDay: field.strOrNull,
    runOnce: field.optBool,
    agentId: field.strOrNull,
});

/** "Waiting for you": entries without an item have nowhere to go and are dropped. */
const readNeedList: (raw: unknown) => CoworkNeed[] = shapeListOf({
    kind: field.str(''),
    itemId: field.str(''),
    title: field.str(''),
    plan: field.strOrNull,
});

export function readNeeds(raw: unknown): CoworkNeed[] {
    return readNeedList(pick(raw, 'needs')).filter((n) => n.itemId && n.kind);
}

const ROLES = ['viewer', 'approver'] as const;

/** "Shared with you": a row without an item has nowhere to go and is dropped. */
const readSharedList: (raw: unknown) => SharedItem[] = shapeListOf({
    id: field.str(''),
    ownerId: field.str(''),
    ownerName: field.str(''),
    title: field.str(''),
    role: field.oneOf(ROLES, 'viewer'),
    lastStatus: field.strOrNull,
    lastRunAt: field.strOrNull,
    isActive: field.bool(false),
});

export function readShared(raw: unknown): SharedItem[] {
    return readSharedList(pick(raw, 'items')).filter((i) => i.id);
}

const readSharedItem = shapeOf({
    id: field.str(''),
    title: field.str(''),
    prompt: field.str(''),
    repeatInterval: field.strOrNull,
    nextRunAt: field.strOrNull,
    lastStatus: field.strOrNull,
    isActive: field.bool(false),
    triggerKind: field.str('schedule'),
});

const readSharedRuns = shapeListOf({
    id: field.str(''),
    status: field.strOrNull,
    startedAt: field.strOrNull,
    result: field.strOrNull,
    durationMs: field.numOrNull,
});

/** One shared item, read only; anything that is not an object reads as nothing. */
export const readSharedView: (raw: unknown) => SharedView | null = nullable((raw) => ({
    role: field.oneOf(['viewer', 'approver', 'owner'] as const, 'viewer')(pick(raw, 'role')),
    item: readSharedItem(pick(raw, 'item')),
    runs: readSharedRuns(pick(raw, 'runs')),
}));

/** A run's receipt, or nothing when the answer is not one (a receipt always has its run). */
export const readReceipt: (raw: unknown) => CoworkReceipt | null = nullable((raw) => ({
    seq: field.num(0)(pick(raw, 'seq')),
    runId: field.str('')(pick(raw, 'runId')),
    at: field.strOrNull(pick(raw, 'at')),
    signed: pick(raw, 'signed') === true,
}));
