// @typecheck
/**
 * Support Store — PostgreSQL-backed customer-support threads + messages.
 *
 * Used by the AI-first customer-support inbox: prospects (anonymous from the
 * marketing site) and logged-in tenants raise threads that the AI auto-responder
 * attempts to resolve, escalating to Bee Flow staff when it can't.
 *
 * Tables:
 *   support_threads  — one row per conversation, with status/assignee/SLA fields
 *   support_messages — append-only message log per thread
 *
 * Uses the shared pg Pool from db.js — same pattern as notificationStore.
 *
 * Facade: the implementation lives in ./supportStore/* aggregates behind this
 * stable path, the same shape automationStore.js uses — migrateDb.js and every
 * require('../stores/supportStore') caller is unchanged. Each aggregate owns one
 * slice of the inbox; this file spreads them into the identical module.exports
 * surface this file had before the split.
 */

const schema = require('./supportStore/schema');
const requesterTokens = require('./supportStore/requesterTokens');
const threads = require('./supportStore/threads');
const messages = require('./supportStore/messages');
const audit = require('./supportStore/audit');
const tags = require('./supportStore/tags');
const sla = require('./supportStore/sla');
const cannedResponses = require('./supportStore/cannedResponses');
const csat = require('./supportStore/csat');
const autoAssignment = require('./supportStore/autoAssignment');
const insights = require('./supportStore/insights');
const issueLinks = require('./supportStore/issueLinks');

module.exports = {
    initDB: schema.initDB,
    createThread: threads.createThread,
    getThread: threads.getThread,
    listThreads: threads.listThreads,
    updateThread: threads.updateThread,
    appendMessage: messages.appendMessage,
    deleteMailboxThreads: threads.deleteMailboxThreads,
    getCompanyMailboxSummary: threads.getCompanyMailboxSummary,
    getThreadMessages: messages.getThreadMessages,
    countThreadsByStatus: threads.countThreadsByStatus,
    findSlaAtRiskThreads: sla.findSlaAtRiskThreads,
    findThreadByProviderThread: threads.findThreadByProviderThread,
    findThreadByRfcMessageId: threads.findThreadByRfcMessageId,
    buildAccessToken: requesterTokens.buildAccessToken,
    verifyAccessToken: requesterTokens.verifyAccessToken,
    firstStaffReplyTransition: threads.firstStaffReplyTransition,
    setMessageEmailStatus: messages.setMessageEmailStatus,
    setMessageDelivery: messages.setMessageDelivery,
    recordThreadEvent: audit.recordThreadEvent,
    listThreadEvents: audit.listThreadEvents,
    // iteration 6: unified audit log
    recordAuditEvent: audit.recordAuditEvent,
    listAuditEvents: audit.listAuditEvents,
    AUDIT_ACTOR_KINDS: audit.AUDIT_ACTOR_KINDS,
    // iteration 4
    setThreadTags: tags.setThreadTags,
    addThreadTag: tags.addThreadTag,
    listTags: tags.listTags,
    createTag: tags.createTag,
    deleteTag: tags.deleteTag,
    getSlaPolicy: sla.getSlaPolicy,
    listSlaPolicies: sla.listSlaPolicies,
    upsertSlaPolicy: sla.upsertSlaPolicy,
    listCannedResponses: cannedResponses.listCannedResponses,
    getCannedResponse: cannedResponses.getCannedResponse,
    createCannedResponse: cannedResponses.createCannedResponse,
    updateCannedResponse: cannedResponses.updateCannedResponse,
    deleteCannedResponse: cannedResponses.deleteCannedResponse,
    setThreadSla: sla.setThreadSla,
    buildCsatToken: requesterTokens.buildCsatToken,
    verifyCsatToken: requesterTokens.verifyCsatToken,
    setCsat: csat.setCsat,
    confirmResolution: csat.confirmResolution,
    disputeResolution: csat.disputeResolution,
    flagFirstResponseBreaches: sla.flagFirstResponseBreaches,
    flagResolutionBreaches: sla.flagResolutionBreaches,
    getAndAdvanceRoundRobin: autoAssignment.getAndAdvanceRoundRobin,
    getInsights: insights.getInsights,
    // iteration 7: ticket ↔ YouTrack issue links
    getThreadByRef: threads.getThreadByRef,
    linkIssue: issueLinks.linkIssue,
    unlinkIssue: issueLinks.unlinkIssue,
    listIssueLinks: issueLinks.listIssueLinks,
    listThreadsForIssue: issueLinks.listThreadsForIssue,
    countThreadsPerIssue: issueLinks.countThreadsPerIssue,
    listDistinctLinkedIssues: issueLinks.listDistinctLinkedIssues,
    updateLinkSnapshot: issueLinks.updateLinkSnapshot,
    setFollowupNeeded: issueLinks.setFollowupNeeded,
    clearFollowup: issueLinks.clearFollowup,
    countFollowupNeeded: issueLinks.countFollowupNeeded,
};
