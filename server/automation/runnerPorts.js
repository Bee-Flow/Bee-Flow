/**
 * The automation feature's side of core/automationRunner/featurePorts.js: the
 * capabilities core's runner (and meeting notes, for the trigger bus) call in
 * automation/ without requiring it.
 *
 * Loaded at boot by boot/featureRegistrations.js. Every require is lazy, as
 * it was at the call sites in core, so loading this file costs nothing and a
 * test's require.cache stub of a module below is what a call reaches.
 */

'use strict';

const { registerRunnerPorts } = require('../core/automationRunner/featurePorts');

const approvalEvents = () => require('./approvalEvents');
const approvalNotify = () => require('./approvalNotify');
const approvalDelivery = () => require('./approvalDelivery');
const triggerBus = () => require('./triggerBus');
const formQueue = () => require('./formQueue');
const codeSandbox = () => require('./codeSandbox');
const automationGraph = () => require('./automationGraph');
const runOutcome = () => require('./runOutcome');
const toolRegistry = () => require('./toolRegistry');
const formTriggerContract = () => require('./formTriggerContract');

registerRunnerPorts({
    approvals: {
        projectStamp: (...args) => require('./approvalProject').projectStamp(...args),
        dispatchApprovalRequested: (...args) => approvalEvents().dispatchApprovalRequested(...args),
        dispatchApprovalDecided: (...args) => approvalEvents().dispatchApprovalDecided(...args),
        runOnDecidedHook: (...args) => require('./approvalHooks').runOnDecidedHook(...args),
        notifyApproval: (...args) => approvalNotify().notifyApproval(...args),
        automationForApproval: (...args) => approvalNotify().automationForApproval(...args),
        pollTalkReactions: (...args) => require('./approvalReactionIngest').pollTalkReactions(...args),
        // Run notifications: the Talk room and card, and the approval card.
        resolveNcContext: (...args) => approvalDelivery().resolveNcContext(...args),
        resolveTalkRoom: (...args) => approvalDelivery().resolveTalkRoom(...args),
        postTalkCard: (...args) => approvalDelivery().postTalkCard(...args),
        deliverApprovalToNextcloud: (...args) => approvalDelivery().deliverApprovalToNextcloud(...args),
    },
    triggerBus: {
        runPollingPass: (...args) => triggerBus().runPollingPass(...args),
        renewExpiringSubscriptions: (...args) => triggerBus().renewExpiringSubscriptions(...args),
        // core/meetingNotes: background Nextcloud auth, the meeting.processed event,
        // and the matcher its usage list shares with the bus.
        loadSession: (...args) => triggerBus().loadSession(...args),
        dispatchEvent: (...args) => triggerBus().dispatchEvent(...args),
        pickMatcher: (...args) => require('./triggerBus/filters').pickMatcher(...args),
    },
    formQueue: {
        recoverPending: (...args) => formQueue().recoverPending(...args),
        stop: (...args) => formQueue().stop(...args),
    },
    evolution: {
        evaluateCanaries: (...args) => require('./evolution').evaluateCanaries(...args),
    },
    codeSandbox: {
        isAvailable: (...args) => codeSandbox().isAvailable(...args),
        loadError: (...args) => codeSandbox().loadError(...args),
        runCode: (...args) => codeSandbox().runCode(...args),
        defaultFetchHttp: (...args) => codeSandbox().defaultFetchHttp(...args),
        secretsNotConfiguredMessage: () => codeSandbox().SECRETS_NOT_CONFIGURED_MESSAGE,
    },
    outputSchemas: {
        synthesizeDryRunOutput: (...args) => require('./outputSchemas').synthesizeDryRunOutput(...args),
    },
    shapeCache: {
        recordShape: (...args) => require('./shapeCache').recordShape(...args),
    },
    summarise: {
        summariseDefinition: (...args) => require('./summarise').summariseDefinition(...args),
    },
    forms: {
        renderFormConfig: (...args) => formTriggerContract().renderFormConfig(...args),
        maxRenderedDescriptionLen: () => formTriggerContract().MAX_RENDERED_DESCRIPTION_LEN,
    },
    automationGraph: {
        walkSteps: (...args) => automationGraph().walkSteps(...args),
        isAiStep: (...args) => automationGraph().isAiStep(...args),
        generatingStepsDownstreamOfAi: (...args) => automationGraph().generatingStepsDownstreamOfAi(...args),
    },
    runOutcome: {
        resolveRunOutcome: (...args) => runOutcome().resolveRunOutcome(...args),
        storeOutcomeDeps: (...args) => runOutcome().storeOutcomeDeps(...args),
    },
    stepTypes: {
        isBuiltinStepType: (...args) => require('./builtinStepTools').isBuiltinStepType(...args),
    },
    toolRegistry: {
        availabilityFor: (...args) => toolRegistry().availabilityFor(...args),
        allToolApps: () => toolRegistry().ALL_TOOL_APPS,
    },
});
