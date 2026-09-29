/**
 * Re-export shim — the implementation moved to ../../core/dataEngine/dataModel/migrationPlan.
 *
 * WHY: server/layering.test.js forbids one product feature requiring another,
 * and core/ requiring a feature at all. Automation datatables need the same
 * table vocabulary, DDL and SQL compiler App Studio uses, so the engine moved
 * down to core/dataEngine/ and both features read it from there. This file
 * stays so App Studio's ~40 existing import sites (and their tests) keep
 * working unchanged; import either path, they are the same object.
 * */

'use strict';

module.exports = require('../../core/dataEngine/dataModel/migrationPlan');
