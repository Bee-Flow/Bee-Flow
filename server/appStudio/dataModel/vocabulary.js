// @typecheck strict
/**
 * Re-export shim over ../../core/dataEngine/dataModel/vocabulary, PLUS the two
 * connector constants that stay a feature concern.
 *
 * WHY: server/layering.test.js forbids one product feature requiring another,
 * and core/ requiring a feature at all. Automation datatables need the same
 * field/filter/aggregate vocabulary App Studio uses, so it moved down to
 * core/dataEngine/. CONNECTOR_KINDS and the runtime row ceiling did NOT move:
 * they are owned by connectors.js, the module that actually runs a connector,
 * and core must not reach up to it. Importing them here keeps the two in
 * lockstep exactly as before and keeps this module's export surface identical
 * for every existing caller.
 */

'use strict';

const core = require('../../core/dataEngine/dataModel/vocabulary');
// The constants live in connectors/shared (a leaf); connectors.js re-exports
// them, so requiring connectors.js from here would close the import cycle.
const { CONNECTOR_KINDS, MAX_CONNECTOR_ROWS } = require('../connectors/shared');

module.exports = { ...core, CONNECTOR_KINDS, MAX_CONNECTOR_ROWS };
