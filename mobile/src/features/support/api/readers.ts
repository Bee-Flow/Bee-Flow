/** Contract readers for the support payloads. */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type {
    CreatedThread,
    SupportMessage,
    SupportThread,
    SupportThreadDetail,
} from '../model/types';

const readThread: (raw: unknown) => SupportThread = shapeOf({
    id: field.str(''),
    subject: field.str(''),
    status: field.str('open'),
    priority: field.optStr,
    created_at: field.str(''),
    updated_at: field.optStr,
    last_message_at: field.strOrNull,
    ai_handled: field.optBool,
    resolved_at: field.strOrNull,
});

const readMessage: (raw: unknown) => SupportMessage = shapeOf({
    id: field.str(''),
    body: field.str(''),
    author_kind: field.str(''),
    author_display: field.strOrNull,
    created_at: field.str(''),
});

/** `{ threads: [...] }` → the rows; a body without the list reads as none. */
export function readThreadList(raw: unknown): SupportThread[] {
    return field.list(readThread)(pick(raw, 'threads'));
}

export const readThreadDetail: (raw: unknown) => SupportThreadDetail | null = nullable(
    shapeOf({
        thread: readThread,
        messages: field.list(readMessage),
        viewerIsStaff: field.bool(false),
    }),
);

/** A threadId of null means the server made none; absent means it did not say. */
function optNullableStr(value: unknown): string | null | undefined {
    return value === null ? null : field.optStr(value);
}

export const readCreatedThread: (raw: unknown) => CreatedThread | null = nullable(
    shapeOf({ ok: field.optBool, threadId: optNullableStr }),
);
