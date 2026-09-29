/**
 * Direct Chat — the Flow-tier per-stage model swap.
 *
 * When the planner declared a `tier` for a stage, this swaps the turn's
 * modelId/config/adapter/apiKey/apiUrl to that tier for the duration of that
 * stage's LLM rounds; a stage without a tier inherits whatever is loaded.
 * Called after each `activate_session_skill`, and once before the first round,
 * so a step-1 stage already runs on its requested model. Moved verbatim out of
 * streamTurn.js; the handler's `let` bindings are now the TurnState's fields.
 */

const { describeStepMachineState } = require('../../../core/tools/sessionSkillRuntime');
const { resolveModelForTier } = require('../../../core/llm/modelResolver');
const { getProviderForModel } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const log = require('../../../telemetry/log');

async function swapModelForActiveStage(turn) {
    const { send, userId } = turn;
    if (!turn.isStandardTier || !Array.isArray(turn.sessionSkills) || turn.sessionSkills.length === 0) return;
    const state = describeStepMachineState(turn.sessionSkills, turn.activatedSessionSkillIds, turn.completedSessionSkillIds);
    const stageId = state.currentActiveId;
    if (!stageId || stageId === turn.activeStageModelStageId) return;
    turn.activeStageModelStageId = stageId;
    const stage = turn.sessionSkills.find(s => s.id === stageId);
    const stageTier = stage?.tier;
    if (!stageTier) return;   // inherit current model
    // Auto: classify based on what this stage actually demands. We
    // already have the planner's plain-language description/instructions
    // — feed that to the same classifier auto uses for the conversation.
    let targetTier = stageTier;
    if (stageTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../../core/llm/promptClassifier');
            const classifyTiers = Object.fromEntries(
                Object.entries(turn.tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'standard' && k !== 'swarm')
            );
            const seed = [stage.name, stage.description, stage.instructions].filter(Boolean).join('\n\n');
            const result = await classifyWithLLM(seed, classifyTiers, { userOrgId: turn.userOrgForTiers, userId });
            targetTier = result?.tier || turn.resolvedTier;
        } catch (e) {
            targetTier = turn.resolvedTier;
        }
    }
    let stageModelId;
    try {
        stageModelId = await resolveModelForTier(`tier:${targetTier}`, {
            userOrgId: turn.userOrgForTiers, userId, fallbackTier: turn.resolvedTier,
        });
    } catch (e) {
        log.warn(`[DirectChat] Stage tier "${stageTier}" resolution failed for "${stage.name}": ${e.message}`);
        return;
    }
    if (!stageModelId || stageModelId === turn.modelId) return;
    try {
        const newConfig = await getProviderForModel(stageModelId);
        const newAdapter = getAdapter(newConfig.providerType, (newConfig.url || '').replace(/\/+$/, ''));
        turn.modelId = stageModelId;
        turn.config = newConfig;
        turn.adapter = newAdapter;
        turn.apiKey = newConfig.apiKey;
        turn.apiUrl = (newConfig.url || '').replace(/\/+$/, '');
        log.info(`[DirectChat] Stage "${stage.name}" → ${stageTier}${stageTier !== targetTier ? `→${targetTier}` : ''} tier (${turn.modelId})`);
        send('stage_model_swapped', { stageId, stageName: stage.name, tier: targetTier, modelId: turn.modelId });
    } catch (e) {
        log.warn(`[DirectChat] Stage model swap to "${stageModelId}" failed: ${e.message}`);
    }
}

module.exports = { swapModelForActiveStage };
