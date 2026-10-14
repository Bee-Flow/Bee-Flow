/**
 * App Studio catalog — definition.variables: the declared shared values, their
 * types, the reserved names, and the default coercion both runtimes seed from.
 *
 * The vocabulary and coercion live in server/shared/appDefinition/variables.mjs,
 * shared with the editor; this file adds the catalog's field spec.
 */

'use strict';

const {
    VARIABLE_TYPES,
    VARIABLE_TYPE_DEFAULTS,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    coerceVariableDefault,
    seedVariableDefaults,
} = require('../../shared/appDefinition/variables.mjs');

const VARIABLE_SPEC = {
    name: { type: 'string', required: true, maxLen: 60 },
    label: { type: 'string', maxLen: 80, default: '' },
    type: { type: 'enum', values: VARIABLE_TYPES, default: 'any' },
    default: { type: 'json' },
    description: { type: 'string', maxLen: 500, default: '' },
};

module.exports = {
    VARIABLE_TYPES,
    VARIABLE_TYPE_DEFAULTS,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    VARIABLE_SPEC,
    coerceVariableDefault,
    seedVariableDefaults,
};
