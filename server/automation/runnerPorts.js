/**
 * The automation feature's side of core/automationRunner/featurePorts.js: the
 * capabilities the runner (core) calls in automation/ without requiring it.
 *
 * Loaded at boot by boot/featureRegistrations.js. Every require is lazy, as
 * it was at the call sites in the runner, so loading this file costs nothing
 * and a test's require.cache stub of a module below is what a call reaches.
 */

'use strict';

const { registerRunnerPorts } = require('../core/automationRunner/featurePorts');

const approvalEvents = () => require('./approvalEvents');
const approvalNotify = () => require('./approvalNotify');
const triggerBus = () => require('./triggerBus');
const formQueue = () => require('./formQueue');

registerRunnerPorts({
    approvals: {
        projectStamp: (...args) => require('./approvalProject').projectStamp(...args),
        dispatchApprovalRequested: (...args) => approvalEvents().dispatchApprovalRequested(...args),
        dispatchApprovalDecided: (...args) => approvalEvents().dispatchApprovalDecided(...args),
        runOnDecidedHook: (...args) => require('./approvalHooks').runOnDecidedHook(...args),
        notifyApproval: (...args) => approvalNotify().notifyApproval(...args),
        automationForApproval: (...args) => approvalNotify().automationForApproval(...args),
        pollTalkReactions: (...args) => require('./approvalReactionIngest').pollTalkReactions(...args),
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
});
