// @typecheck strict
/**
 * The detector's node visitors (detect.js walks the code and explains the
 * layer): one visitor per node type, each a list of named checks that raise
 * findings or record capability facts. The checks of one visitor run in a
 * fixed order: two findings on the same line and column keep that order in
 * the report.
 */

'use strict';

const { forEachNode } = require('./parse');
const { literalPieces } = require('./fold');
const { mentionsMining, mentionsCollection } = require('./hosts');
const { propName, hasExit, mentionsClock, hostOfCall, looksPacked, isInternalName } = require('./detectShapes');
const { SECRET_PATTERNS } = require('../../../stores/automationStore/runLogRedaction');

const INTERNAL_PROPS = new Set(['derefInto', 'applySync', 'applyIgnored', 'applySyncPromise', 'getSync', 'setSync', 'transferList', 'cachedData']);
const NODE_GLOBALS = new Set(['require', 'process', 'module', 'exports', '__dirname', '__filename']);
const LOW_LEVEL = new Set(['WebAssembly', 'SharedArrayBuffer', 'Atomics']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);
const BUILTINS = new Set(['Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'Promise', 'RegExp', 'Date', 'Error', 'Map', 'Set', 'JSON', 'Math', 'Symbol', 'BigInt', 'Reflect']);
const ENUMERATORS = ['getOwnPropertyNames', 'keys', 'ownKeys', 'getOwnPropertyDescriptors', 'entries', 'defineProperty', 'defineProperties'];
const SECRET_RES = SECRET_PATTERNS.map(({ re }) => new RegExp(re.source, re.flags.replace('g', '')));

/** @typedef {import('acorn').AnyNode} AnyNode */
/** @typedef {(node: AnyNode) => unknown} Fold */

/**
 * @typedef {{ hosts: Set<string>, dynamicHosts: boolean, tools: Set<string>, inputsRead: Set<string>,
 *   usesHttp: boolean, usesDb: boolean, httpInLoop: boolean }} DetectFacts
 */

/**
 * What every visitor reads: the folder and the free-name test of this code,
 * the finding sink, the loop and reference tests, and the facts it fills.
 * @typedef {{
 *   fold: Fold,
 *   isFree: (name: string) => boolean,
 *   raise: (ruleId: string, node: AnyNode) => void,
 *   insideLoop: (node: AnyNode) => boolean,
 *   isReference: (n: import('acorn').Identifier, parent: AnyNode | null) => boolean,
 *   isCtx: (node: AnyNode) => boolean,
 *   facts: DetectFacts,
 *   allowedToolSet: Set<string>,
 *   allowedHosts: string[],
 *   inputsName: string,
 * }} DetectEnv
 */

/**
 * @param {AnyNode | import('acorn').Super} node
 * @returns {node is import('acorn').Identifier}
 */
const isIdent = (node) => node.type === 'Identifier';

/**
 * A free global identifier named one of `names`.
 * @param {AnyNode | import('acorn').Super} node
 * @param {Set<string>} names
 * @param {DetectEnv} env
 */
const isFreeOneOf = (node, names, env) => isIdent(node) && names.has(node.name) && env.isFree(node.name);

/**
 * A free reference to a host internal, a Node global, a low-level API or eval.
 * @param {import('acorn').Identifier} n
 * @param {AnyNode | null} parent
 * @param {DetectEnv} env
 */
function visitIdentifier(n, parent, env) {
    if (!env.isReference(n, parent) || !env.isFree(n.name)) return;
    if (isInternalName(n.name)) env.raise('host-internals', n);
    else if (NODE_GLOBALS.has(n.name)) env.raise('node-access', n);
    else if (LOW_LEVEL.has(n.name)) env.raise('low-level', n);
    else if (n.name === 'eval') env.raise('dynamic-code', n);
}

/**
 * `Function(...)`, and a timer handed a string of code.
 * @param {import('acorn').CallExpression | import('acorn').NewExpression} n
 * @param {DetectEnv} env
 */
function checkGlobalCallee(n, env) {
    const c = n.callee;
    if (c.type === 'Identifier' && c.name === 'Function' && env.isFree('Function')) env.raise('dynamic-code', n);
    if (c.type === 'Identifier' && (c.name === 'setTimeout' || c.name === 'setInterval') && n.arguments[0]
        && typeof env.fold(n.arguments[0]) === 'string') env.raise('dynamic-code', n);
}

/**
 * x.constructor('code'), x['const' + 'ructor'](...), new y.constructor(...);
 * String.fromCharCode in bulk or in a loop.
 * @param {import('acorn').CallExpression | import('acorn').NewExpression} n
 * @param {import('acorn').MemberExpression} c
 * @param {string | undefined} name
 * @param {DetectEnv} env
 */
function checkMemberCallCode(n, c, name, env) {
    const spelled = name === undefined && c.computed ? literalPieces(c.property, forEachNode) : name;
    if (spelled === 'constructor' && n.arguments.length > 0) env.raise('dynamic-code', n);
    if (c.object.type === 'Identifier' && c.object.name === 'String' && name === 'fromCharCode'
        && (n.arguments.length >= 20 || env.insideLoop(n))) env.raise('obfuscation', n);
}

/**
 * The first argument names a global object, or a builtin's prototype.
 * @param {import('acorn').Expression | import('acorn').SpreadElement | undefined} arg
 * @param {DetectEnv} env
 */
function isGlobalOrBuiltinPrototype(arg, env) {
    if (!arg) return false;
    if (isFreeOneOf(arg, GLOBAL_OBJECTS, env)) return true;
    return arg.type === 'MemberExpression' && propName(arg, env.fold) === 'prototype'
        && arg.object.type === 'Identifier' && BUILTINS.has(arg.object.name);
}

/**
 * Object/Reflect calls that rewire prototypes or enumerate the global scope.
 * @param {import('acorn').CallExpression | import('acorn').NewExpression} n
 * @param {import('acorn').MemberExpression} c
 * @param {string | undefined} name
 * @param {DetectEnv} env
 */
function checkMemberCallTampering(n, c, name, env) {
    const onObjectOrReflect = c.object.type === 'Identifier' && (c.object.name === 'Object' || c.object.name === 'Reflect');
    if (onObjectOrReflect && (name === 'setPrototypeOf' || name === '__defineGetter__')) env.raise('builtin-tampering', n);
    if (onObjectOrReflect && ENUMERATORS.includes(/** @type {string} */ (name))
        && isGlobalOrBuiltinPrototype(n.arguments[0], env)) env.raise('builtin-tampering', n);
}

/**
 * ctx.http(url): the host it reaches, a dynamic host, a call in a loop.
 * @param {import('acorn').CallExpression | import('acorn').NewExpression} n
 * @param {DetectEnv} env
 */
function recordHttp(n, env) {
    const { facts } = env;
    facts.usesHttp = true;
    if (env.insideLoop(n)) { facts.httpInLoop = true; env.raise('http-in-loop', n); }
    const host = hostOfCall(n.arguments[0], env.fold);
    if (host) facts.hosts.add(host);
    else { facts.dynamicHosts = true; if (!env.allowedHosts.length) env.raise('dynamic-host', n); }
}

/**
 * ctx.http / ctx.integrations.<tool> / ctx.db
 * @param {import('acorn').CallExpression | import('acorn').NewExpression} n
 * @param {import('acorn').MemberExpression} c
 * @param {string | undefined} name
 * @param {DetectEnv} env
 */
function recordCtxCall(n, c, name, env) {
    if (env.isCtx(c.object) && name === 'http') recordHttp(n, env);
    if (c.object.type !== 'MemberExpression' || !env.isCtx(c.object.object)) return;
    const area = propName(c.object, env.fold);
    if (area === 'integrations') {
        if (name === undefined) return;
        env.facts.tools.add(name);
        if (!env.allowedToolSet.has(name)) env.raise('tool-not-allowed', n);
    }
    if (area === 'db') env.facts.usesDb = true;
}

/**
 * @param {import('acorn').CallExpression | import('acorn').NewExpression} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitCall(n, _parent, env) {
    checkGlobalCallee(n, env);
    const c = n.callee;
    if (c.type !== 'MemberExpression') return;
    const name = propName(c, env.fold);
    checkMemberCallCode(n, c, name, env);
    checkMemberCallTampering(n, c, name, env);
    recordCtxCall(n, c, name, env);
}

/**
 * Host internals by property name, and the ways back to Function.
 * @param {import('acorn').MemberExpression} n
 * @param {string | undefined} name
 * @param {DetectEnv} env
 */
function checkMemberInternals(n, name, env) {
    if (name !== undefined && INTERNAL_PROPS.has(name)) env.raise('host-internals', n);
    if (name !== undefined && isInternalName(name) && n.computed) env.raise('host-internals', n);
    // x.constructor.constructor: the classic way back to Function
    if (name === 'constructor' && n.object.type === 'MemberExpression' && propName(n.object, env.fold) === 'constructor') env.raise('dynamic-code', n);
    if (n.object.type === 'Identifier' && n.object.name === 'Function' && env.isFree('Function') && name === 'prototype') env.raise('dynamic-code', n);
}

/**
 * globalThis[...]: eval, Function or a constructor by name, or a lookup the code computes.
 * @param {import('acorn').MemberExpression} n
 * @param {string | undefined} name
 * @param {DetectEnv} env
 */
function checkGlobalLookup(n, name, env) {
    if (!n.computed || !isFreeOneOf(n.object, GLOBAL_OBJECTS, env)) return;
    const spelled = name !== undefined ? name : literalPieces(n.property, forEachNode);
    if (/^(eval|Function)$/.test(spelled) || /constructor/.test(spelled)) env.raise('dynamic-code', n);
    else if (name === undefined) env.raise('builtin-tampering', n);
}

/**
 * __proto__, the stack-trace hooks of Error, arguments.callee / caller.
 * @param {import('acorn').MemberExpression} n
 * @param {string | undefined} name
 * @param {DetectEnv} env
 */
function checkMemberTampering(n, name, env) {
    if (name === '__proto__') env.raise('builtin-tampering', n);
    const objectName = n.object.type === 'Identifier' ? n.object.name : undefined;
    if (objectName === 'Error' && (name === 'prepareStackTrace' || name === 'captureStackTrace')) env.raise('builtin-tampering', n);
    if (objectName === 'arguments' && (name === 'callee' || name === 'caller')) env.raise('builtin-tampering', n);
}

/**
 * @param {import('acorn').MemberExpression} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitMember(n, _parent, env) {
    const name = propName(n, env.fold);
    checkMemberInternals(n, name, env);
    checkGlobalLookup(n, name, env);
    checkMemberTampering(n, name, env);
    // inputs.x reads
    if (n.object.type === 'Identifier' && n.object.name === env.inputsName && name !== undefined) env.facts.inputsRead.add(name);
}

/**
 * const { a, b: c } = inputs
 * @param {import('acorn').VariableDeclarator} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitDeclarator(n, _parent, env) {
    if (n.id.type !== 'ObjectPattern' || !n.init || n.init.type !== 'Identifier' || n.init.name !== env.inputsName) return;
    for (const p of n.id.properties) if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier') env.facts.inputsRead.add(p.key.name);
}

/**
 * Builtin.prototype.x = ..., Builtin.prototype = ..., Builtin.x = ..., globalThis.x = ...
 * @param {import('acorn').AssignmentExpression} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitAssignment(n, _parent, env) {
    const t = n.left;
    if (t.type !== 'MemberExpression') return;
    /** @type {import('acorn').Expression | import('acorn').Super} */
    let base = t;
    while (base.type === 'MemberExpression') {
        if (propName(base, env.fold) === 'prototype' && isFreeOneOf(base.object, BUILTINS, env)) { env.raise('builtin-tampering', n); break; }
        base = base.object;
    }
    if (isFreeOneOf(t.object, BUILTINS, env) && /** @type {import('acorn').Identifier} */ (t.object).name !== 'JSON') env.raise('builtin-tampering', n);
    if (isFreeOneOf(t.object, GLOBAL_OBJECTS, env)) env.raise('builtin-tampering', n);
}

/**
 * for (k in globalThis)
 * @param {import('acorn').ForInStatement} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitForIn(n, _parent, env) {
    if (isFreeOneOf(n.right, GLOBAL_OBJECTS, env)) env.raise('builtin-tampering', n);
}

/**
 * A loop that runs forever, or on the clock, with no way out.
 * @param {import('acorn').WhileStatement | import('acorn').DoWhileStatement | import('acorn').ForStatement} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitLoop(n, _parent, env) {
    const test = n.test;
    const forever = !test || (test.type === 'Literal' && test.value === true);
    if ((forever && !hasExit(n.body)) || (test && mentionsClock(test) && !hasExit(n.body))) env.raise('busy-wait', n);
}

/**
 * Mining and collection hosts, secrets and packed text in a string.
 * @param {import('acorn').Literal | import('acorn').TemplateElement} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
function visitText(n, _parent, env) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- fixed secret shapes from runLogRedaction and fixed host lists, on literals of at most 200 KB
    const text = n.type === 'Literal' ? (typeof n.value === 'string' ? n.value : null) : n.value.cooked;
    if (!text) return;
    if (mentionsMining(text)) env.raise('mining', n);
    else if (mentionsCollection(text)) env.raise('collection-host', n);
    if (SECRET_RES.some((re) => re.test(text))) env.raise('hardcoded-secret', n);
    if (looksPacked(text)) env.raise('obfuscation', n);
}

/**
 * @param {AnyNode} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
const raiseNodeAccess = (n, _parent, env) => env.raise('node-access', n);

/**
 * @param {AnyNode} n
 * @param {AnyNode | null} _parent
 * @param {DetectEnv} env
 */
const raiseDynamicCode = (n, _parent, env) => env.raise('dynamic-code', n);

/**
 * A visitor takes the node type it is registered for. Written as a method
 * signature so a visitor of one node type fits the table of all of them.
 * @typedef {{ visit(n: AnyNode, parent: AnyNode | null, env: DetectEnv): void }['visit']} Visitor
 */

/**
 * Node type to visitor. A Map, so a type string that happens to be an Object
 * method name never resolves to one.
 * @type {ReadonlyMap<string, Visitor>}
 */
const VISITORS = new Map(Object.entries({
    Identifier: visitIdentifier,
    ImportExpression: raiseNodeAccess,
    MetaProperty: raiseNodeAccess,
    WithStatement: raiseDynamicCode,
    NewExpression: visitCall,
    CallExpression: visitCall,
    MemberExpression: visitMember,
    VariableDeclarator: visitDeclarator,
    AssignmentExpression: visitAssignment,
    ForInStatement: visitForIn,
    WhileStatement: visitLoop,
    DoWhileStatement: visitLoop,
    ForStatement: visitLoop,
    Literal: visitText,
    TemplateElement: visitText,
}));

module.exports = { VISITORS };
