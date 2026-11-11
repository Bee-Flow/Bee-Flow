// @typecheck strict
/**
 * App Studio catalog: props and list-item keys whose value is a small fixed object.
 *
 * Such a key is declared `{ type: 'object', objectShape: '<name>', since: 3, description }` and
 * `<name>` is an entry here: the one function that cleans the object (canonicalize/props.js
 * stores what it returns, undefined leaves the key out) and the validator asks the same
 * function whether a stored value is already clean (validate/objectChecks.mts). Nothing is ever
 * filled from a default, so a node or column without the key keeps its exact bytes.
 *
 *   formatOptions   how one column, chart or stat writes its numbers and dates
 *                   (server/shared/format/formatClean.mjs)
 *   cellStyle       the conditional style of a table or data_grid column's cells, a rule list
 *                   (componentSpecs/styleRuleShape.js)
 *   customBlock     the whole of a custom_block: template, stylesheet, inputs, events
 *                   (customBlock/blockShape.mts)
 */

'use strict';

const { cleanFormatOptions } = require('../../shared/format/formatClean.mjs');
const { cleanCellStyle } = require('./styleRuleShape');
const { cleanCustomBlock } = require('../customBlock/blockShape.mts');

/**
 * @typedef {(raw: unknown, push: (code: string, path: string, message: string) => void, path: string) => unknown} ObjectCleaner
 * @typedef {{ clean: ObjectCleaner }} ObjectShape
 */

/** @type {Readonly<Record<string, ObjectShape>>} */
const OBJECT_SHAPES = Object.freeze({
    formatOptions: Object.freeze({ clean: cleanFormatOptions }),
    cellStyle: Object.freeze({ clean: cleanCellStyle }),
    customBlock: Object.freeze({ clean: cleanCustomBlock }),
});

/**
 * The object shape of a prop or item-key spec, or null when it is not an `object` key.
 * @param {{ type?: unknown, objectShape?: unknown } | null | undefined} spec
 * @returns {ObjectShape | null}
 */
function objectShapeOf(spec) {
    if (!spec || spec.type !== 'object' || typeof spec.objectShape !== 'string') return null;
    return Object.hasOwn(OBJECT_SHAPES, spec.objectShape) ? OBJECT_SHAPES[spec.objectShape] : null;
}

const FORMAT_OPTIONS_SHAPE = '{ currency?: "USD", decimals?: 0..10, pattern?: "dd-MM-yyyy", compact?: true, percentScale?: "whole"|"fraction" }';

/**
 * The spec of a `formatOptions` key. `first` is the index line (at most 72 characters, no ';'),
 * `applies` says which of the owner's values it reaches.
 * @param {string} first
 * @param {string} applies
 */
function formatOptionsSpec(first, applies) {
    return {
        type: 'object',
        objectShape: 'formatOptions',
        since: 3,
        description: `${first} `
            + `An object ${FORMAT_OPTIONS_SHAPE}, every key optional, set only what should differ. ${applies} `
            + 'currency (ISO 4217) and decimals win over the app-level `format`. compact writes 1.2K / 3.4M. '
            + 'percentScale "fraction" reads 0.25 as 25% (the default "whole" reads 25 as 25%). '
            + 'pattern is a date pattern from yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h mm ss a, literal letters in single quotes. '
            + 'Absent keeps the default way of writing the value.',
    };
}

module.exports = { OBJECT_SHAPES, objectShapeOf, formatOptionsSpec, FORMAT_OPTIONS_SHAPE };
