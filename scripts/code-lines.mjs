#!/usr/bin/env node
/**
 * code-lines — size of a JavaScript/TypeScript file in lines of code.
 *
 *   import { codeLineCount, isCodeFile } from './code-lines.mjs';
 *
 * codeLineCount(text) is the number of lines that still contain a
 * non-whitespace character after comments are removed. Blank lines and lines
 * that hold only a comment (`//`, `/* *\/`, JSDoc) do not count; a line with
 * code and a trailing comment does. The file-size gates (file-budget.mjs, the
 * `big-file` metric of count-ratchet.mjs) use it so type comments and
 * documentation cannot push a file over its limit.
 *
 * A small character scanner, not a parser. Comment markers inside '...',
 * "..." and `...` strings are ignored (a template's `${}` is treated as part
 * of the string, which can only shift the count slightly). Known limit:
 * regex literals are not recognised, so a regex containing a quote or `//`
 * can confuse the scan for the rest of that line or file.
 *
 * Zero dependencies. A script that imports this and is copied into a test
 * sandbox needs this file copied next to it.
 */

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** True for .js .mjs .cjs .jsx .ts .tsx .mts .cts. */
export const isCodeFile = (rel) => CODE_FILE.test(rel);

/**
 * One boolean per physical line (the text split on \n): does it hold code once comments are
 * removed? A line inside a multi-line string or template counts, it is content of the program.
 */
export function codeLineMask(text) {
    const mask = [];
    let hasCode = false;
    let quote = null; // ' " or `
    let block = false;
    const n = text.length;
    for (let i = 0; i < n; i++) {
        const c = text[i];
        if (c === '\n') {
            mask.push(hasCode);
            hasCode = false;
            // A line comment or a single/double-quoted string ends with the line.
            if (quote === "'" || quote === '"') quote = null;
            continue;
        }
        if (block) {
            if (c === '*' && text[i + 1] === '/') {
                block = false;
                i++;
            }
            continue;
        }
        if (quote) {
            if (c === '\\') {
                if (text[i + 1] !== '\n') i++;
                hasCode = true;
                continue;
            }
            if (c === quote) quote = null;
            if (!/\s/.test(c)) hasCode = true;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i + 1 < n && text[i + 1] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            block = true;
            i++;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        if (!/\s/.test(c)) hasCode = true;
    }
    mask.push(hasCode);
    return mask;
}

/** Lines with code left after removing comments (blank lines do not count). */
export function codeLineCount(text) {
    const mask = codeLineMask(text);
    // A final newline ends the last line; the empty line after it is not one.
    return mask.filter(Boolean).length;
}
