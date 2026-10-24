// @typecheck
/**
 * Grounding for an ai_step (moved verbatim out of execAi.js): personal
 * memory, knowledge bases and skills. Each helper is best-effort and
 * collapses to "no grounding" on failure.
 *
 * `deps` (the last argument of each grounding helper) carries what sits in
 * the server's large import cycle: execAi.js requires it and hands it over
 * (lazy getters for the lazy requires), so this module stays out of the cycle
 * (lint:scc-ratchet) and nothing loads earlier than before.
 */

const log = require('../../telemetry/log');

// ── Knowledge Base grounding (BFSF-410) ─────────────────────────────────────
//
// A single upfront search per step run, injected into the system prompt as
// "Reference material:" — the App Studio ai_generate/ai_extract pattern
// (appStudio/aiRuntime.groundWithKB, itself layered on
// core/agentRuntime/knowledgeSearch's quickKBSearch), deliberately NOT an
// agentic kb_search/kb_fetch tool-call loop: simpler, cheaper, and it fits an
// unattended/scheduled step better than chat's multi-turn pattern.
//
// quickKBSearch performs NO tenant filtering of its own — its access boundary
// IS the id list it is handed, on the documented assumption that the caller
// already authorized every id (core/kb/localKBIngest.js: "Access is already
// gated by kb_ids upstream"). knowledgeBaseIds is authored data (or an MCP
// builder_update_step patch) that could in principle name any knowledge base
// in the system, so every id is re-checked against ctx.userId/ctx.orgId here
// before it ever reaches the search — the same defence-in-depth stance
// execIntegrationAction takes on step.tool above, just for a read instead of a
// dispatch. `core/kb/kbVisibility` holds that check, shared with every other
// retrieval surface so they cannot drift apart.
const AI_STEP_KB_TOP_K = 6;      // mirrors appStudio/aiRuntime.groundWithKB's default
const MAX_AI_STEP_KB_IDS = 10;   // mirrors appStudio/aiRuntime.MAX_KB_IDS

/**
 * Narrow a step's knowledgeBaseIds down to the ones the AUTOMATION OWNER
 * (ctx.userId, in ctx.orgId) may actually read.
 *
 * The decision itself lives in `core/kb/kbVisibility`, which is where every
 * other retrieval surface now asks it. Sharing the function is the point: this
 * one used to pass `isOrgAdmin` through, so an automation owned by an org admin
 * ground itself on any base in the organisation — including a colleague's
 * unfinished draft — and the run log said the automation had read it. The admin
 * bypass belongs to a management screen, not to a retrieval.
 *
 * A foreign or stale id is DROPPED with a warning, never thrown: one bad id in
 * the list must not fail the whole step, and it must never silently be
 * searched either.
 */
async function resolveAllowedKnowledgeBaseIds(kbIds, ctx) {
    const list = Array.isArray(kbIds)
        ? [...new Set(kbIds.filter((id) => typeof id === 'string' && id))].slice(0, MAX_AI_STEP_KB_IDS)
        : [];
    if (!list.length) return [];
    const { filterKbIdsForUser } = require('../kb/kbVisibility');
    return filterKbIdsForUser(list, {
        userId: ctx.userId,
        // Always a Set. `canUserAccessKB` reads a null as super-admin, and a
        // scheduled run has no request to fall back on.
        orgIds: ctx.orgId ? new Set([ctx.orgId]) : new Set(),
        userGroups: Array.isArray(ctx.userGroupIds) ? ctx.userGroupIds : [],
        context: 'automation_ai_step',
    });
}


/**
 * Personal memory grounding for an ai_step (`step.useMemory === true`).
 *
 * Searches the AUTOMATION OWNER's user_memories (ctx.userId — an automation has no
 * app-level owner) with the step's interpolated prompt and returns the same
 * "## Active Memory" block chat agents receive, scrubbed of literal PII by the
 * read-time guard. Everything is best-effort: no memories, a store error, or a
 * scrub failure all collapse to '' so the step runs exactly as it did before
 * the flag existed. Never runs for dry-run-only concerns: reads are harmless,
 * so dry runs ground too — that is how the builder sees what the model sees.
 */
async function groundAiStepWithMemory(step, ctx, promptText, deps) {
    if (step?.useMemory !== true || !ctx?.userId) return '';
    try {
        // The same gate chat uses: user switch, org switch. There is no chat, so
        // no per-chat flags; the automation owner's own switch still applies.
        const policy = await deps.resolveMemoryPolicy({ userId: ctx.userId, orgId: ctx.orgId || null });
        if (!policy.read) {
            log.info(`[AutomationRunner] ai_step memory grounding skipped (${policy.reason})`);
            return '';
        }
        const memoryStore = deps.memoryStore();
        const mems = await memoryStore.findRelevantMemories(ctx.userId, null, String(promptText || step.prompt || '').slice(0, 2000), 400, null, { includeGeneral: true, includeSensitive: policy.sensitive === true });
        if (!Array.isArray(mems) || mems.length === 0) return '';
        let block = memoryStore.formatMemoriesForPrompt(mems);
        if (!block) return '';
        try {
            // Gated exactly like the chat paths: scrub when the org's Privacy
            // Shield is on or PII detection is enabled globally.
            const orgShield = ctx.orgShield
                || (ctx.orgId ? await deps.configStore().getConfig(`org_privacy_shield_${ctx.orgId}`) : null);
            const scrubEnabled = !!orgShield?.enabled || !!(await deps.aiAgent().getAIConfig())?.piiDetectionEnabled;
            if (scrubEnabled) {
                const { scrubMemoryContext } = deps.scrubMemoryContext();
                // Returns { scrubbed, replacedCategories } — not the string.
                const result = await scrubMemoryContext(block, orgShield);
                if (result?.replacedCategories?.length > 0) block = result.scrubbed;
            }
        } catch (err) { log.debug('fail-open: the unscrubbed block is still the owner\'s own data', err); }
        return block ? `\n\n${block}` : '';
    } catch (e) {
        log.warn(`[AutomationRunner] ai_step memory grounding skipped: ${e.message}`);
        return '';
    }
}

/**
 * Search this step's grounded knowledge bases and return a context block to
 * inject into the system prompt (empty when nothing qualifies).
 *
 * Dry-run SKIPS the search entirely — no permission lookups, no live call —
 * mirroring execIntegrationAction's dry-run special-casing: a builder preview
 * must never pay for (or depend on) a real retrieval. Never throws: a broken
 * search stack degrades to "no grounding" rather than failing the step.
 */
async function groundAiStepWithKB(step, ctx, query, mode, kbIds = null, deps) {
    if (mode === 'dry_run') return { context: '', chunks: [] };
    // De lijst komt van de aanroeper: op een agent-stap is dat de UNIE van de
    // banken van de stap en die van de agent (aiStepAgent.knowledgeBaseIdsForStep),
    // en die hele unie gaat door dezelfde per-vrager-filter hieronder — anders
    // leest een automation-eigenaar via de agent van een collega mee in banken die
    // hij zelf niet mag zien. Zonder lijst blijft het de stap zijn eigen banken.
    const ids = Array.isArray(kbIds) ? kbIds : (Array.isArray(step.knowledgeBaseIds) ? step.knowledgeBaseIds : []);
    if (!ids.length) return { context: '', chunks: [] };
    try {
        const allowedKbIds = await resolveAllowedKnowledgeBaseIds(ids, ctx);
        if (!allowedKbIds.length) return { context: '', chunks: [] };
        const { quickKBSearch } = deps.knowledgeSearch();
        const chunks = await quickKBSearch(ctx.userId, allowedKbIds, query, { topK: AI_STEP_KB_TOP_K });
        if (!chunks || !chunks.length) return { context: '', chunks: [] };
        const context = chunks.map((c, i) => `[[${i + 1}]] ${c.title || 'KB'}\n${c.content || ''}`).join('\n\n');
        return { context, chunks };
    } catch (e) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: KB grounding failed (${e.message}) — continuing without it`);
        return { context: '', chunks: [] };
    }
}

/**
 * Skill-injectie voor een AI-stap (R2).
 *
 * De stap-skills gaan als `attached` mee en de skills van de agent als
 * `session`: `mergeSkillIds` houdt attached vooraan en kapt daarna af op de
 * cap, dus de skill die de auteur op DEZE stap koos is leidend — in volgorde
 * én in de cap — zonder dat de gedeelde functie iets hoeft te weten van
 * automations.
 *
 * `orgId` is de tenantgrens van `getSkillsByIds`: zonder org geeft
 * `buildSkillInjection` stil niets terug, en dat "stil" is precies het soort
 * ding dat je een halve dag kost — daarom wordt het hier hardop gezegd.
 * Alles is best-effort: een kapotte skill-lookup mag een stap niet omleggen.
 */
async function groundAiStepWithSkills(step, ctx, binding, preloadedSkills = null, deps) {
    const empty = { systemPromptAddendum: '', tools: [], startsAutomations: false };
    const { skillIdsForStep } = deps.aiStepAgent();
    const { attachedSkillIds, sessionSkillIds } = skillIdsForStep(step, binding);
    if (!attachedSkillIds.length && !sessionSkillIds.length) return empty;
    if (!ctx.orgId) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: skills skipped — this run has no organisation context`);
        return empty;
    }
    try {
        const { buildSkillInjection } = deps.skillInjection();
        const injection = await buildSkillInjection({
            attachedSkillIds,
            sessionSkillIds,
            orgId: ctx.orgId,
            // De VRAGER is de automation-eigenaar: een persoonlijke skill van de
            // agent-eigenaar valt daarmee vanzelf weg (stores/skillStore.js).
            userId: ctx.userId,
            agentId: binding ? binding.agentId : null,
            // De "laatst gebruikt"-rij hoort bij deze automatisering, niet bij een chat.
            conversationId: ctx.automationId || null,
            // Handoff 5: the rows execAi already loaded (aiStepSkills), in
            // run order, so the leading skill also comes first in the prompt.
            ...(Array.isArray(preloadedSkills) ? { preloadedSkills } : {}),
        });
        return {
            systemPromptAddendum: injection.systemPromptAddendum || '',
            tools: Array.isArray(injection.tools) ? injection.tools : [],
            // Draagt `activate_skill` hier een AUTOMATION-START? Een skill met een
            // `automationId` heeft geen tekstbody: `executeActivateSkill` draait
            // `executeAutomation(..., mode: 'live')`. Dat is dezelfde handeling
            // waar `startAutomations` over gaat, dus die schakelaar beslist
            // erover — anders krijgt een stap met alle drie de permissies UIT
            // toch een tool waarmee het model een automatisering live start.
            startsAutomations: Array.isArray(injection.automationSkillIds)
                ? injection.automationSkillIds.length > 0
                // Een oudere (of gestubde) injectie zegt het niet. Onbekend
                // versmalt: dan telt de tool als automation-starter.
                : true,
        };
    } catch (e) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: skill injection failed (${e.message}) — continuing without it`);
        return empty;
    }
}

module.exports = {
    AI_STEP_KB_TOP_K,
    MAX_AI_STEP_KB_IDS,
    resolveAllowedKnowledgeBaseIds,
    groundAiStepWithMemory,
    groundAiStepWithKB,
    groundAiStepWithSkills,
};
