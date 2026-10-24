// @typecheck
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
        gmeetDiscover: (...args) => /** @type {Function} */ (gmeet().discover)(...args),
        gmeetProcessDue: (...args) => /** @type {Function} */ (gmeet().processDue)(...args),
        teamsDiscover: (...args) => /** @type {Function} */ (teams().discover)(...args),
        teamsProcessDue: (...args) => /** @type {Function} */ (teams().processDue)(...args),
        talkScanAndRecord: (...args) => /** @type {Function} */ (require('./talkAutoRecord').scanAndRecord)(...args),
    },
});
