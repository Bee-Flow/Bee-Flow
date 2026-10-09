// @typecheck
/**
 * Automation Store — PostgreSQL-backed automation definitions, runs, and triggers.
 *
 * §WS5 facade: the implementation lives in ./automationStore/* aggregates behind
 * this stable path (migrateDb.js + every require('../stores/automationStore')
 * caller is unchanged). Each aggregate re-exports its public functions; this file
 * spreads them into the identical module.exports surface this file had before.
 */

const core = require('./automationStore/core');
const { rowToRunStep, fromJsonb } = require('./automationStore/rowMappers');

module.exports = {
    initDB: core.initDB,
    ...require('./automationStore/automations'),
    ...require('./automationStore/builderSessions'),
    ...require('./automationStore/versions'),
    ...require('./automationStore/evolutions'),
    ...require('./automationStore/steps'),
    ...require('./automationStore/runs'),
    // Full copies of step outputs the run history truncated (BFSF-435).
    ...require('./automationStore/runFullOutputs'),
    ...require('./automationStore/webhooks'),
    ...require('./automationStore/forms'),
    ...require('./automationStore/generatedFiles'),
    ...require('./automationStore/approvals'),
    ...require('./automationStore/approvalDeliveries'),
    ...require('./automationStore/folders'),
    ...require('./automationStore/subscriptions'),
    // Additional schedule triggers (automation_schedules, 2026-09).
    ...require('./automationStore/schedules'),
    // Handoff 5: publish (working copy → live), the trash, per-automation run
    // retention. Only the instance functions; the SQL constants stay module-level.
    publishWorkingCopy: require('./automationStore/lifecycle').publishWorkingCopy,
    countPendingChanges: require('./automationStore/lifecycle').countPendingChanges,
    trashAutomation: require('./automationStore/lifecycle').trashAutomation,
    restoreAutomation: require('./automationStore/lifecycle').restoreAutomation,
    listTrash: require('./automationStore/lifecycle').listTrash,
    listPurgeableTrash: require('./automationStore/lifecycle').listPurgeableTrash,
    purgeTrashedAutomation: require('./automationStore/lifecycle').purgeTrashedAutomation,
    deleteRunsPastAutomationRetention: require('./automationStore/lifecycle').deleteRunsPastAutomationRetention,
    // Handoff 5, sharing and roles (automation/access.js decides what a role allows).
    listSharesForAutomation: require('./automationStore/shares').listSharesForAutomation,
    replaceSharesForAutomation: require('./automationStore/shares').replaceSharesForAutomation,
    listAutomationsSharedWithUser: require('./automationStore/shares').listAutomationsSharedWithUser,
    countGroupMembers: require('./automationStore/shares').countGroupMembers,
    transferAutomationOwner: require('./automationStore/shares').transferAutomationOwner,
    // Which agents may call an agent_call automation (automation/agentBinding.js decides who may write).
    listBindingsForAutomation: require('./automationStore/agentBindings').listBindingsForAutomation,
    listAutomationsBoundToAgent: require('./automationStore/agentBindings').listAutomationsBoundToAgent,
    hasAgentBinding: require('./automationStore/agentBindings').hasAgentBinding,
    applyAgentBindings: require('./automationStore/agentBindings').applyAgentBindings,
    deleteBindingsForAgent: require('./automationStore/agentBindings').deleteBindingsForAgent,
    // Handoff 5, the Runs tab: what decorates a page of runs (automation/runListRows.js).
    getJourneyStepStatuses: require('./automationStore/runListing').getJourneyStepStatuses,
    getVersionDefinitions: require('./automationStore/runListing').getVersionDefinitions,
    getPendingApprovalIdsForRuns: require('./automationStore/runListing').getPendingApprovalIdsForRuns,
    // Handoff 5: the "send reminder" button's rate limit (one per approval per 10 minutes).
    claimApprovalReminder: require('./automationStore/approvalReminders').claimApprovalReminder,
    // Handoff 5: organisation templates ("Save as template").
    createAutomationTemplate: require('./automationStore/templates').createAutomationTemplate,
    listAutomationTemplatesFor: require('./automationStore/templates').listAutomationTemplatesFor,
    getAutomationTemplateFor: require('./automationStore/templates').getAutomationTemplateFor,
    // Exported for unit tests.
    rowToRunStep,
    fromJsonb,
};
