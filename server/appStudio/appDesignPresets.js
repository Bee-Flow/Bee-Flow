// @typecheck strict
/**
 * App design presets (server entry point). The data lives in
 * server/shared/appDefinition/designPresets.mjs, shared with the editor's
 * preset gallery through the generated agent-hub/src/shared/appDefinition/.
 */

'use strict';

// APP_DESIGN_PRESETS is the BASE seven (what the pinned prompt and tool schemas list);
// ALL_APP_DESIGN_PRESETS adds the presets marked since 3, and getAppDesignPreset resolves any.
const { APP_DESIGN_PRESETS, EXTENSION_APP_DESIGN_PRESETS, ALL_APP_DESIGN_PRESETS, getAppDesignPreset } = require('../shared/appDefinition/designPresets.mjs');

module.exports = { APP_DESIGN_PRESETS, EXTENSION_APP_DESIGN_PRESETS, ALL_APP_DESIGN_PRESETS, getAppDesignPreset };
