/**
 * Contract readers for the two surfaces only search reads: the conversation
 * search and the notebook list as a keystroke asks for it. The knowledge,
 * automation and meeting-note lists are read by their own features (api/corpus.ts,
 * api/matches.ts). The casing differs per endpoint on purpose — see
 * model/types.ts.
 */

import { field, pick, shapeListOf } from '@/core/api/contract';

import type { ConversationSearchRow, NotebookSearchRow } from '../model/types';

/** An id as text. The joins below compare ids as strings, whatever the driver sent. */
function idText(value: unknown): string {
    if (typeof value === 'string') return value;
    return typeof value === 'number' ? String(value) : '';
}

/** GET /agents/conversations/search — a bare array of agent and direct rows. */
export const readConversationRows: (raw: unknown) => ConversationSearchRow[] = shapeListOf({
    id: idText,
    title: field.strOrNull,
    updated_at: field.str(''),
    model_tier: field.strOrNull,
    kind: field.optStr,
    agent_id: field.strOrNull,
    agent_name: field.strOrNull,
    messages_json: field.strOrNull,
});

const readNotebookRows: (raw: unknown) => NotebookSearchRow[] = shapeListOf({
    id: idText,
    name: field.str(''),
    description: field.str(''),
    preview: field.str(''),
    sourceCount: field.num(0),
    lastActivityAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

export function readNotebooks(raw: unknown): NotebookSearchRow[] {
    return readNotebookRows(pick(raw, 'notebooks'));
}
