// @typecheck
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
const { makeFolder } = require('./fold');
const { makeFinding } = require('./rules');
const { VISITORS } = require('./detectVisitors');
const { FUNCTIONS, propName } = require('./detectShapes');

const ITERATING_METHODS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'flatMap', 'some', 'every', 'find', 'findIndex']);
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

/**
 * Every name the code binds anywhere (variables, functions, params, classes, catch).
 * @param {import('acorn').AnyNode} ast
 */
function declaredNames(ast) {
    /** @type {Set<string>} */
    const names = new Set();
    const addPattern = (/** @type {import('acorn').Pattern} */ p) => forEachNode(p, (n, parent) => {
        if (n.type !== 'Identifier') return;
        // In `{ a: b }` only `b` is bound; in `{ a = 1 }` the key is the binding.
        if (parent && parent.type === 'Property' && parent.key === n && !parent.shorthand) return;
        if (parent && parent.type === 'AssignmentPattern' && parent.right === n) return;
        if (parent && parent.type === 'MemberExpression') return;
        names.add(n.name);
    });
    forEachNode(ast, (n) => {
        if (n.type === 'VariableDeclarator') addPattern(n.id);
        else if (FUNCTIONS.has(n.type)) { if ((/** @type {import('acorn').Function} */ (n)).id) names.add((/** @type {import('acorn').Function} */ (n)).id.name); (/** @type {import('acorn').Function} */ (n)).params.forEach(addPattern); }
        else if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) names.add(n.id.name);
        else if (n.type === 'CatchClause' && n.param) addPattern(n.param);
    });
    return names;
}

/**
 * `const k = <init>` bindings (never reassigned by definition), for the folder.
 * @param {import('acorn').AnyNode} ast
 */
function constBindings(ast) {
    /** @type {Map<string, import('acorn').AnyNode>} */
    const consts = new Map();
    forEachNode(ast, (n) => {
        if (n.type !== 'VariableDeclaration' || n.kind !== 'const') return;
        for (const d of n.declarations) if (d.id.type === 'Identifier' && d.init) consts.set(d.id.name, d.init);
    });
    return consts;
}

/**
 * @param {import('acorn').Program} ast        acorn Program
 * @param {string} src        the source (for line lengths and escapes)
 * @param {{ inputsName?: string, ctxName?: string, allowedTools?: string[], allowedHosts?: string[] }} [opts]
 * @returns {{ findings: object[], facts: any }}
 */
function detect(ast, src, { inputsName = 'inputs', ctxName = 'ctx', allowedTools = [], allowedHosts = [] } = {}) {
    const declared = declaredNames(ast);
    /**
     * @param {string} name
     */
    const isFree = (name) => !declared.has(name);
    const fold = makeFolder({ consts: constBindings(ast), isFree });
    /** @type {import('./rules').CodeSafetyFinding[]} */
    const findings = [];
    /**
     * @param {string} ruleId
     * @param {import('acorn').AnyNode} node
     */
    const raise = (ruleId, node) => findings.push(makeFinding(ruleId, node));

    /** @type {Map<import('acorn').AnyNode, import('acorn').AnyNode | null>} */
    const parents = new Map();
    forEachNode(ast, (n, parent) => { parents.set(n, parent); });
    /** @param {import('acorn').AnyNode} n */
    const ancestors = function* (n) { for (let p = parents.get(n); p; p = parents.get(p)) yield p; };
    /** @param {import('acorn').AnyNode} n */
    const insideLoop = (n) => {
        let child = n;
        for (const p of ancestors(n)) {
            if (LOOPS.has(p.type)) return true;
            if (FUNCTIONS.has(child.type) && p.type === 'CallExpression' && p.arguments.includes(/** @type {import('acorn').Expression} */ (child))
                && p.callee.type === 'MemberExpression' && ITERATING_METHODS.has(propName(p.callee, fold))) return true;
            child = p;
        }
        return false;
    };
    // A free reference: an Identifier read as a value (not a property key, not a binding).
    /**
     * @param {import('acorn').Identifier} n
     * @param {import('acorn').AnyNode | null} parent
     */
    const isReference = (n, parent) => {
        if (!parent) return true;
        if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return false;
        if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === n && !parent.computed) return (/** @type {{ shorthand?: boolean }} */ (parent)).shorthand === true;

        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
        return true;
    };
    /** @param {import('acorn').AnyNode} node */
    const isCtx = (node) => node && node.type === 'Identifier' && node.name === ctxName;

    /** @type {{ hosts: Set<string>, dynamicHosts: boolean, tools: Set<string>, inputsRead: Set<string>, usesHttp: boolean, usesDb: boolean, httpInLoop: boolean }} */
    const facts = { hosts: new Set(), dynamicHosts: false, tools: new Set(), inputsRead: new Set(), usesHttp: false, usesDb: false, httpInLoop: false };
    const allowedToolSet = new Set(allowedTools || []);

    /** @type {import('./detectVisitors').DetectEnv} */
    const env = { fold, isFree, raise, insideLoop, isReference, isCtx, facts, allowedToolSet, allowedHosts, inputsName };
    forEachNode(ast, (n, parent) => {
        const visit = VISITORS.get(n.type);
        if (visit) visit(n, parent, env);
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

/** @param {import('./rules').CodeSafetyFinding[]} findings */
function dedupe(findings) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {import('./rules').CodeSafetyFinding[]} */
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
