/**
 * Meeting notes' side of core/automationRunner/featurePorts.js: the periodic
 * passes the runner's scheduler (core/automationRunner/scheduler/) drives for
 * meeting notes, without the automation runner requiring this domain.
 *
 * The two are separate modules (each behind its own module gate in
 * ticks.js), and meeting notes pull in the provider clients, the transcript
 * pipeline and their stores; the scheduler only needs to call three passes.
 *
 * Loaded at boot by boot/featureRegistrations.js; every require is lazy.
 */

'use strict';

const { registerRunnerPorts } = require('../automationRunner/featurePorts');

const gmeet = () => require('./gmeetAutoImport');
const teams = () => require('./teamsAutoImport');

registerRunnerPorts({
    meetingImports: {
        gmeetDiscover: (...args) => gmeet().discover(...args),
        gmeetProcessDue: (...args) => gmeet().processDue(...args),
        teamsDiscover: (...args) => teams().discover(...args),
        teamsProcessDue: (...args) => teams().processDue(...args),
        talkScanAndRecord: (...args) => require('./talkAutoRecord').scanAndRecord(...args),
    },
});
