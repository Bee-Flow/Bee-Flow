/**
 * analyzeCode: everything the product knows about a code step's source
 * without running it. Pure (no I/O, no isolated-vm), so the validator, the
 * routes, the runner and the AI assistant can all call it.
 *
 *   const { analyzeCode } = require('./codeSafety');
 *   analyzeCode(code, { allowedTools, allowedHosts }) => {
 *     ok, syntaxError, hash, rulesetVersion,
 *     description, params, returns,          // from the JSDoc on main()
 *     findings,                              // detect.js + rules.js
 *     capabilities: { hosts, dynamicHosts, tools, inputsRead, undeclaredInputs,
 *                     usesHttp, usesDb, httpInLoop },
 *   }
 *
 * The static check is an early warning and an explanation for the author,
 * not the security boundary: the sandbox is (see detect.js).
 */

'use strict';

const { parseCode, hashCode, normaliseCode, stripComments } = require('./parse');
const { parseJsDoc } = require('./jsdoc');
const { detect } = require('./detect');
const { RULESET_VERSION, RULES } = require('./rules');
const { cleanHostList } = require('./hosts');

const EMPTY_CAPABILITIES = Object.freeze({
    hosts: [], dynamicHosts: false, tools: [], inputsRead: [], undeclaredInputs: [],
    usesHttp: false, usesDb: false, httpInLoop: false,
});

const isFunctionNode = (n) => n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

/** The `main` function and the statement a JSDoc block would sit on top of. */
function findMain(ast) {
    for (const stmt of ast.body) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id && stmt.id.name === 'main') return { fn: stmt, anchor: stmt };
        if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
                if (d.id.type === 'Identifier' && d.id.name === 'main' && isFunctionNode(d.init)) return { fn: d.init, anchor: stmt };
            }
        }
    }
    return null;
}

/** The `/** ... *\/` block directly above `anchor` (only whitespace between). */
function jsDocAbove(anchor, comments, src) {
    let best = null;
    for (const c of comments) {
        if (c.type !== 'Block' || !c.value.startsWith('*') || c.end > anchor.start) continue;
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- /^\s*$/ on the text between a comment and main(): linear
        if (/^\s*$/.test(src.slice(c.end, anchor.start))) best = c;
    }
    return best;
}

/** Defaults written in a destructured first parameter: `main({ rate = 21 }, ctx)`. */
function destructuredDefaults(pattern) {
    const out = new Map();
    if (!pattern || pattern.type !== 'ObjectPattern') return out;
    for (const p of pattern.properties) {
        if (p.type !== 'Property' || p.computed || p.key.type !== 'Identifier') continue;
        const v = p.value;
        if (v && v.type === 'AssignmentPattern' && v.right.type === 'Literal') out.set(p.key.name, v.right.value);
        else if (v && v.type === 'AssignmentPattern' && v.right.type === 'ArrayExpression' && v.right.elements.length === 0) out.set(p.key.name, []);
        else out.set(p.key.name, undefined);
    }
    return out;
}

/**
 * @param {string} code
 * @param {{ allowedTools?: string[], allowedHosts?: string[] }} [options]
 */
function analyzeCode(code, { allowedTools = [], allowedHosts = [] } = {}) {
    const src = String(code == null ? '' : code);
    const hash = hashCode(src);
    const parsed = parseCode(src);
    const base = { hash, rulesetVersion: RULESET_VERSION };
    if (parsed.syntaxError) {
        return {
            ...base, ok: false, syntaxError: parsed.syntaxError, description: null, params: [], returns: null,
            findings: [], capabilities: { ...EMPTY_CAPABILITIES },
        };
    }
    const { ast, comments } = parsed;
    const main = findMain(ast);
    const firstParam = main && main.fn.params[0];
    const secondParam = main && main.fn.params[1];
    const inputsName = firstParam && firstParam.type === 'Identifier' ? firstParam.name : 'inputs';
    const ctxName = secondParam && secondParam.type === 'Identifier' ? secondParam.name : 'ctx';

    let doc = { description: null, params: [], returns: null };
    if (main) {
        const c = jsDocAbove(main.anchor, comments, src);
        if (c) doc = parseJsDoc(c.value, c.loc.start.line, { inputsName, ctxName });
    }

    // A default in a destructured first parameter counts when the JSDoc gives none.
    const destructured = destructuredDefaults(firstParam);
    const params = doc.params.map((p) => {
        if (p.default === undefined && destructured.has(p.name) && destructured.get(p.name) !== undefined) {
            return { ...p, default: destructured.get(p.name), required: false };
        }
        return p;
    });

    const hosts = cleanHostList(allowedHosts);
    const { findings, facts } = detect(ast, src, { inputsName, ctxName, allowedTools, allowedHosts: hosts });
    const inputsRead = [...new Set([...facts.inputsRead, ...destructured.keys()])];
    const declared = new Set(params.map((p) => p.name));
    return {
        ...base,
        ok: true,
        syntaxError: null,
        description: doc.description,
        params,
        returns: doc.returns,
        findings,
        capabilities: { ...facts, inputsRead, undeclaredInputs: inputsRead.filter((n) => !declared.has(n)) },
    };
}

/** The findings that stop a run or activation outright. */
const blockingFindings = (analysis) => (analysis && analysis.findings ? analysis.findings.filter((f) => f.severity === 'block') : []);

module.exports = { analyzeCode, blockingFindings, RULESET_VERSION, RULES, hashCode, normaliseCode, stripComments };
