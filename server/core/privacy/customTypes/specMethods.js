// @typecheck strict
'use strict';
/**
 * The method blocks of a "Your own data" type (spec.js holds the contract and
 * the validator): one reader per method, each turning the body's block into
 * the stored one and reporting CONTENT errors through `err`, in the order the
 * fields are read. A content error keeps the block (cut to size), so the
 * admin's work is not thrown away.
 */

const { re2Compile, v8Compile } = require('./compile');
const { LIMITS } = require('./limits');

const CONTROL = /\p{Cc}/u;

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @typedef {(field: string, code: string, message: string) => void} ErrSink */
/**
 * isLegacy: a migrated type (exact words, longer caps, its v8 pattern kept);
 * stored: the saved version of the type, if any.
 * @typedef {{ err: ErrSink, isLegacy: boolean, stored: Record<string, any> | null | undefined }} BlockCtx
 */

/**
 * The distinct words of the list, trimmed unless migrated, and whether one was too long.
 * @param {unknown} list
 * @param {boolean} isLegacy
 * @param {number} maxLen
 */
function wordValues(list, isLegacy, maxLen) {
    /** @type {string[]} */
    const values = [];
    const seen = new Set();
    let tooLong = false;
    for (const raw of Array.isArray(list) ? list : []) {
        if (typeof raw !== 'string') continue;
        // A migrated literal keeps its exact characters (parity with the old
        // scanner); a new word is trimmed.
        const v = isLegacy ? raw : raw.trim();
        if (!v) continue;
        if (v.length > maxLen) { tooLong = true; continue; }
        if (seen.has(v)) continue;
        seen.add(v);
        values.push(v);
    }
    return { values, tooLong };
}

/**
 * @param {Record<string, any>} type
 * @param {BlockCtx} ctx
 */
function wordsBlock(type, { err, isLegacy }) {
    const w = isPlainObject(type.words) ? type.words : {};
    const caseSensitive = w.caseSensitive === true;
    const wholeWord = typeof w.wholeWord === 'boolean' ? w.wholeWord : !isLegacy;
    const maxLen = isLegacy ? LIMITS.legacyWordMax : LIMITS.wordMax;
    const { values, tooLong } = wordValues(w.values, isLegacy, maxLen);
    if (!Array.isArray(w.values)) err('words.values', 'words_invalid', 'The words are a list of text.');
    if (tooLong) err('words.values', 'word_too_long', `Each word or phrase holds at most ${maxLen} characters.`);
    if (values.length > LIMITS.wordsMax) err('words.values', 'words_too_many', `A data type holds at most ${LIMITS.wordsMax} words.`);
    if (!values.length) err('words.values', 'words_empty', 'Add at least one word or phrase.');
    return { values: values.slice(0, LIMITS.wordsMax), caseSensitive, wholeWord };
}

/**
 * Why an RE2 pattern cannot be kept, or null.
 * @param {string} source
 * @param {boolean} caseSensitive
 * @param {boolean} isLegacy  a migrated pattern may match empty text
 * @param {ErrSink} err
 * @returns {string | null}
 */
function re2Refusal(source, caseSensitive, isLegacy, err) {
    const { re, error: re2Error } = re2Compile(source, caseSensitive);
    if (re2Error || !re) {
        err('pattern.source', 'pattern_invalid', `This pattern is not supported: ${re2Error || 'invalid'}.`);
        return re2Error || 'invalid';
    }
    if (!isLegacy && re.test('')) {
        err('pattern.source', 'pattern_matches_empty', 'This pattern also matches empty text, so it would match everywhere. Make it require at least one character.');
        return 'matches empty text';
    }
    return null;
}

/**
 * Why the pattern cannot be kept (missing, too long, does not compile on its engine), or null.
 * @param {{ source: string, caseSensitive: boolean, max: number, keepV8: boolean, isLegacy: boolean }} pattern
 * @param {ErrSink} err
 * @returns {string | null}
 */
function patternRefusal({ source, caseSensitive, max, keepV8, isLegacy }, err) {
    if (!source) {
        err('pattern.source', 'pattern_required', 'Write the pattern.');
        return 'missing';
    }
    if (source.length > max) {
        err('pattern.source', 'pattern_too_long', `A pattern holds at most ${max} characters.`);
        return 'too long';
    }
    if (!keepV8) return re2Refusal(source, caseSensitive, isLegacy, err);
    const v8 = v8Compile(source, caseSensitive);
    if (v8.ok) return null;
    err('pattern.source', 'pattern_invalid', 'This pattern does not compile.');
    return v8.error || 'invalid';
}

/**
 * A migrated pattern that did not change keeps the v8 engine; anything else runs on RE2.
 * @param {Record<string, any>} type
 * @param {BlockCtx} ctx
 */
function patternBlock(type, { err, isLegacy, stored }) {
    const p = isPlainObject(type.pattern) ? type.pattern : {};
    const source = typeof p.source === 'string' ? p.source : '';
    const caseSensitive = p.caseSensitive === true;
    const max = isLegacy ? LIMITS.legacyPatternMax : LIMITS.patternMax;
    const keepV8 = isLegacy && stored?.pattern?.engine === 'v8-legacy' && stored?.pattern?.source === source;
    const engine = keepV8 ? 'v8-legacy' : 're2';
    const error = patternRefusal({ source, caseSensitive, max, keepV8, isLegacy }, err);
    return { source: source.slice(0, max), caseSensitive, engine, ...(error ? { error: String(error).slice(0, 200) } : {}) };
}

/** @param {string} prompt */
const promptIsPlain = (prompt) => prompt.length >= LIMITS.promptMin && prompt.length <= LIMITS.promptMax
    && !CONTROL.test(prompt) && !prompt.includes('<<') && !prompt.includes('>>');

/**
 * @param {unknown} floor
 * @returns {floor is number}
 */
const floorInRange = (floor) => typeof floor === 'number' && Number.isFinite(floor) && floor >= LIMITS.floorMin && floor <= LIMITS.floorMax;

/**
 * @param {Record<string, any>} type
 * @param {BlockCtx} ctx
 */
function aiBlock(type, { err }) {
    const a = isPlainObject(type.ai) ? type.ai : {};
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    if (!promptIsPlain(prompt)) {
        err('ai.prompt', 'ai_prompt_invalid', `The label for the AI is ${LIMITS.promptMin} to ${LIMITS.promptMax} characters of plain text.`);
    }
    let floor = a.floor === undefined ? LIMITS.floorDefault : a.floor;
    if (!floorInRange(floor)) {
        err('ai.floor', 'ai_floor_invalid', `The sensitivity is a number between ${LIMITS.floorMin} and ${LIMITS.floorMax}.`);
        floor = LIMITS.floorDefault;
    }
    /** @type {{ prompt: string, floor: number, groupSignature?: string }} */
    const out = { prompt: prompt.slice(0, LIMITS.promptMax), floor };
    if (typeof a.groupSignature === 'string' && a.groupSignature.length <= LIMITS.groupSignatureMax) {
        out.groupSignature = a.groupSignature;
    }
    return out;
}

/**
 * Method name to its block reader. The validator only asks for a method it accepted.
 * @type {ReadonlyMap<string, (type: Record<string, any>, ctx: BlockCtx) => object>}
 */
const METHOD_BLOCKS = new Map(Object.entries({ words: wordsBlock, pattern: patternBlock, ai: aiBlock }));

module.exports = { METHOD_BLOCKS, isPlainObject };
