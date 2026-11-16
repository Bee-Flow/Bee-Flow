/**
 * runsOnModel.mts: the display name of the model a background job of one
 * organisation runs on, for the "runs on" line of its settings screen.
 *
 * Two organisation settings switch on work the user never sees a model for:
 *   - summarising older messages of a long conversation (core/llm/compaction.js),
 *     written by the Fast tier as the organisation resolves it;
 *   - picking memories out of a finished exchange (core/memory/extractionModel.js),
 *     the server's dedicated extraction model, else the extractor agent's model
 *     through the Fast tier.
 * The server administrator chooses those models, not the organisation admin who
 * flips the switch, so the screen says which one will read the chats. This is a
 * privacy product: "which model reads this" is part of the decision.
 *
 * Only a display name leaves the server: no provider, key, endpoint or setting.
 * Nothing resolvable gives null, and the screen shows no line. A failure is
 * logged and also gives null: a settings screen must never fail on its hint.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const { DISPLAY_NAME_TO_ID } = nodeRequire('./modelNames') as { DISPLAY_NAME_TO_ID: Record<string, string> };
const log = nodeRequire('../../telemetry/log') as { warn(msg: string): void };

type ModelId = string | null | undefined;

/** model id → display name: the first name the picker map gives it (the newest), else the id itself. */
let namesById: Map<string, string> | null = null;
export function modelDisplayName(modelId: string): string {
    if (!namesById) {
        namesById = new Map();
        for (const [name, id] of Object.entries(DISPLAY_NAME_TO_ID)) {
            if (!namesById.has(id)) namesById.set(id, name);
        }
    }
    return namesById.get(modelId) || modelId;
}

async function displayNameOf(job: string, orgId: string, resolve: () => Promise<ModelId>): Promise<string | null> {
    try {
        const id = await resolve();
        return typeof id === 'string' && id.trim() ? modelDisplayName(id.trim()) : null;
    } catch (err) {
        log.warn(`[RunsOn] ${job} model unreadable for org ${orgId}: ${(err as Error).message}`);
        return null;
    }
}

/** The model that writes the summaries of long conversations: the organisation's Fast tier. */
export function compactionRunsOn(orgId: string): Promise<string | null> {
    return displayNameOf('summary', orgId, () => {
        const { resolveModelForTierName } = nodeRequire('./modelResolver') as {
            resolveModelForTierName(tier: string, opts: { userOrgId?: string | null }): Promise<ModelId>;
        };
        return resolveModelForTierName('fast', { userOrgId: orgId });
    });
}

/** The model that picks memories out of a chat, resolved exactly as the extractor does. */
export function memoryExtractionRunsOn(orgId: string): Promise<string | null> {
    return displayNameOf('memory extraction', orgId, async () => {
        const { resolveMemoryExtractionModel } = nodeRequire('../memory/extractionModel') as {
            resolveMemoryExtractionModel(opts: { agentModel?: string | null; userOrgId?: string | null }): Promise<ModelId>;
        };
        const agentStore = nodeRequire('../../stores/agentStore') as {
            getSystemAgent(id: string): Promise<{ model?: string | null } | null | undefined>;
        };
        const agent = await agentStore.getSystemAgent('system-memory-extractor');
        return resolveMemoryExtractionModel({ agentModel: agent?.model ?? null, userOrgId: orgId });
    });
}
