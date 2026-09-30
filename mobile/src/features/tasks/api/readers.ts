/**
 * Contract readers for AI tasks (aiTaskStore.rowToTask) and reminders
 * (reminderStore.getReminders). An interval the server does not list reads as
 * a one-off rather than as a string no picker can show.
 */

import { field, shapeListOf, shapeOf } from '@/core/api/contract';

import { REPEAT_INTERVALS, type AiTask, type Reminder, type RepeatInterval } from '../model/types';

export const readTask: (raw: unknown) => AiTask = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    title: field.str('Untitled task'),
    prompt: field.str(''),
    repeatInterval: field.oneOfOrNull<RepeatInterval>(REPEAT_INTERVALS),
    nextRunAt: field.strOrNull,
    lastRunAt: field.strOrNull,
    lastResult: field.strOrNull,
    lastStatus: field.strOrNull,
    isActive: field.bool(false),
    modelTier: field.strOrNull,
    runCount: field.numOrNull,
    timezone: field.strOrNull,
    createdAt: field.strOrNull,
    agentId: field.strOrNull,
    conversationId: field.strOrNull,
    daysOfWeek: field.strArrayOrNull,
    timeOfDay: field.strOrNull,
    agentName: field.optStr,
    agentAvatar: field.optStr,
});

const reminderSpec = {
    id: field.str(''),
    userId: field.str(''),
    title: field.str('Reminder'),
    message: field.strOrNull,
    remindAt: field.strOrNull,
    repeatInterval: field.strOrNull,
    isCompleted: field.bool(false),
    createdAt: field.strOrNull,
};
export const readReminder: (raw: unknown) => Reminder = shapeOf(reminderSpec);
export const readReminderRows: (raw: unknown) => Reminder[] = shapeListOf(reminderSpec);
