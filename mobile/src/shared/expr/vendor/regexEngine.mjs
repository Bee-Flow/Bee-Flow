// @typecheck strict
/**
 * The engine that runs a formula's regular expression, PHONE copy
 * (hand-written, kept by scripts/shared-mirror.manifest.json): the native
 * engine. The server copy (server/shared/expr/regexEngine.mjs) runs RE2;
 * regex.mjs refuses what RE2 cannot read (look-around, back-references) and
 * the nested-quantifier shape before anything compiles, so both answer the
 * same. Same exports as the server copy.
 */

/** Which engine runs the patterns here. */
export const REGEX_ENGINE = 'native';

/**
 * A compiled pattern. Throws on a pattern the engine cannot read.
 * @param {string} source
 * @param {string} flags
 * @returns {RegExp}
 */
export function createRegex(source, flags) {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp, ajinabraham.njsscan.dos.regex_dos.regex_dos -- regex.mjs refused look-around, back-references and nested quantifiers first; the pattern is a literal of the formula
    return new RegExp(source, flags);
}
