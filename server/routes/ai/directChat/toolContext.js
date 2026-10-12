/**
 * Direct Chat — the context ./toolExec runs a tool call with.
 *
 * The getters and setters are toolExec's contract, not a convenience: they
 * point at the TurnState so a tool sees the live turn (the model id is
 * reassigned mid-call by the Flow stage swap). getTierToolParams memoizes the
 * per-tool-call config read for the rest of the request. Moved verbatim out
 * of streamTurn.js.
 */

const configStore = require('../../../stores/configStore');
const { makeTierToolParamsGetter } = require('./toolExec');
const { handleSessionSkillCompleteResult } = require('./stepMachine');

function createToolContextFactory(turn) {
    const getTierToolParams = makeTierToolParamsGetter(configStore);
    return ({ userAuth, streamed }) => ({
        streamed, userAuth,
        convId: turn.convId, resolvedTier: turn.resolvedTier, userOrgId: turn.userOrgId, userId: turn.userId,
        n8nOrgId: turn.n8nOrgId, req: turn.req,
        regexConfig: turn.regexConfig, webSearchGuardPiiCategories: turn.webSearchGuardPiiCategories,
        webSearchGuardEnabled: turn.webSearchGuardEnabled,
        // The resolved shield, for its tool block lists (core/privacy/toolPiiGate.js).
        orgShield: turn.orgShield,
        imageGenSettings: turn.imageGenSettings, nanoBananaSettings: turn.nanoBananaSettings,
        attachments: turn.attachments, timezone: turn.timezone,
        sessionSkills: turn.sessionSkills, webpageBuilderReadSlots: turn.webpageBuilderReadSlots,
        collectedToolHistory: turn.collectedToolHistory,
        // The documents the chat model may touch this turn (core/documents/aiDocumentScope.js).
        documentScope: turn.documentScope,
        notebookWriteGate: turn.notebookWriteGate,
        getModelId: () => turn.modelId,
        getActivatedSessionSkillIds: () => turn.activatedSessionSkillIds,
        setActivatedSessionSkillIds: (ids) => { turn.activatedSessionSkillIds = ids; },
        getCompletedSessionSkillIds: () => turn.completedSessionSkillIds,
        getRoundsInCurrentStep: () => turn.roundsInCurrentStep,
        setRoundsInCurrentStep: (n) => { turn.roundsInCurrentStep = n; },
        markWebpagePlanProposed: () => { turn.webpagePlanProposedThisTurn = true; },
        onImageGenerated: (data) => turn.generatedImages.push(data),
        send: turn.send,
        applyLoadTools: turn.applyLoadTools,
        swapModelForActiveStage: turn.swapModelForActiveStage,
        handleSessionSkillCompleteResult: (toolArgs, toolResult) => handleSessionSkillCompleteResult(turn, toolArgs, toolResult),
        getTierToolParams,
        onSkillsActivated: turn.onSkillsActivated,
    });
}

module.exports = { createToolContextFactory };
