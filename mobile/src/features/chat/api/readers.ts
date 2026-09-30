/**
 * Contract readers for every chat response.
 *
 * The server's JSON arrives as `unknown` and leaves as the declared type,
 * through the allow-list in src/core/api/contract.ts, with a missing or
 * mistyped field degraded to a stated default.
 */

import { field, shapeListOf, shapeOf } from '@/core/api/contract';

import { readMessage } from './messageReader';
import type { TierInfo, TierMap } from '../model/tiers';
import type { ChatLabel, Conversation, ConversationSummary, SessionSkillsResponse } from '../model/types';

export { readMessage } from './messageReader';

const summarySpec = {
    id: field.str(''),
    title: field.strOrNull,
    model_tier: field.strOrNull,
    project_id: field.strOrNull,
    shared_scope: field.strOrNull,
    pinned: field.optBool,
    labels_json: field.strOrNull,
    created_at: field.str(''),
    updated_at: field.str(''),
};
export const readSummaryRows: (raw: unknown) => ConversationSummary[] = shapeListOf(summarySpec);
export const readConversation: (raw: unknown) => Conversation = shapeOf({
    ...summarySpec,
    messages: field.list(readMessage),
    workspace_content: field.strOrNull,
    knowledgeBaseIds: field.strArray,
});

const labelSpec = {
    id: field.str(''),
    name: field.str('Label'),
    color: field.strOrNull,
};
export const readLabel: (raw: unknown) => ChatLabel = shapeOf(labelSpec);
export const readLabelRows: (raw: unknown) => ChatLabel[] = shapeListOf(labelSpec);

export const readSessionSkills: (raw: unknown) => SessionSkillsResponse = shapeOf({
    skills: field.list(
        shapeOf({
            id: field.str(''),
            name: field.str('Skill'),
            description: field.optStr,
            instructions: field.optStr,
            workflow: field.optStr,
        }),
    ),
    activatedSkillIds: field.strArray,
    modelTier: field.str(''),
});

const readTierInfo: (raw: unknown) => TierInfo = shapeOf({
    auto: field.optBool,
    modelId: field.optStr,
    label: field.optStr,
    icon: field.optStr,
    description: field.optStr,
});

/**
 * GET /ai/config/tiers-for-user: a map of tier key to its presentation. Every
 * key the server sends is kept — the set IS the entitlement — and anything
 * that is not a map reads as "no tiers".
 */
export function readTierMap(raw: unknown): TierMap {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: TierMap = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) out[key] = readTierInfo(value);
    return out;
}
