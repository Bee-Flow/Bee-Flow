/**
 * Contract readers for the AI builder: the persisted session snapshot and one
 * reader per SSE event of `POST /api/studio-apps/builder/stream`.
 *
 * BUILDER_EVENT_READERS is the phone's list of the events it understands; the
 * builder-events lockstep test holds it to every `send('x'` in the server's
 * builder route, so a new event cannot arrive without somebody deciding.
 */

import { field, pick, shapeListOf, shapeOf, type FieldReader } from '@/core/api/contract';

import { readDefinition, readIssues, readRecordList } from './readersApps';
import type { OpenRecord } from '../model/apiTypes';
import type { BuilderEvent, BuilderSession, BuilderTodo } from '../model/builderTypes';

const readTodos: FieldReader<BuilderTodo[]> = shapeListOf({ text: field.str(''), done: field.bool(false) });

const readMessages = shapeListOf({
    role: field.oneOf(['user', 'assistant'] as const, 'assistant'),
    content: field.str(''),
});

const readSnapshot: (raw: unknown) => BuilderSession = shapeOf({
    sessionId: field.strOrNull,
    appId: field.strOrNull,
    messages: readMessages,
    lastValidation: field.recordOrNull<OpenRecord>,
    summary: field.raw,
    updatedAt: field.strOrNull,
    lastTier: field.strOrNull,
    todos: readTodos,
    brief: field.raw,
    approvedPlan: field.recordOrNull<OpenRecord>,
    pendingPlan: field.recordOrNull<OpenRecord>,
    continueToken: field.strOrNull,
    version: field.num(0),
});

/** `GET /builder/session/:appId` → `{ snapshot }`. */
export function readBuilderSession(raw: unknown): BuilderSession | null {
    const snapshot = pick(raw, 'snapshot');
    return field.recordOrNull(snapshot) ? readSnapshot(snapshot) : null;
}

type Payload<T extends BuilderEvent['type']> = Omit<Extract<BuilderEvent, { type: T }>, 'type'>;
type EventReaders = { [T in Exclude<BuilderEvent['type'], 'unknown'>]: (raw: unknown) => Payload<T> };

const partId = { partId: field.strOrNull };

const readAdded = shapeListOf({ id: field.str(''), type: field.str(''), label: field.strOrNull });

const readDataModelTables = shapeListOf({
    id: field.str(''),
    key: field.str(''),
    name: field.str(''),
    fieldCount: field.num(0),
    rowCount: field.num(0),
    linked: field.recordOrNull<OpenRecord>,
});

/** `plan` is EITHER the plan-first artifact OR the live checklist. */
function readPlan(raw: unknown): Payload<'plan'> {
    const todos = pick(raw, 'todos');
    return {
        planId: field.strOrNull(pick(raw, 'planId')),
        plan: field.recordOrNull<OpenRecord>(pick(raw, 'plan')),
        todos: Array.isArray(todos) ? readTodos(todos) : null,
    };
}

export const BUILDER_EVENT_READERS: EventReaders = {
    builder_session: shapeOf({ sessionId: field.str(''), appId: field.strOrNull }),
    model_selected: shapeOf({ modelId: field.str(''), tier: field.strOrNull }),
    round_start: shapeOf({
        iter: field.num(0),
        modelId: field.strOrNull,
        effort: field.strOrNull,
        local: field.bool(false),
    }),
    prompt_progress: shapeOf({ iter: field.num(0), total: field.num(0), processed: field.num(0) }),
    tool_draft: shapeOf({ iter: field.num(0), name: field.str(''), items: readRecordList }),
    thinking_start: shapeOf(partId),
    thinking: shapeOf({ delta: field.str(''), ...partId }),
    thinking_stop: shapeOf(partId),
    message: shapeOf({ content: field.str('') }),
    tool_call: shapeOf({
        name: field.str(''),
        label: field.strOrNull,
        ok: field.bool(false),
        summary: field.str(''),
        added: readAdded,
        error: field.strOrNull,
        hint: field.strOrNull,
    }),
    draft: shapeOf({ appId: field.strOrNull, definition: readDefinition, version: field.numOrNull }),
    data_model: shapeOf({
        modelVersion: field.numOrNull,
        tables: readDataModelTables,
        datasets: shapeListOf({ id: field.str(''), name: field.str('') }),
    }),
    plan: readPlan,
    phase: shapeOf({ index: field.num(0), total: field.num(0), label: field.str('') }),
    checkpoint: shapeOf({ versionId: field.strOrNull, summary: field.str('') }),
    image: shapeOf({ data: field.str(''), mimeType: field.str('image/png'), caption: field.strOrNull }),
    validation_errors: shapeOf({ errors: readIssues, warnings: readIssues }),
    usage: shapeOf({ inputTokens: field.num(0), outputTokens: field.num(0), iter: field.numOrNull }),
    done: shapeOf({ appId: field.strOrNull, finalized: field.bool(false) }),
    error: shapeOf({ message: field.str(''), code: field.strOrNull }),
};

/** Every event name the phone reads. */
export const BUILDER_EVENT_TYPES = Object.keys(BUILDER_EVENT_READERS) as (keyof EventReaders)[];

function isKnown(event: string): event is keyof EventReaders {
    return Object.prototype.hasOwnProperty.call(BUILDER_EVENT_READERS, event);
}

/** One SSE frame → a typed builder event. `ping` and the like read as `unknown`. */
export function readBuilderEvent(event: string, data: unknown): BuilderEvent {
    if (!isKnown(event)) return { type: 'unknown', event, data };
    const reader = BUILDER_EVENT_READERS[event] as (raw: unknown) => object;
    return { type: event, ...reader(data) } as BuilderEvent;
}
