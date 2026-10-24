// @typecheck
/**
 * Builder-agent tool schemas (§WS5, extracted verbatim from builderTools.js).
 * NOTE: applyToolCall mutates this array in place (scope/forEach/error-branch
 * injection) via the imported reference — same object, so the mutation is shared.
 * The entries live in schemasPart1..5.js (same order); the shared text fragments in schemaFragments.js.
 */

const { TOOL_SCHEMAS_PART_1 } = require('./schemasPart1');
const { TOOL_SCHEMAS_PART_2 } = require('./schemasPart2');
const { TOOL_SCHEMAS_PART_3 } = require('./schemasPart3');
const { TOOL_SCHEMAS_PART_4 } = require('./schemasPart4');
const { TOOL_SCHEMAS_PART_5 } = require('./schemasPart5');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS = [
    ...TOOL_SCHEMAS_PART_1,
    ...TOOL_SCHEMAS_PART_2,
    ...TOOL_SCHEMAS_PART_3,
    ...TOOL_SCHEMAS_PART_4,
    ...TOOL_SCHEMAS_PART_5,
];

TOOL_SCHEMAS.push(...require('../../core/documents/documentDiscovery').schemas('builder'));

module.exports = { TOOL_SCHEMAS };
