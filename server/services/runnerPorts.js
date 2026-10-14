/**
 * The services side of core/automationRunner/featurePorts.js: the
 * presentation renderer the runner's presentation and fill-document steps
 * use, without core requiring services/. Loaded at boot by
 * boot/featureRegistrations.js; the require is lazy.
 */

'use strict';

const { registerRunnerPorts } = require('../core/automationRunner/featurePorts');

const presentationRenderer = () => require('./presentationRenderer');

registerRunnerPorts({
    presentations: {
        renderPresentation: (...args) => presentationRenderer().renderPresentation(...args),
        makeUserImageResolver: (...args) => presentationRenderer().makeUserImageResolver(...args),
    },
});
