/**
 * Direct Chat — the session-skill step machine that walks a Flow pipeline.
 *
 * Completion is explicit: the LLM calls `complete_session_skill` to advance,
 * and until the terminal steps are done its text deltas are muted so it
 * cannot smuggle a final answer out of a mid-pipeline round. The guard this
 * computes is written onto the per-turn volatile block by the caller, never
 * onto the cached system prefix. Moved verbatim out of streamTurn.js.
 */

const {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    COMPLETE_SESSION_SKILL_TOOL_NAME,
    describeStepMachineState,
} = require('../../../core/tools/sessionSkillRuntime');
const log = require('../../../telemetry/log');

// Rounds a step may run tools without completing before the guard forces
// `complete_session_skill`.
const SOFT_COMPLETE_CAP = 3;

// Provider-specific tool_choice shape. OpenAI/Mistral expect the
// nested form; our Claude adapter consumes a flat {name}; Google's
// adapter doesn't support specific-function — fall back to 'required'.
function specificToolChoice(turn, toolName) {
    const pt = (turn.config?.providerType || '').toLowerCase();
    if (pt === 'claude') return { name: toolName };
    if (pt === 'google' || pt === 'gemini') return 'required';
    return { type: 'function', function: { name: toolName } };
}

/**
 * State table:
 *   - no pipeline / all terminals completed  →  'auto' (final answer)
 *   - nothing active, ready step exists      →  force activate(next-ready)
 *   - step active, not completed             →  'auto' (integration tools)
 *   - step active, >=N rounds w/o complete   →  force complete(current)
 */
function computeStepMachineGuard(turn) {
    const { sessionSkills, activatedSessionSkillIds, completedSessionSkillIds, roundsInCurrentStep } = turn;
    if (!turn.isStandardTier) return { toolChoice: 'auto', systemAppend: null, mode: 'auto', mute: false };
    const state = describeStepMachineState(sessionSkills, activatedSessionSkillIds, completedSessionSkillIds);
    if (!state.hasPipeline || state.allTerminalsCompleted) {
        return { toolChoice: 'auto', systemAppend: null, mode: 'final', mute: false };
    }
    const byId = new Map(sessionSkills.map(s => [s.id, s]));

    // A step is mid-work — the LLM should be using integration tools
    // and then calling complete_session_skill. If it keeps firing
    // tools without completing, force the completion after the cap.
    if (state.currentActiveId) {
        const activeName = byId.get(state.currentActiveId)?.name || state.currentActiveId;
        if (roundsInCurrentStep >= SOFT_COMPLETE_CAP) {
            return {
                toolChoice: specificToolChoice(turn, COMPLETE_SESSION_SKILL_TOOL_NAME),
                systemAppend: `\n\n[PIPELINE GUARD] Step "${activeName}" has run ${roundsInCurrentStep} tool-call rounds without completing. Your NEXT call MUST be \`${COMPLETE_SESSION_SKILL_TOOL_NAME}\` with \`{ skill_id: "${state.currentActiveId}", summary: "<what this step produced>" }\` so the pipeline can advance.`,
                mode: `forced-complete:${state.currentActiveId}`,
                mute: true,
            };
        }
        // Auto tool_choice — let the LLM pick integration tools for
        // this step's work. Text deltas still muted (pipeline not done).
        return { toolChoice: 'auto', systemAppend: null, mode: `active:${state.currentActiveId}`, mute: true };
    }

    // Nothing active — force activation of the next ready step.
    if (state.nextReadyId) {
        const readyName = byId.get(state.nextReadyId)?.name || state.nextReadyId;
        return {
            toolChoice: specificToolChoice(turn, ACTIVATE_SESSION_SKILL_TOOL_NAME),
            systemAppend: `\n\n[PIPELINE GUARD] No step currently active. Your NEXT call MUST be \`${ACTIVATE_SESSION_SKILL_TOOL_NAME}\` with skill_ids=["${state.nextReadyId}"] (${readyName}) before any other tool.`,
            mode: `forced-activate:${state.nextReadyId}`,
            mute: true,
        };
    }

    // Pipeline exists but no active + no ready (e.g. all activated,
    // completion pending for terminal). Force complete on the last
    // activated-not-completed skill; fall back to 'auto' if we can't
    // identify one (shouldn't happen in practice).
    return { toolChoice: 'required', systemAppend: null, mode: 'required', mute: true };
}

// True while the step machine still has work to do — used by the
// streamed-tool while loop to force another round when the LLM
// stopped emitting tool calls mid-pipeline (text was muted, so
// without this the user would see an empty reply).
function pipelineNeedsWrapUp(turn) {
    const { sessionSkills, activatedSessionSkillIds, completedSessionSkillIds } = turn;
    if (!turn.isStandardTier) return false;
    if (!Array.isArray(sessionSkills) || sessionSkills.length === 0) return false;
    const state = describeStepMachineState(sessionSkills, activatedSessionSkillIds, completedSessionSkillIds);
    return state.hasPipeline && !state.allTerminalsCompleted;
}

// Shared side-effect handler for when the LLM calls complete_session_skill.
// Both the pre-check path and the streamed-tool path invoke this so the
// completion set + UI event stay in sync no matter which adapter fired.
function handleSessionSkillCompleteResult(turn, toolArgs, toolResult) {
    const { send, sessionSkills } = turn;
    if (!toolResult?.success) return;
    if (Array.isArray(toolResult.completedSessionSkillIds)) {
        turn.completedSessionSkillIds = Array.from(new Set(toolResult.completedSessionSkillIds));
    } else if (toolResult.skill_id) {
        turn.completedSessionSkillIds = Array.from(new Set([...turn.completedSessionSkillIds, toolResult.skill_id]));
    }
    const skillId = toolResult.skill_id || toolArgs?.skill_id;
    const skill = sessionSkills.find(s => s.id === skillId);
    const entry = {
        skillId,
        skillName: skill?.name || skillId,
        summary: toolResult.summary || toolArgs?.summary || '',
        order: skill?.order || null,
        total: sessionSkills.length,
        at: Date.now(),
    };
    turn.sessionSkillsCompletions = [...turn.sessionSkillsCompletions, entry];
    turn.roundsInCurrentStep = 0;
    send('session_skill_completed', entry);
    send('session_skills_updated', {
        skills: sessionSkills,
        activatedSkillIds: turn.activatedSessionSkillIds,
        completedSkillIds: turn.completedSessionSkillIds,
    });
}

// Try the adapter call; if the provider rejects due to
// invalid_request_message_order or similar bad-shape 400s, retry once
// with toolChoice: 'auto' to unblock the user.
async function callAdapterWithFallback(fn, currentToolChoice) {
    try {
        return await fn(currentToolChoice);
    } catch (err) {
        const msg = String(err?.message || '');
        const isBadShape = /invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(msg);
        if (!isBadShape) throw err;
        log.warn(`[DirectChat pipeline] Adapter rejected toolChoice — retrying with 'auto'. Original: ${msg}`);
        return await fn('auto');
    }
}

module.exports = {
    computeStepMachineGuard,
    pipelineNeedsWrapUp,
    handleSessionSkillCompleteResult,
    callAdapterWithFallback,
};
