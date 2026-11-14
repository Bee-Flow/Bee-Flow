// @typecheck strict
'use strict';
/**
 * The caps on a "Your own data" type and on an organisation's list of them.
 * spec.js (the validator, which re-exports them) and specMethods.js (the
 * method blocks) both read them.
 */

const LIMITS = Object.freeze({
    maxTypes: 50,
    maxAiTypes: 6,
    nameMax: 60,
    descriptionMax: 400,
    wordsMax: 500,
    wordMax: 120,
    legacyWordMax: 500,
    patternMax: 300,
    legacyPatternMax: 500,
    promptMin: 2,
    promptMax: 60,
    floorMin: 0.10,
    floorMax: 0.95,
    floorDefault: 0.5,
    groupSignatureMax: 200,
});

module.exports = { LIMITS };
