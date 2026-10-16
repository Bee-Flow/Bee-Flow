/**
 * The jobs feature's side of core/automationRunner/featurePorts.js: the
 * periodic passes the runner's ticks (core/automationRunner/scheduler/ticks.js)
 * drive under their advisory locks, without core requiring jobs/.
 *
 * Loaded at boot by boot/featureRegistrations.js. Every require is lazy, as it
 * was in ticks.js, so loading this file costs nothing.
 */

'use strict';

const { registerRunnerPorts } = require('../core/automationRunner/featurePorts');

registerRunnerPorts({
    periodicJobs: {
        runRetentionPass: (...args) => require('./runRetention').runRetentionPass(...args),
        purgeTrashPass: (...args) => require('./automationTrashPurge').purgeTrashPass(...args),
        datatableRetentionPass: (...args) => require('./datatableRetention').datatableRetentionPass(...args),
        digestPass: (...args) => require('./automationDigest').digestPass(...args),
    },
});
