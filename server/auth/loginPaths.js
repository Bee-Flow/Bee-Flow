// @typecheck strict
/**
 * Login path inventory — every call site of establishSession, read from the
 * source with acorn (a dependency of the server install).
 *
 * establishSession is the single way a session becomes authenticated, so its
 * call sites ARE the login paths. loginPaths.inventory.json lists each one
 * with what it does about a second factor; loginPaths.inventory.test.js fails
 * on a call site the inventory does not know, so a login path added next year
 * has to say where its MFA step is before it can land.
 *
 * A call site is keyed by what it says about itself, not by a line number:
 * `<file>#<audit.method>{<extra keys>}`, e.g. `auth/login/finalizeLogin.js#password{encryptionKey}`.
 * Two calls in one file with the same method and the same extra keys would
 * collide; they get a `#2` suffix in order of appearance.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const SERVER = path.resolve(__dirname, '..');

/** @typedef {{ type: string, [k: string]: any }} Node */

/**
 * Depth-first over every child node of an ESTree node.
 * @param {Node} node
 * @param {(n: Node) => void} fn
 */
function walk(node, fn) {
    fn(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, fn); } else if (v && typeof v.type === 'string') walk(v, fn);
    }
}

/** @param {Node} callee */
function calleeName(callee) {
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') return callee.property.name;
    return '';
}

/** @param {Node} prop */
function propName(prop) {
    if (!prop.key) return '';
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return '';
}

/**
 * @param {Node} obj  an ObjectExpression
 * @param {string} name
 * @returns {Node | null}
 */
function propertyValue(obj, name) {
    for (const p of obj.properties) {
        if (p.type === 'Property' && propName(p) === name) return p.value;
    }
    return null;
}

/**
 * The call sites in one source text.
 * @param {string} text
 * @param {string} rel  the file's path relative to server/, for the key
 */
function callSitesIn(text, rel) {
    const ast = /** @type {Node} */ (/** @type {unknown} */ (acorn.parse(text, {
        ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true,
    })));
    /** @type {Array<{ key: string, file: string, method: string, extra: string[], line: number }>} */
    const out = [];
    /** @type {Map<string, number>} */
    const seen = new Map();
    walk(ast, (node) => {
        if (node.type !== 'CallExpression' || calleeName(node.callee) !== 'establishSession') return;
        const opts = node.arguments[1];
        let method = 'unknown';
        /** @type {string[]} */
        let extra = [];
        if (opts && opts.type === 'ObjectExpression') {
            const audit = propertyValue(opts, 'audit');
            if (audit && audit.type === 'ObjectExpression') {
                const m = propertyValue(audit, 'method');
                if (m && m.type === 'Literal' && typeof m.value === 'string') method = m.value;
                else if (m && m.type === 'Identifier') method = '$' + m.name; // a variable: named, not resolved
                // `oauth:${provider}` → oauth:${}: the fixed text, the holes left as holes
                else if (m && m.type === 'TemplateLiteral') method = m.quasis.map((/** @type {Node} */ q, /** @type {number} */ i) => q.value.raw + (i < m.expressions.length ? '${}' : '')).join('');
            }
            const ex = propertyValue(opts, 'extra');
            if (ex && ex.type === 'ObjectExpression') extra = ex.properties.map((/** @type {Node} */ p) => (p.type === 'Property' ? propName(p) || '?' : '...')).sort();
        }
        const base = `${rel}#${method}{${extra.join(',')}}`;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        out.push({ key: n === 1 ? base : `${base}#${n}`, file: rel, method, extra, line: node.loc.start.line });
    });
    return out;
}

/**
 * Every call site under server/ (non-test .js/.cjs files), sorted by key.
 * @param {{ server?: string }} [opts]
 */
function scanLoginPaths({ server = SERVER } = {}) {
    /** @type {string[]} */
    const files = [];
    (function list(/** @type {string} */ dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'coverage') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) list(p);
            else if (/\.(?:js|cjs)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
        }
    })(server);
    const sites = [];
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        if (!text.includes('establishSession(')) continue;
        const rel = path.relative(server, f).split(path.sep).join('/');
        if (rel === 'auth/establishSession.js') continue; // the definition
        sites.push(...callSitesIn(text, rel));
    }
    return sites.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = { scanLoginPaths, callSitesIn };
