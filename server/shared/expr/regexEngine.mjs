// @typecheck strict
/**
 * The engine that runs a formula's regular expression, SERVER copy: RE2
 * (linear time, cannot backtrack), so a pattern on a long text can never stall
 * the event loop every tenant shares. regex.mjs has already refused what RE2
 * cannot read (look-around, back-references), so RE2 and the native engine of
 * the browser and phone answer the same.
 *
 * This file is NOT mirrored: agent-hub and mobile keep a hand-written native
 * copy with the same exports (scripts/shared-mirror.manifest.json exclude +
 * keep). When the re2 module cannot load (a box without the native build),
 * the native engine is the fallback; regex.mjs's checks still hold there.
 */
import { createRequire } from 'node:module';

/** @type {(new (source: string, flags: string) => RegExp) | null} */
let Re2 = null;
try {
    Re2 = createRequire(import.meta.url)('re2');
} catch {
    Re2 = null; // no native build on this box: the guarded native engine below
}

/** Which engine runs the patterns here: 're2' or 'native'. */
export const REGEX_ENGINE = Re2 ? 're2' : 'native';

/**
 * A compiled pattern. Throws on a pattern the engine cannot read.
 * @param {string} source
 * @param {string} flags
 * @returns {RegExp}
 */
export function createRegex(source, flags) {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp, ajinabraham.njsscan.dos.regex_dos.regex_dos -- fallback only; regex.mjs refused look-around, back-references and nested quantifiers first
    return Re2 ? new Re2(source, flags) : new RegExp(source, flags);
}
