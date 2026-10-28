// @typecheck noImplicitAny
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
        /** @type {typeof import('../core/automationModel/approvalProject').projectStamp} */ projectStamp: (...args) => require('../core/automationModel/approvalProject').projectStamp(...args),
        /** @type {typeof import('./approvalEvents').dispatchApprovalRequested} */ dispatchApprovalRequested: (...args) => approvalEvents().dispatchApprovalRequested(...args),
        /** @type {typeof import('./approvalEvents').dispatchApprovalDecided} */ dispatchApprovalDecided: (...args) => approvalEvents().dispatchApprovalDecided(...args),
        /** @type {typeof import('./approvalHooks').runOnDecidedHook} */ runOnDecidedHook: (...args) => require('./approvalHooks').runOnDecidedHook(...args),
        /** @type {typeof import('./approvalNotify').notifyApproval} */ notifyApproval: (...args) => approvalNotify().notifyApproval(...args),
        /** @type {typeof import('./approvalNotify').automationForApproval} */ automationForApproval: (...args) => approvalNotify().automationForApproval(...args),
        /** @type {typeof import('./approvalReactionIngest').pollTalkReactions} */ pollTalkReactions: (...args) => require('./approvalReactionIngest').pollTalkReactions(...args),
        // Run notifications: the Talk room and card, and the approval card.
        /** @type {typeof import('./approvalDelivery').resolveNcContext} */ resolveNcContext: (...args) => approvalDelivery().resolveNcContext(...args),
        /** @type {typeof import('./approvalDelivery').resolveTalkRoom} */ resolveTalkRoom: (...args) => approvalDelivery().resolveTalkRoom(...args),
        /** @type {typeof import('./approvalDelivery').postTalkCard} */ postTalkCard: (...args) => approvalDelivery().postTalkCard(...args),
        /** @type {typeof import('./approvalDelivery').deliverApprovalToNextcloud} */ deliverApprovalToNextcloud: (...args) => approvalDelivery().deliverApprovalToNextcloud(...args),
    },
    triggerBus: {
        /** @type {typeof import('./triggerBus').runPollingPass} */ runPollingPass: (...args) => triggerBus().runPollingPass(...args),
        /** @type {typeof import('./triggerBus').renewExpiringSubscriptions} */ renewExpiringSubscriptions: (...args) => triggerBus().renewExpiringSubscriptions(...args),
        // core/meetingNotes: background Nextcloud auth, the meeting.processed event,
        // and the matcher its usage list shares with the bus.
        /** @type {typeof import('./triggerBus').loadSession} */ loadSession: (...args) => triggerBus().loadSession(...args),
        /** @type {typeof import('./triggerBus').dispatchEvent} */ dispatchEvent: (...args) => triggerBus().dispatchEvent(...args),
        /** @type {typeof import('./triggerBus/filters').pickMatcher} */ pickMatcher: (...args) => require('./triggerBus/filters').pickMatcher(...args),
    },
    formQueue: {
        /** @type {typeof import('./formQueue').recoverPending} */ recoverPending: (...args) => formQueue().recoverPending(...args),
        /** @type {typeof import('./formQueue').stop} */ stop: (...args) => formQueue().stop(...args),
    },
    evolution: {
        /** @type {typeof import('./evolution').evaluateCanaries} */ evaluateCanaries: (...args) => require('./evolution').evaluateCanaries(...args),
    },
    codeSandbox: {
        /** @type {typeof import('./codeSandbox').isAvailable} */ isAvailable: (...args) => codeSandbox().isAvailable(...args),
        /** @type {typeof import('./codeSandbox').loadError} */ loadError: (...args) => codeSandbox().loadError(...args),
        /** @type {typeof import('./codeSandbox').runCode} */ runCode: (...args) => codeSandbox().runCode(...args),
        /** @type {typeof import('./codeSandbox').defaultFetchHttp} */ defaultFetchHttp: (...args) => codeSandbox().defaultFetchHttp(...args),
        secretsNotConfiguredMessage: () => codeSandbox().SECRETS_NOT_CONFIGURED_MESSAGE,
    },
    outputSchemas: {
        /** @type {typeof import('./outputSchemas').synthesizeDryRunOutput} */ synthesizeDryRunOutput: (...args) => require('./outputSchemas').synthesizeDryRunOutput(...args),
        /** @type {typeof import('./outputSchemas').emptyDryRunOutput} */ emptyDryRunOutput: (...args) => require('./outputSchemas').emptyDryRunOutput(...args),
    },
    shapeCache: {
        /** @type {typeof import('./shapeCache').recordShape} */ recordShape: (...args) => require('./shapeCache').recordShape(...args),
    },
    summarise: {
        /** @type {typeof import('./summarise').summariseDefinition} */ summariseDefinition: (...args) => require('./summarise').summariseDefinition(...args),
    },
    forms: {
        /** @type {typeof import('./formTriggerContract').renderFormConfig} */ renderFormConfig: (...args) => formTriggerContract().renderFormConfig(...args),
        maxRenderedDescriptionLen: () => formTriggerContract().MAX_RENDERED_DESCRIPTION_LEN,
        /** @type {typeof import('./formTriggerContract').emptyFormValues} */ emptyFormValues: (...args) => formTriggerContract().emptyFormValues(...args),
        // A dry run that answers a page from saved answers (form scenario, golden replay).
        /** @type {typeof import('./testing/formScenarioValues').scenarioPageValues} */ scenarioPageValues: (...args) => require('./testing/formScenarioValues').scenarioPageValues(...args),
    },
    automationGraph: {
        /** @type {typeof import('./automationGraph').walkSteps} */ walkSteps: (...args) => automationGraph().walkSteps(...args),
        /** @type {typeof import('./automationGraph').isAiStep} */ isAiStep: (...args) => automationGraph().isAiStep(...args),
        /** @type {typeof import('./automationGraph').generatingStepsDownstreamOfAi} */ generatingStepsDownstreamOfAi: (...args) => automationGraph().generatingStepsDownstreamOfAi(...args),
    },
    runOutcome: {
        /** @type {typeof import('./runOutcome').resolveRunOutcome} */ resolveRunOutcome: (...args) => runOutcome().resolveRunOutcome(...args),
        /** @type {typeof import('./runOutcome').storeOutcomeDeps} */ storeOutcomeDeps: (...args) => runOutcome().storeOutcomeDeps(...args),
    },
    stepTypes: {
        /** @type {typeof import('./builtinStepTools').isBuiltinStepType} */ isBuiltinStepType: (...args) => require('./builtinStepTools').isBuiltinStepType(...args),
    },
    toolRegistry: {
        /** @type {typeof import('./toolRegistry').availabilityFor} */ availabilityFor: (...args) => toolRegistry().availabilityFor(...args),
        allToolApps: () => toolRegistry().ALL_TOOL_APPS,
    },
});
