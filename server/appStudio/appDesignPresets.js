// @typecheck strict
/**
 * App design presets (server entry point). The data lives in
 * server/shared/appDefinition/designPresets.mjs, shared with the editor's
 * preset gallery through the generated agent-hub/src/shared/appDefinition/.
 */

'use strict';

const { APP_DESIGN_PRESETS, getAppDesignPreset } = require('../shared/appDefinition/designPresets.mjs');

module.exports = { APP_DESIGN_PRESETS, getAppDesignPreset };
