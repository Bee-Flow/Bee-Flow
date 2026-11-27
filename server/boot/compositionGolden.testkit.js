'use strict';
/**
 * The golden files of the composition characterisation tests
 * (boot/composition.*.characterisation.test.js): what server/index.js and the
 * boot/ registration files compose today, recorded from the running code, so
 * that moving their rows into per-module composition files can be proven to
 * change nothing.
 *
 * A golden is `boot/composition.<name>.characterisation.golden.json`: a `_comment`
 * that says what it records and how, then the recording. Arrays of objects are
 * written one element per line, so a diff shows one mount, store or job per line.
 *
 * UPDATE_GOLDEN=1 rewrites the golden from the recording instead of comparing
 * (the switch the other characterisation tests use):
 *   cd server && UPDATE_GOLDEN=1 node --test boot/composition.<name>.characterisation.test.js
 * Only after a change that is MEANT to change the composition; review the diff.
 */

const fs = require('node:fs');
const path = require('node:path');

/** @param {string} name */
const goldenPath = (name) => path.join(__dirname, `composition.${name}.characterisation.golden.json`);

/**
 * JSON with each element of an array of objects on its own line.
 * @param {unknown} value
 * @param {string} indent
 * @returns {string}
 */
function render(value, indent = '') {
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const inner = `${indent}  `;
        const lines = value.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : render(v, inner)));
        return `[\n${lines.map((l) => `${inner}${l}`).join(',\n')}\n${indent}]`;
    }
    if (value && typeof value === 'object') {
        const inner = `${indent}  `;
        const lines = Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, inner)}`);
        return lines.length ? `{\n${lines.join(',\n')}\n${indent}}` : '{}';
    }
    return JSON.stringify(value);
}

/**
 * The golden for `name`; with UPDATE_GOLDEN=1 it is first rewritten from `recording`.
 * @param {string} name
 * @param {string} comment what the golden records and how
 * @param {Record<string, unknown>} recording
 * @returns {Record<string, any>}
 */
function readGolden(name, comment, recording) {
    const file = goldenPath(name);
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, `${render({ _comment: comment, ...recording })}\n`);
    const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete golden._comment;
    return golden;
}

/**
 * The difference of two lists as multisets, by a key per element.
 * @template T
 * @param {T[]} expected
 * @param {T[]} actual
 * @param {(item: T) => string} [keyOf]
 */
function multisetDiff(expected, actual, keyOf = (x) => JSON.stringify(x)) {
    /** @type {Map<string, number>} */
    const count = new Map();
    for (const e of expected) count.set(keyOf(e), (count.get(keyOf(e)) || 0) + 1);
    /** @type {string[]} */
    const added = [];
    for (const a of actual) {
        const k = keyOf(a);
        const n = count.get(k) || 0;
        if (n) count.set(k, n - 1);
        else added.push(k);
    }
    const missing = [...count.entries()].flatMap(([k, n]) => Array(n).fill(k));
    return { missing, added };
}

/**
 * The lines of an assertion message for a multiset difference.
 * @param {{ missing: string[], added: string[] }} diff
 */
function describeMultisetDiff({ missing, added }) {
    return [...missing.map((k) => `  missing: ${k}`), ...added.map((k) => `  new:     ${k}`)].join('\n');
}

module.exports = { goldenPath, readGolden, render, multisetDiff, describeMultisetDiff };
