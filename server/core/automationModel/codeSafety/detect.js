/**
 * The detector: walks a parsed code step once and raises the findings of
 * rules.js, plus the facts the capability summary is built from.
 *
 * This is an early-warning and explanation layer, NOT the security boundary:
 * the sandbox (codeSandbox.js) is. An AST check can always be dodged by code
 * clever enough (n8n's sanitizer was, twice), so the rules aim at what honest
 * code never needs, with as few false positives as possible: an ordinary
 * snippet (reshaping JSON, date maths, a fetch to a named API, an integration
 * call, loops over arrays) must come out clean.
 *
 * Name resolution is deliberately simple: a name counts as FREE (a global)
 * when the code declares it nowhere. `function process(items) {}` is the
 * author's own function, not Node's `process`, and is never flagged.
 */

'use strict';

const { forEachNode } = require('./parse');
const { makeFolder, literalPieces } = require('./fold');
const { hostOfUrlPrefix, mentionsMining, mentionsCollection } = require('./hosts');
const { makeFinding } = require('./rules');
const { SECRET_PATTERNS } = require('../runLogRedaction');

const INTERNAL_NAMES = new Set(['ivm', 'Reference', 'ExternalCopy']);
const INTERNAL_PROPS = new Set(['derefInto', 'applySync', 'applyIgnored', 'applySyncPromise', 'getSync', 'setSync', 'transferList', 'cachedData']);
const NODE_GLOBALS = new Set(['require', 'process', 'module', 'exports', '__dirname', '__filename']);
const LOW_LEVEL = new Set(['WebAssembly', 'SharedArrayBuffer', 'Atomics']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);
const BUILTINS = new Set(['Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'Promise', 'RegExp', 'Date', 'Error', 'Map', 'Set', 'JSON', 'Math', 'Symbol', 'BigInt', 'Reflect']);
const ITERATING_METHODS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'flatMap', 'some', 'every', 'find', 'findIndex']);
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SECRET_RES = SECRET_PATTERNS.map(({ re }) => new RegExp(re.source, re.flags.replace('g', '')));

const isInternalName = (n) => typeof n === 'string' && (n.startsWith('__host') || n.startsWith('__bf') || INTERNAL_NAMES.has(n));

/** Every name the code binds anywhere (variables, functions, params, classes, catch). */
function declaredNames(ast) {
    const names = new Set();
    const addPattern = (p) => forEachNode(p, (n, parent) => {
        if (n.type !== 'Identifier') return;
        // In `{ a: b }` only `b` is bound; in `{ a = 1 }` the key is the binding.
        if (parent && parent.type === 'Property' && parent.key === n && !parent.shorthand) return;
        if (parent && parent.type === 'AssignmentPattern' && parent.right === n) return;
        if (parent && parent.type === 'MemberExpression') return;
        names.add(n.name);
    });
    forEachNode(ast, (n) => {
        if (n.type === 'VariableDeclarator') addPattern(n.id);
        else if (FUNCTIONS.has(n.type)) { if (n.id) names.add(n.id.name); n.params.forEach(addPattern); }
        else if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) names.add(n.id.name);
        else if (n.type === 'CatchClause' && n.param) addPattern(n.param);
    });
    return names;
}

/** `const k = <init>` bindings (never reassigned by definition), for the folder. */
function constBindings(ast) {
    const consts = new Map();
    forEachNode(ast, (n) => {
        if (n.type !== 'VariableDeclaration' || n.kind !== 'const') return;
        for (const d of n.declarations) if (d.id.type === 'Identifier' && d.init) consts.set(d.id.name, d.init);
    });
    return consts;
}

/** A static or foldable property name of a MemberExpression, else undefined. */
function propName(member, fold) {
    if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : undefined;
    const v = fold(member.property);
    return typeof v === 'string' ? v : undefined;
}

function entropy(s) {
    const counts = new Map();
    for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    let h = 0;
    for (const c of counts.values()) { const p = c / s.length; h -= p * Math.log2(p); }
    return h;
}

/** Does `body` (not counting nested functions) contain a way out of a loop? */
function hasExit(body) {
    let exit = false;
    const walk = (node) => {
        if (!node || exit || typeof node.type !== 'string') return;
        if (['BreakStatement', 'ReturnStatement', 'ThrowStatement', 'AwaitExpression', 'YieldExpression'].includes(node.type)) { exit = true; return; }
        if (FUNCTIONS.has(node.type)) return;
        for (const k of Object.keys(node)) {
            if (k === 'loc') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v);
        }
    };
    walk(body);
    return exit;
}

const mentionsClock = (node) => {
    let clock = false;
    forEachNode(node, (n) => {
        if (n.type === 'MemberExpression' && !n.computed && n.property.name === 'now'
            && n.object.type === 'Identifier' && (n.object.name === 'Date' || n.object.name === 'performance')) clock = true;
        if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Date') clock = true;
    });
    return clock;
};

/**
 * @param {object} ast        acorn Program
 * @param {string} src        the source (for line lengths and escapes)
 * @param {{ inputsName: string, ctxName: string, allowedTools: string[], allowedHosts: string[] }} opts
 * @returns {{ findings: object[], facts: object }}
 */
function detect(ast, src, { inputsName = 'inputs', ctxName = 'ctx', allowedTools = [], allowedHosts = [] } = {}) {
    const declared = declaredNames(ast);
    const isFree = (name) => !declared.has(name);
    const fold = makeFolder({ consts: constBindings(ast), isFree });
    const findings = [];
    const raise = (ruleId, node) => findings.push(makeFinding(ruleId, node));

    const parents = new Map();
    forEachNode(ast, (n, parent) => { parents.set(n, parent); });
    const ancestors = function* (n) { for (let p = parents.get(n); p; p = parents.get(p)) yield p; };
    const insideLoop = (n) => {
        let child = n;
        for (const p of ancestors(n)) {
            if (LOOPS.has(p.type)) return true;
            if (FUNCTIONS.has(child.type) && p.type === 'CallExpression' && p.arguments.includes(child)
                && p.callee.type === 'MemberExpression' && ITERATING_METHODS.has(propName(p.callee, fold))) return true;
            child = p;
        }
        return false;
    };
    // A free reference: an Identifier read as a value (not a property key, not a binding).
    const isReference = (n, parent) => {
        if (!parent) return true;
        if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return false;
        if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === n && !parent.computed) return parent.shorthand === true;
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
        return true;
    };
    const isCtx = (node) => node && node.type === 'Identifier' && node.name === ctxName;

    const facts = { hosts: new Set(), dynamicHosts: false, tools: new Set(), inputsRead: new Set(), usesHttp: false, usesDb: false, httpInLoop: false };
    const allowedToolSet = new Set(allowedTools || []);

    forEachNode(ast, (n, parent) => {
        switch (n.type) {
            case 'Identifier': {
                if (!isReference(n, parent) || !isFree(n.name)) break;
                if (isInternalName(n.name)) raise('host-internals', n);
                else if (NODE_GLOBALS.has(n.name)) raise('node-access', n);
                else if (LOW_LEVEL.has(n.name)) raise('low-level', n);
                else if (n.name === 'eval') raise('dynamic-code', n);
                break;
            }
            case 'ImportExpression':
            case 'MetaProperty':
                raise('node-access', n);
                break;
            case 'WithStatement':
                raise('dynamic-code', n);
                break;
            case 'NewExpression':
            case 'CallExpression': {
                const c = n.callee;
                if (c.type === 'Identifier' && c.name === 'Function' && isFree('Function')) raise('dynamic-code', n);
                if (c.type === 'Identifier' && (c.name === 'setTimeout' || c.name === 'setInterval') && n.arguments[0]
                    && typeof fold(n.arguments[0]) === 'string') raise('dynamic-code', n);
                if (c.type === 'MemberExpression') {
                    const name = propName(c, fold);
                    // x.constructor('code'), x['const' + 'ructor'](...), new y.constructor(...)
                    const spelled = name === undefined && c.computed ? literalPieces(c.property, forEachNode) : name;
                    if (spelled === 'constructor' && n.arguments.length > 0) raise('dynamic-code', n);
                    if (c.object.type === 'Identifier' && c.object.name === 'String' && name === 'fromCharCode'
                        && (n.arguments.length >= 20 || insideLoop(n))) raise('obfuscation', n);
                    if (c.object.type === 'Identifier' && (c.object.name === 'Object' || c.object.name === 'Reflect')
                        && (name === 'setPrototypeOf' || name === '__defineGetter__')) raise('builtin-tampering', n);
                    if (c.object.type === 'Identifier' && (c.object.name === 'Object' || c.object.name === 'Reflect')
                        && ['getOwnPropertyNames', 'keys', 'ownKeys', 'getOwnPropertyDescriptors', 'entries', 'defineProperty', 'defineProperties'].includes(name)
                        && n.arguments[0] && ((n.arguments[0].type === 'Identifier' && GLOBAL_OBJECTS.has(n.arguments[0].name) && isFree(n.arguments[0].name))
                            || (n.arguments[0].type === 'MemberExpression' && propName(n.arguments[0], fold) === 'prototype'
                                && n.arguments[0].object.type === 'Identifier' && BUILTINS.has(n.arguments[0].object.name)))) raise('builtin-tampering', n);
                    // ctx.http / ctx.integrations.<tool> / ctx.db
                    if (isCtx(c.object) && name === 'http') {
                        facts.usesHttp = true;
                        if (insideLoop(n)) { facts.httpInLoop = true; raise('http-in-loop', n); }
                        const host = hostOfCall(n.arguments[0], fold);
                        if (host) facts.hosts.add(host);
                        else { facts.dynamicHosts = true; if (!allowedHosts.length) raise('dynamic-host', n); }
                    }
                    if (c.object.type === 'MemberExpression' && isCtx(c.object.object) && propName(c.object, fold) === 'integrations') {
                        if (name === undefined) break;
                        facts.tools.add(name);
                        if (!allowedToolSet.has(name)) raise('tool-not-allowed', n);
                    }
                    if (c.object.type === 'MemberExpression' && isCtx(c.object.object) && propName(c.object, fold) === 'db') facts.usesDb = true;
                }
                break;
            }
            case 'MemberExpression': {
                const name = propName(n, fold);
                if (name !== undefined && INTERNAL_PROPS.has(name)) raise('host-internals', n);
                if (name !== undefined && isInternalName(name) && n.computed) raise('host-internals', n);
                // x.constructor.constructor: the classic way back to Function
                if (name === 'constructor' && n.object.type === 'MemberExpression' && propName(n.object, fold) === 'constructor') raise('dynamic-code', n);
                if (n.object.type === 'Identifier' && n.object.name === 'Function' && isFree('Function') && name === 'prototype') raise('dynamic-code', n);
                if (n.object.type === 'Identifier' && GLOBAL_OBJECTS.has(n.object.name) && isFree(n.object.name) && n.computed) {
                    const spelled = name !== undefined ? name : literalPieces(n.property, forEachNode);
                    if (/^(eval|Function)$/.test(spelled) || /constructor/.test(spelled)) raise('dynamic-code', n);
                    else if (name === undefined) raise('builtin-tampering', n);
                }
                if (name === '__proto__') raise('builtin-tampering', n);
                if (n.object.type === 'Identifier' && n.object.name === 'Error' && (name === 'prepareStackTrace' || name === 'captureStackTrace')) raise('builtin-tampering', n);
                if (n.object.type === 'Identifier' && n.object.name === 'arguments' && (name === 'callee' || name === 'caller')) raise('builtin-tampering', n);
                // inputs.x reads
                if (n.object.type === 'Identifier' && n.object.name === inputsName && name !== undefined) facts.inputsRead.add(name);
                break;
            }
            case 'VariableDeclarator': {
                // const { a, b: c } = inputs
                if (n.id.type === 'ObjectPattern' && n.init && n.init.type === 'Identifier' && n.init.name === inputsName) {
                    for (const p of n.id.properties) if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier') facts.inputsRead.add(p.key.name);
                }
                break;
            }
            case 'AssignmentExpression': {
                const t = n.left;
                if (t.type !== 'MemberExpression') break;
                // Builtin.prototype.x = ..., Builtin.prototype = ...
                let base = t;
                while (base.type === 'MemberExpression') {
                    if (propName(base, fold) === 'prototype' && base.object.type === 'Identifier' && BUILTINS.has(base.object.name) && isFree(base.object.name)) { raise('builtin-tampering', n); break; }
                    base = base.object;
                }
                if (t.object.type === 'Identifier' && BUILTINS.has(t.object.name) && isFree(t.object.name) && t.object.name !== 'JSON') raise('builtin-tampering', n);
                if (t.object.type === 'Identifier' && GLOBAL_OBJECTS.has(t.object.name) && isFree(t.object.name)) raise('builtin-tampering', n);
                break;
            }
            case 'ForInStatement':
                if (n.right.type === 'Identifier' && GLOBAL_OBJECTS.has(n.right.name) && isFree(n.right.name)) raise('builtin-tampering', n);
                break;
            case 'WhileStatement':
            case 'DoWhileStatement':
            case 'ForStatement': {
                const test = n.test;
                const forever = !test || (test.type === 'Literal' && test.value === true);
                if ((forever && !hasExit(n.body)) || (test && mentionsClock(test) && !hasExit(n.body))) raise('busy-wait', n);
                break;
            }
            case 'Literal':
            case 'TemplateElement': {
                // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- fixed secret shapes from runLogRedaction and fixed host lists, on literals of at most 200 KB
                const text = n.type === 'Literal' ? (typeof n.value === 'string' ? n.value : null) : n.value.cooked;
                if (!text) break;
                if (mentionsMining(text)) raise('mining', n);
                else if (mentionsCollection(text)) raise('collection-host', n);
                if (SECRET_RES.some((re) => re.test(text))) raise('hardcoded-secret', n);
                if (text.length > 10 * 1024) raise('obfuscation', n);
                else if (text.length > 1024) {
                    const compact = text.replace(/\s+/g, '');
                    if ((/^[A-Za-z0-9+/=_-]+$/.test(compact) && entropy(compact) > 4.5) || (/^[0-9a-fA-F]+$/.test(compact) && compact.length > 2048)) raise('obfuscation', n);
                }
                break;
            }
            default:
                break;
        }
    });

    // Line-level signals: packed code and escaped identifiers.
    src.split('\n').forEach((line, i) => {
        if (line.length > 1000) findings.push(makeFinding('obfuscation', { line: i + 1, column: 1 }));
    });
    forEachNode(ast, (n) => {
        if (n.type === 'Identifier' && /\\u/.test(src.slice(n.start, n.end))) findings.push(makeFinding('obfuscation', n));
    });

    return {
        findings: dedupe(findings),
        facts: {
            hosts: [...facts.hosts].sort(),
            dynamicHosts: facts.dynamicHosts,
            tools: [...facts.tools].sort(),
            inputsRead: [...facts.inputsRead],
            usesHttp: facts.usesHttp,
            usesDb: facts.usesDb,
            httpInLoop: facts.httpInLoop,
        },
    };
}

/** The host a ctx.http(url, ...) call reaches, when the code decides it. */
function hostOfCall(arg, fold) {
    if (!arg) return null;
    const whole = fold(arg);
    if (typeof whole === 'string') return hostOfUrlPrefix(whole, true);
    // `https://api.x.com/items/${id}` or 'https://api.x.com/' + id: the known prefix.
    let head = arg;
    while (head.type === 'BinaryExpression' && head.operator === '+') head = head.left;
    let prefix;
    if (head.type === 'TemplateLiteral') prefix = head.quasis[0].value.cooked;
    else { const v = fold(head); prefix = typeof v === 'string' ? v : undefined; }
    return typeof prefix === 'string' ? hostOfUrlPrefix(prefix, false) : null;
}

function dedupe(findings) {
    const seen = new Set();
    const out = [];
    for (const f of findings) {
        const key = `${f.ruleId}:${f.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
    }
    return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

module.exports = { detect, declaredNames };
