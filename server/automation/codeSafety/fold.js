/**
 * A small constant evaluator: what a string (or number, or array of them)
 * expression is, when the code alone decides it.
 *
 * It exists so that `globalThis['ev' + 'al']`, `x[k]` with `const k =
 * 'constructor'`, `String.fromCharCode(101, 118, 97, 108)` and
 * `'lave'.split('').reverse().join('')` read as what they spell. It never runs
 * the code: it knows literals, `+`, template literals, identifiers bound once
 * to a constant, array literals and a fixed list of pure string methods.
 * Anything else is "unknown" (undefined), which the rules read as "not
 * decided by the code".
 *
 * Bounded: recursion depth and result length are capped, so a hostile snippet
 * (`'x'.repeat(1e9)`, a self-referencing binding) costs a bounded amount.
 */

'use strict';

const MAX_DEPTH = 12;
const MAX_LEN = 20_000;

const STRING_METHODS = new Set([
    'split', 'reverse', 'join', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd',
    'slice', 'substring', 'substr', 'concat', 'replace', 'replaceAll', 'repeat', 'charAt', 'at',
    'padStart', 'padEnd', 'toString', 'normalize',
]);

function capped(v) {
    if (typeof v === 'string' && v.length > MAX_LEN) return undefined;
    if (Array.isArray(v) && v.length > MAX_LEN) return undefined;
    return v;
}

function isScalar(v) {
    return typeof v === 'string' || typeof v === 'number';
}

function decodeBase64(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/=_-]*$/.test(s)) return undefined;
    try { return Buffer.from(s, 'base64').toString('latin1'); } catch (_) { return undefined; }
}

/**
 * @param {object} env  { consts: Map<name, initNode>, isFree(name): boolean }
 */
function makeFolder(env) {
    function fold(node, depth = 0) {
        if (!node || depth > MAX_DEPTH) return undefined;
        switch (node.type) {
            case 'Literal':
                return (typeof node.value === 'string' || typeof node.value === 'number') ? node.value : undefined;
            case 'TemplateLiteral': {
                let out = '';
                for (let i = 0; i < node.quasis.length; i++) {
                    const cooked = node.quasis[i].value.cooked;
                    if (typeof cooked !== 'string') return undefined;
                    out += cooked;
                    if (i < node.expressions.length) {
                        const v = fold(node.expressions[i], depth + 1);
                        if (!isScalar(v)) return undefined;
                        out += String(v);
                    }
                    if (out.length > MAX_LEN) return undefined;
                }
                return out;
            }
            case 'BinaryExpression': {
                if (node.operator !== '+') return undefined;
                const l = fold(node.left, depth + 1);
                if (!isScalar(l)) return undefined;
                const r = fold(node.right, depth + 1);
                if (!isScalar(r)) return undefined;
                return capped(typeof l === 'number' && typeof r === 'number' ? l + r : String(l) + String(r));
            }
            case 'UnaryExpression':
                if (node.operator === '-') {
                    const v = fold(node.argument, depth + 1);
                    return typeof v === 'number' ? -v : undefined;
                }
                return undefined;
            case 'Identifier': {
                const init = env.consts.get(node.name);
                return init ? fold(init, depth + 1) : undefined;
            }
            case 'ArrayExpression': {
                const out = [];
                for (const el of node.elements) {
                    if (!el) return undefined;
                    if (el.type === 'SpreadElement') {
                        const v = fold(el.argument, depth + 1);
                        if (!Array.isArray(v)) return undefined;
                        out.push(...v);
                    } else {
                        const v = fold(el, depth + 1);
                        if (!isScalar(v)) return undefined;
                        out.push(v);
                    }
                }
                return capped(out);
            }
            case 'MemberExpression': {
                const obj = fold(node.object, depth + 1);
                if (obj === undefined) return undefined;
                const key = node.computed ? fold(node.property, depth + 1)
                    : (node.property.type === 'Identifier' ? node.property.name : undefined);
                if (key === 'length' && (typeof obj === 'string' || Array.isArray(obj))) return obj.length;
                if (typeof key === 'number' && (typeof obj === 'string' || Array.isArray(obj))) return obj[key];
                return undefined;
            }
            case 'ChainExpression':
                return fold(node.expression, depth + 1);
            case 'CallExpression':
                return foldCall(node, depth);
            default:
                return undefined;
        }
    }

    function argValues(args, depth) {
        const out = [];
        for (const a of args) {
            if (a.type === 'SpreadElement') {
                const v = fold(a.argument, depth + 1);
                if (!Array.isArray(v)) return undefined;
                out.push(...v);
            } else {
                const v = fold(a, depth + 1);
                if (v === undefined) return undefined;
                out.push(v);
            }
        }
        return out;
    }

    function foldCall(node, depth) {
        const callee = node.callee;
        // String.fromCharCode(...) / String.fromCodePoint(...)
        if (callee.type === 'MemberExpression' && !callee.computed
            && callee.object.type === 'Identifier' && callee.object.name === 'String' && env.isFree('String')
            && (callee.property.name === 'fromCharCode' || callee.property.name === 'fromCodePoint')) {
            const args = argValues(node.arguments, depth);
            if (!args || !args.every((n) => typeof n === 'number' && n >= 0 && n <= 0x10ffff)) return undefined;
            try { return capped(String.fromCodePoint(...args)); } catch (_) { return undefined; }
        }
        // atob('...'), decodeURIComponent('...'), unescape('...')
        if (callee.type === 'Identifier' && env.isFree(callee.name) && node.arguments.length === 1) {
            const v = fold(node.arguments[0], depth + 1);
            if (typeof v !== 'string') return undefined;
            if (callee.name === 'atob') return decodeBase64(v);
            if (callee.name === 'decodeURIComponent' || callee.name === 'decodeURI' || callee.name === 'unescape') {
                try { return callee.name === 'unescape' ? unescape(v) : decodeURIComponent(v); } catch (_) { return undefined; }
            }
            return undefined;
        }
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return undefined;
        const method = callee.property.name;
        if (!STRING_METHODS.has(method)) return undefined;
        const recv = fold(callee.object, depth + 1);
        if (recv === undefined) return undefined;
        const args = argValues(node.arguments, depth);
        if (!args) return undefined;
        try {
            if (typeof recv === 'string') {
                if (method === 'repeat' && (typeof args[0] !== 'number' || recv.length * args[0] > MAX_LEN)) return undefined;
                if ((method === 'replace' || method === 'replaceAll') && !args.every((a) => typeof a === 'string')) return undefined;
                if (method === 'reverse' || method === 'join') return undefined;
                return capped(String.prototype[method].apply(recv, args));
            }
            if (Array.isArray(recv)) {
                if (method === 'reverse') return [...recv].reverse();
                if (method === 'join') return capped(recv.join(args.length ? String(args[0]) : ','));
                if (method === 'slice') return recv.slice(...args);
                if (method === 'concat') return capped(recv.concat(...args));
                if (method === 'at') return recv.at(args[0]);
            }
        } catch (_) {
            return undefined;
        }
        return undefined;
    }

    return fold;
}

/**
 * The string pieces a (possibly unfoldable) expression is built from, in
 * source order: `a('con') + b('structor')` gives 'constructor'. Used only to
 * ask whether an obfuscated key SPELLS something suspicious.
 */
function literalPieces(node, forEachNode) {
    const parts = [];
    forEachNode(node, (n) => {
        if (n.type === 'Literal' && typeof n.value === 'string') parts.push({ at: n.start, text: n.value });
        if (n.type === 'TemplateElement' && typeof n.value.cooked === 'string') parts.push({ at: n.start, text: n.value.cooked });
    });
    return parts.sort((a, b) => a.at - b.at).map((p) => p.text).join('');
}

module.exports = { makeFolder, literalPieces, decodeBase64 };
