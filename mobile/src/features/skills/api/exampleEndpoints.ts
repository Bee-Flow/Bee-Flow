/**
 * "Pick from a conversation" (server/routes/skills/examples.js): the caller's
 * OWN conversations, the assistant turns of one of them with personal data
 * removed, and turning one of those into an example.
 *
 * `piiChecked: false` withdraws the "personal data removed" promise for the
 * whole list — the picker says so rather than implying a check that did not
 * run. A take that cannot be checked answers 503 `pii_unchecked`.
 */

import { api } from '@/core/api/client';
import { field, pick, shapeListOf } from '@/core/api/contract';

import { skillPath } from './endpoints';
import { examplesOf } from '../model/skillModel';
import type { SkillExample } from '../model/types';

export interface ExampleConversation {
    id: string;
    title: string | null;
    agentName: string | null;
    updatedAt: string | null;
}

export interface ExampleMessage {
    index: number;
    text: string;
}

const readConversations = shapeListOf({
    id: field.str(''),
    title: field.strOrNull,
    agentName: field.strOrNull,
    updatedAt: field.strOrNull,
});
const readMessages = shapeListOf({ index: field.num(-1), text: field.str('') });

export async function listExampleConversations(signal?: AbortSignal): Promise<ExampleConversation[]> {
    const res = await api.get<unknown>('/api/skills/examples/conversations', { signal });
    return readConversations(pick(res, 'conversations')).filter((c) => c.id);
}

export async function listExampleMessages(
    conversationId: string,
    signal?: AbortSignal,
): Promise<{ messages: ExampleMessage[]; piiChecked: boolean }> {
    const res = await api.get<unknown>(`/api/skills/examples/conversations/${encodeURIComponent(conversationId)}/messages`, { signal });
    return {
        messages: readMessages(pick(res, 'messages')).filter((m) => m.index >= 0 && m.text),
        // Fail-closed: only an explicit `true` keeps the promise.
        piiChecked: pick(res, 'piiChecked') === true,
    };
}

/** 201 `{ example, examplesV2 }`; the example is normalised like any stored one. */
export async function exampleFromMessage(
    skillId: string,
    input: { conversationId: string; messageIndex: number },
): Promise<SkillExample | null> {
    const res = await api.post<unknown>(`${skillPath(skillId)}/examples/from-message`, input, { retry: false });
    const example = pick(res, 'example');
    return example && typeof example === 'object' ? (examplesOf({ examplesV2: [example] })[0] ?? null) : null;
}
