/**
 * One skill-drafting model call: the fast tier, the forced `draft_skill` tool
 * and one usage row. Shared by the skill editor ("Let AI fill it in",
 * "Improve with AI", routes/skills/ai.js) and the agent wizard
 * (usecases/agents/wizardSkills.mts), so both ask the same model the same way
 * and both show up in usage.
 *
 * What the model may hand back is NOT decided here: that is
 * `skillDraft.parseSkillDraft`, which every caller runs over `structured`.
 *
 * Every dependency is required lazily: routes/skills.test.js stubs the skills
 * router's graph without a database, and requiring this module must not pull
 * in the LLM client or the stores. The paths are spelled from the server root
 * (`../../core/...`, `../../stores/...`) on purpose: routes/skills/ai.test.js
 * stubs them by exactly those request strings.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** Same cap the editor's drafting calls always used. */
export const DRAFT_MAX_TOKENS = 2000;

export interface DraftWho { userId: string; userOrgId: string | null }

type ChatMessage = { role: string; content: string };

/** The fast tier, with the global default behind it; null when no model is configured. */
export async function resolveDraftModel({ userId, userOrgId }: DraftWho): Promise<string | null> {
    const { resolveModelForTier, resolveModelWithGlobalFallback } = nodeRequire('../../core/llm/modelResolver') as {
        resolveModelForTier: (tier: string, o: Record<string, unknown>) => Promise<string | null>;
        resolveModelWithGlobalFallback: (tier: string, o: Record<string, unknown>) => Promise<string | null>;
    };
    const { bestEffort } = nodeRequire('../../utils/bestEffort') as { bestEffort: (where: string, err: unknown) => void };
    try {
        const resolved = await resolveModelForTier('tier:fast', { userOrgId, userId, fallbackTier: 'fast' });
        if (resolved) return resolved;
    } catch (err) { bestEffort('core/skills/skillDraftCall:resolveDraftModel', err); /* fall through */ }
    try {
        return await resolveModelWithGlobalFallback('tier:fast', { userOrgId, userId });
    } catch {
        return null;
    }
}

/**
 * One usage row per drafting call. `chatForcedTool` logs nothing itself, so
 * without this a draft would spend tokens that appear in nobody's usage.
 */
async function logDraftUsage(entry: DraftWho & { modelId: string; usage: unknown; startMs: number; source: string }): Promise<void> {
    const log = nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void };
    try {
        const usageStore = nodeRequire('../../stores/usageStore') as { logUsage: (row: Record<string, unknown>) => Promise<unknown> };
        const { usageLogFields } = nodeRequire('../../core/providers/usageNormalizer') as { usageLogFields: (u: unknown) => Record<string, unknown> };
        await usageStore.logUsage({
            user_id: entry.userId,
            agent_name: 'skill-ai',
            agent_type: 'system',
            model: entry.modelId,
            ...usageLogFields(entry.usage),
            source: entry.source,
            duration_ms: Date.now() - entry.startMs,
            organization_id: entry.userOrgId || null,
        });
    } catch (e) {
        log.warn('[Skills/ai] failed to log usage:', (e as Error).message);
    }
}

/**
 * Ask the model for a skill. `{ structured, modelId }`, or null when no model
 * is configured. `structured` is the raw tool arguments: untrusted.
 */
export async function askForDraft({ messages, userId, userOrgId, source }: DraftWho & { messages: ChatMessage[]; source: string }):
    Promise<{ structured: Record<string, unknown> | null; modelId: string } | null> {
    const modelId = await resolveDraftModel({ userId, userOrgId });
    if (!modelId) return null;
    const llmClient = nodeRequire('../../core/llm/llmClient') as {
        chatForcedTool: (model: string, msgs: ChatMessage[], tool: unknown, o: Record<string, unknown>) =>
            Promise<{ structured?: Record<string, unknown> | null; usage?: unknown } | null>;
    };
    const { DRAFT_TOOL } = nodeRequire('./skillDraft') as { DRAFT_TOOL: unknown };
    const startMs = Date.now();
    const result = await llmClient.chatForcedTool(modelId, messages, DRAFT_TOOL, {
        maxTokens: DRAFT_MAX_TOKENS,
        temperature: 0.4,
    });
    await logDraftUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs, source });
    return { structured: result?.structured || null, modelId };
}
