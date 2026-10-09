// @typecheck
// User store for app passwords, user management, and groups
// PostgreSQL-backed with envelope encryption
//
// Facade: the implementation lives in ./user/* aggregates behind this stable
// path — every require('../stores/userStore') caller is unchanged. Each
// aggregate exports its public functions; this file re-exports the same
// references under the identical surface this file had before the split.
// Require order matters: schema first (initDB + JSON migration boot side
// effects), then groups before roles, mirroring the original file.

require('./user/schema');
const {
    getAllUsers, getAllUserAvatars, getUserAvatarsByIds, getOrgMembersForDirectory,
    getUser, getUserByEmail, getUserByPasswordResetToken, getUserByEmailVerificationToken,
    createUser, updateUser, deleteUser, getUserByNcUid, findOrgMemberIdByEmail,
    createUserWithSeatCheck, SeatCapExceededError, touchLastSeen,
} = require('./user/users');
const {
    getAllOrganizations, getSingleOrgId, hasAnyOrganization, getOrganization, getOrganizationByNcInstanceId,
    createOrganization, updateOrganization, deleteOrganization,
    findUnboundOrgByEmailDomain,
    getOrgEnabledIntegrations, setOrgEnabledIntegrations, getOrgEnabledBetaFeatures, setOrgEnabledBetaFeatures,
    getOrgGrantedCapabilities, setOrgGrantedCapabilities,
    getOrgAvailableCapabilities, setOrgAvailableCapabilities,
    getOrgBetaEveryone, setOrgBetaEveryone,
    getOrgEveryoneRevoked, setOrgEveryoneRevoked,
    backfillAutoProvisionedNcOrgNames,
} = require('./user/organizations');
const {
    createPendingNcBinding, getPendingNcBinding, getPendingNcBindingForOrg,
    createPendingNcVerification, verifyPendingNcCode, resetNcVerificationCode,
    retargetNcVerification, countActivePendingNcVerificationsForOrg,
    createOrgPairingCode, getPendingBindingByPairingCode, consumePairingCode,
    getActivePairingCodesForOrg, deletePairingCode,
    countActivePendingNcBindingsForOrg, markPendingNcBindingApproved,
    markPendingNcBindingDenied, expirePendingNcBindings,
} = require('./user/ncBindings');
const {
    getAllGroups, getGroup, createGroup, updateGroup, deleteGroup, getGroupByAzureId, getUserByAzureId,
} = require('./user/groups');
const {
    storeAppPassword, getAppPassword, hasAppPassword, deleteAppPassword,
} = require('./user/appPasswords');
const {
    listSecurityKeys, addSecurityKey, renameSecurityKey, deleteSecurityKey,
    deleteAllSecurityKeys, recordSecurityKeyUse,
} = require('./user/securityKeys');
const {
    getAllRoles, createRole, updateRole, deleteRole,
} = require('./user/roles');
const {
    getAllPlans, getPlan, getDefaultNcPlan, createPlan, updatePlan, deletePlan,
    PlanInUseError,
} = require('./user/plans');
const {
    getAllOrgSubscriptions, getOrgSubscription, setOrgSubscription, deleteOrgSubscription,
    getEffectiveLimits, getActiveSeatCount, getBillingPeriod,
    getConsumerSubscription, setConsumerSubscription, deleteConsumerSubscription, getAllConsumerSubscriptions,
    isManualOverrideActive,
    setOrgSubscriptionRespectingOverride, setConsumerSubscriptionRespectingOverride,
    setOrgSubscriptionWithLock,
    findSubscriptionByStripeCustomerId, clearStripeCustomerIdForOrg, clearStripeCustomerIdForConsumer,
} = require('./user/subscriptions');
const {
    markTrialUsed, hasOrgUsedTrial, hasUserUsedTrial,
    hasEmailUsedTrial, recordTrialHistory, backfillTrialHistory,
} = require('./user/trials');
const {
    logSubscriptionAudit, getAuditLog, getUnresolvedLicenseIssuanceFailures,
    logAccessAudit, getAccessAuditLog, countAccessAuditLog, listAccessAuditActions, claimNotification,
} = require('./user/audit');
const {
    recordConsentAcceptance, getConsentAcceptances, listConsentAcceptances,
    getConsentSummary, setConsentSummary,
    getOptionalConsents, setOptionalConsents,
} = require('./user/consent');
const {
    claimNotificationSlot, getDunningCounts,
    recordStripeEventProcessed, releaseStripeEventProcessed,
    recordPaymentFailureForOrg, recordPaymentFailureForConsumer,
    resetPaymentFailureForOrg, resetPaymentFailureForConsumer,
    suspendPastDueSubscriptions, expireOverdueTrials, cancelStaleIncompleteSubscriptions,
    getDefaultOrgPlanId, downgradeOrgToFreePlan,
} = require('./user/billingLifecycle');

module.exports = {
    getAllUsers, getAllUserAvatars, getUserAvatarsByIds, getOrgMembersForDirectory, getUser, getUserByEmail, getUserByPasswordResetToken, getUserByEmailVerificationToken, createUser, updateUser, deleteUser,
    createUserWithSeatCheck, SeatCapExceededError, PlanInUseError, touchLastSeen,
    getAllOrganizations, getSingleOrgId, hasAnyOrganization, getOrganization, getOrganizationByNcInstanceId, createOrganization, updateOrganization, deleteOrganization,
    findUnboundOrgByEmailDomain,
    getOrgEnabledIntegrations, setOrgEnabledIntegrations, getOrgEnabledBetaFeatures, setOrgEnabledBetaFeatures,
    getOrgGrantedCapabilities, setOrgGrantedCapabilities,
    getOrgAvailableCapabilities, setOrgAvailableCapabilities,
    getOrgBetaEveryone, setOrgBetaEveryone,
    getOrgEveryoneRevoked, setOrgEveryoneRevoked,
    getUserByNcUid,
    findOrgMemberIdByEmail,
    createPendingNcBinding, getPendingNcBinding, getPendingNcBindingForOrg,
    createPendingNcVerification, verifyPendingNcCode, resetNcVerificationCode,
    retargetNcVerification, countActivePendingNcVerificationsForOrg,
    createOrgPairingCode, getPendingBindingByPairingCode, consumePairingCode,
    getActivePairingCodesForOrg, deletePairingCode,
    countActivePendingNcBindingsForOrg, markPendingNcBindingApproved,
    markPendingNcBindingDenied, expirePendingNcBindings,
    getAllGroups, getGroup, createGroup, updateGroup, deleteGroup, getGroupByAzureId, getUserByAzureId,
    storeAppPassword, getAppPassword, hasAppPassword, deleteAppPassword,
    listSecurityKeys, addSecurityKey, renameSecurityKey, deleteSecurityKey,
    deleteAllSecurityKeys, recordSecurityKeyUse,
    getAllRoles, createRole, updateRole, deleteRole,
    getAllPlans, getPlan, getDefaultNcPlan, createPlan, updatePlan, deletePlan,
    getAllOrgSubscriptions, getOrgSubscription, setOrgSubscription, deleteOrgSubscription, getEffectiveLimits, getActiveSeatCount,
    getConsumerSubscription, setConsumerSubscription, deleteConsumerSubscription, getAllConsumerSubscriptions,
    getBillingPeriod, logSubscriptionAudit, getAuditLog, getUnresolvedLicenseIssuanceFailures,
    logAccessAudit, getAccessAuditLog, countAccessAuditLog, listAccessAuditActions, claimNotification,
    recordConsentAcceptance, getConsentAcceptances, listConsentAcceptances, getConsentSummary, setConsentSummary,
    getOptionalConsents, setOptionalConsents,
    markTrialUsed, hasOrgUsedTrial, hasUserUsedTrial,
    hasEmailUsedTrial, recordTrialHistory, backfillTrialHistory, backfillAutoProvisionedNcOrgNames,
    recordStripeEventProcessed,
    releaseStripeEventProcessed,
    recordPaymentFailureForOrg, recordPaymentFailureForConsumer,
    resetPaymentFailureForOrg, resetPaymentFailureForConsumer,
    suspendPastDueSubscriptions, expireOverdueTrials, cancelStaleIncompleteSubscriptions,
    getDefaultOrgPlanId, downgradeOrgToFreePlan,
    findSubscriptionByStripeCustomerId, clearStripeCustomerIdForOrg, clearStripeCustomerIdForConsumer,
    isManualOverrideActive,
    setOrgSubscriptionRespectingOverride, setConsumerSubscriptionRespectingOverride,
    setOrgSubscriptionWithLock,
    claimNotificationSlot, getDunningCounts,
};

// Facade: het schema woont in user/schema.js — migrateDb wacht dáárop.
module.exports.initDB = require('./user/schema').initDB;
