/**
 * Parsing and fingerprinting of a code step's source.
 *
 * The code is the BODY of an async function (codeSandbox.js wraps it in an
 * async IIFE), so a top-level `return` or `await` is valid here and the parser
 * is told so. `sourceType: 'script'` matches what V8 compiles: sloppy mode,
 * where a `with` statement is still legal syntax (and a finding, not an error).
 *
 * The hash is what approvals and the AI review cache are keyed on. It is taken
 * over a NORMALISED text (CRLF to LF, trailing whitespace trimmed per line) so
 * an editor that rewrites line endings, or strips a trailing space on save,
 * does not throw away an approval for code that did not change.
 */

'use strict';

const crypto = require('node:crypto');
const acorn = require('acorn');

/** CRLF/CR to LF, trailing whitespace trimmed per line. */
function normaliseCode(code) {
    return String(code == null ? '' : code)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t\f\v ﻿]+$/u, ''))
        .join('\n');
}

/** sha256 (hex) of the normalised code: the key approvals and reviews hang off. */
function hashCode(code) {
    return crypto.createHash('sha256').update(normaliseCode(code), 'utf8').digest('hex');
}

/**
 * Parse the code. Answers `{ ast, comments }` or `{ syntaxError }`, where the
 * syntax error is `{ message, line, column }` with a 1-based column (the
 * editor's convention; acorn counts columns from 0).
 */
function parseCode(code) {
    const comments = [];
    try {
        const ast = acorn.parse(String(code == null ? '' : code), {
            ecmaVersion: 'latest',
            sourceType: 'script',
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
            allowHashBang: false,
            locations: true,
            onComment: comments,
        });
        return { ast, comments, syntaxError: null };
    } catch (e) {
        const loc = e && e.loc ? e.loc : null;
        const message = String((e && e.message) || e).replace(/\s*\(\d+:\d+\)\s*$/, '');
        return {
            ast: null,
            comments: [],
            syntaxError: { message, line: loc ? loc.line : 1, column: loc ? loc.column + 1 : 1 },
        };
    }
}

/**
 * Visit every ESTree node below `root` (the node itself included), depth
 * first, with its parent. Generic over node types on purpose: the passes that
 * use it (declarations, string constants, reassignments) must not miss a node
 * kind a newer parser version adds.
 */
function forEachNode(root, fn) {
    const stack = [[root, null]];
    while (stack.length) {
        const [node, parent] = stack.pop();
        if (!node || typeof node.type !== 'string') continue;
        fn(node, parent);
        const keys = Object.keys(node);
        for (let i = keys.length - 1; i >= 0; i--) {
            const k = keys[i];
            if (k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
            const v = node[k];
            if (Array.isArray(v)) {
                for (let j = v.length - 1; j >= 0; j--) {
                    if (v[j] && typeof v[j].type === 'string') stack.push([v[j], node]);
                }
            } else if (v && typeof v.type === 'string') {
                stack.push([v, node]);
            }
        }
    }
}

/**
 * The source with every comment removed (for the AI review, which must not
 * be steered by prose in the code). Line breaks inside a removed block comment
 * are kept, so line numbers stay meaningful. Falls back to the input when the
 * code does not parse: a regex strip would eat `//` inside strings.
 */
function stripComments(code) {
    const src = String(code == null ? '' : code);
    const parsed = parseCode(src);
    if (!parsed.ast) return src;
    let out = '';
    let at = 0;
    for (const c of parsed.comments) {
        out += src.slice(at, c.start);
        const removed = src.slice(c.start, c.end);
        out += removed.replace(/[^\n]/g, '');
        at = c.end;
    }
    out += src.slice(at);
    return out;
}

module.exports = { normaliseCode, hashCode, parseCode, forEachNode, stripComments };
