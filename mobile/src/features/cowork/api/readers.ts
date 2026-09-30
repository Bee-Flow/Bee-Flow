/**
 * Contract readers for Cowork.
 *
 * The schedule spec is an allow-list mirror of `rowToSchedule` — the same
 * field list serverContract.test.ts pins on the server side. The tab renders
 * every one of these directly, so a missing field degrades to a stated default
 * ("Untitled cowork", inactive, zero runs) instead of an undefined mid-render.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { ComposedCowork, CoworkRun, CoworkSchedule } from '../model/types';

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
const readRunList: (raw: unknown) => CoworkRun[] = shapeListOf({
    id: field.optStr,
    status: field.optStr,
    result: field.strOrNull,
    error: field.strOrNull,
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    createdAt: field.strOrNull,
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
