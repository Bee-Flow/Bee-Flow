// @typecheck strict
/**
 * What the detector's visitors (detectVisitors.js) ask of a node or a text:
 * its static property name, whether a loop body has a way out, whether a test
 * reads the clock, the host a ctx.http call reaches, whether a text looks
 * packed. Pure functions of the AST and the folder.
 */

'use strict';

const { forEachNode } = require('./parse');
const { hostOfUrlPrefix } = require('./hosts');

const INTERNAL_NAMES = new Set(['ivm', 'Reference', 'ExternalCopy']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const EXITS = ['BreakStatement', 'ReturnStatement', 'ThrowStatement', 'AwaitExpression', 'YieldExpression'];

/** @typedef {import('acorn').AnyNode} AnyNode */
/** @typedef {(node: AnyNode) => unknown} Fold */

/**
 * @param {string} n
 */
const isInternalName = (n) => typeof n === 'string' && (n.startsWith('__host') || n.startsWith('__bf') || INTERNAL_NAMES.has(n));

/**
 * A static or foldable property name of a MemberExpression, else undefined.
 * @param {import('acorn').MemberExpression} member
 * @param {Fold} fold
 * @returns {string | undefined}
 */
function propName(member, fold) {
    if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : undefined;
    const v = fold(member.property);
    return typeof v === 'string' ? v : undefined;
}

/** @param {string} s */
function entropy(s) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    let h = 0;
    for (const c of counts.values()) { const p = c / s.length; h -= p * Math.log2(p); }
    return h;
}

/**
 * Does `body` (not counting nested functions) contain a way out of a loop?
 * @param {AnyNode} body
 */
function hasExit(body) {
    let exit = false;
    /** @param {unknown} value */
    const walk = (value) => {
        if (!value || exit || typeof value !== 'object') return;
        const node = /** @type {Record<string, unknown>} */ (value);
        if (typeof node.type !== 'string') return;
        if (EXITS.includes(node.type)) { exit = true; return; }
        if (FUNCTIONS.has(node.type)) return;
        for (const k of Object.keys(node)) {
            if (k === 'loc') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk); else if (v && typeof (/** @type {{ type?: unknown }} */ (v)).type === 'string') walk(v);
        }
    };
    walk(body);
    return exit;
}

/** @param {AnyNode} node */
const mentionsClock = (node) => {
    let clock = false;
    forEachNode(node, (n) => {
        if (n.type === 'MemberExpression' && !n.computed && (/** @type {import('acorn').Identifier | import('acorn').PrivateIdentifier} */ (n.property)).name === 'now'
            && n.object.type === 'Identifier' && (n.object.name === 'Date' || n.object.name === 'performance')) clock = true;
        if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Date') clock = true;
    });
    return clock;
};

/**
 * The host a ctx.http(url, ...) call reaches, when the code decides it.
 * @param {import('acorn').Expression | import('acorn').SpreadElement | undefined} arg
 * @param {Fold} fold
 */
function hostOfCall(arg, fold) {
    if (!arg) return null;
    const whole = fold(arg);
    if (typeof whole === 'string') return hostOfUrlPrefix(whole, true);
    // `https://api.x.com/items/${id}` or 'https://api.x.com/' + id: the known prefix.
    /** @type {AnyNode} */
    let head = arg;
    while (head.type === 'BinaryExpression' && head.operator === '+') head = head.left;
    /** @type {string | null | undefined} */
    let prefix;
    if (head.type === 'TemplateLiteral') prefix = head.quasis[0].value.cooked;
    else { const v = fold(head); prefix = typeof v === 'string' ? v : undefined; }
    return typeof prefix === 'string' ? hostOfUrlPrefix(prefix, false) : null;
}

/**
 * Packed text: very long, or long and base64- or hex-shaped.
 * @param {string} text
 */
function looksPacked(text) {
    if (text.length > 10 * 1024) return true;
    if (text.length <= 1024) return false;
    const compact = text.replace(/\s+/g, '');
    return (/^[A-Za-z0-9+/=_-]+$/.test(compact) && entropy(compact) > 4.5) || (/^[0-9a-fA-F]+$/.test(compact) && compact.length > 2048);
}

module.exports = { propName, hasExit, mentionsClock, hostOfCall, looksPacked, isInternalName, FUNCTIONS };
