// @typecheck
/**
 * App Studio builder — function-calling tool schemas (OpenAI format).
 *
 * The apply() implementations live in ../builderTools.js; this file is the
 * single place the LLM-facing surface is declared (mirrors
 * automation/builderTools/schemas.js). Component/prop/action detail is NOT
 * repeated here — the system prompt renders the full catalog from
 * componentSpecs.js (builderPrompt/catalogRender.js); these descriptions
 * only teach the call protocol.
 *
 * LOCKSTEP RULE: every enum/value list in these schemas is DERIVED from the
 * authoritative vocabulary exports (componentSpecs.js, appDesignPresets.js,
 * dataModel.js) — never re-typed here. The section-background bug is the
 * cautionary tale: componentSpecs grew background "panel"/"gradient" but this
 * file still said ["none","surface","tint"], so the model PHYSICALLY could
 * not emit the new values and nothing anywhere failed. Deriving makes the
 * next vocabulary addition flow into the tool surface automatically;
 * builderTools.test.js pins the derivation (and the prose lists) with
 * lockstep tests. Every input below is a module constant, so TOOL_SCHEMAS
 * stays byte-stable per build (prompt-cache discipline).
 */

'use strict';

const { MAX_COMPONENTS_PER_CALL, MAX_SEED_RECORDS, TEMP_ID_MAX, TEMP_ID_RX, MAX_BATCH_PATCHES_PER_CALL, INSPECT_CATALOG_MAX_COMPONENTS, INSPECT_CATALOG_MAX_STEPS, NODE_VALIDATION_TYPES, SECTION_HEIGHT_MODES, ACTION_OBJECT_DESC, ACTION_STEP_PROPS, ACTION_OBJECT_PROPS } = require('./schemaFragments');

const { TOOL_SCHEMAS_PART_1 } = require('./schemasPart1');
const { TOOL_SCHEMAS_PART_2 } = require('./schemasPart2');
const { TOOL_SCHEMAS_PART_3 } = require('./schemasPart3');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS = [
    ...TOOL_SCHEMAS_PART_1,
    ...TOOL_SCHEMAS_PART_2,
    ...TOOL_SCHEMAS_PART_3,
];

TOOL_SCHEMAS.push(...require('../../core/documents/documentDiscovery').schemas('app'));

module.exports = {
    TOOL_SCHEMAS,
    MAX_COMPONENTS_PER_CALL,
    MAX_BATCH_PATCHES_PER_CALL,
    MAX_SEED_RECORDS,
    INSPECT_CATALOG_MAX_COMPONENTS,
    INSPECT_CATALOG_MAX_STEPS,
    ACTION_OBJECT_DESC,
    ACTION_OBJECT_PROPS,
    ACTION_STEP_PROPS,
    NODE_VALIDATION_TYPES,
    TEMP_ID_MAX,
    TEMP_ID_RX,
    // Exported for the lockstep test: the section height modes are STYLE_KNOBS'
    // minus the one a section physically cannot have. A test asserts the
    // subtraction is exactly "pct" and that canonicalize agrees, so nobody can
    // quietly widen (or narrow) what a section is offered.
    SECTION_HEIGHT_MODES,
};
