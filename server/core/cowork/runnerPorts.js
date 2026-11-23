// @typecheck strict
/**
 * What Cowork lends the automation runner (core/automationRunner/featurePorts.js), loaded by
 * boot/featureRegistrations.js:
 *
 *   heldDefinitions  a plan's journey continues after a pause on the copy its owner approved (./planHeldDefinition.mts)
 *
 * Lazy, like every registering module: the port costs nothing until a paused run continues.
 */

'use strict';

const { registerRunnerPorts } = require('../automationRunner/featurePorts');

registerRunnerPorts({
    heldDefinitions: {
        definitionOf: (/** @type {{ id?: string | null, rootRunId?: string | null, automationId?: string | null }} */ run) => require('./planHeldDefinition.mts').heldPlanDefinition(run),
    },
});
