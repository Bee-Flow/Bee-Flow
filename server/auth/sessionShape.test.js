'use strict';

/**
 * What the session may hold: every `req.session.<key> = …` in the server is a
 * key declared in auth/sessionShape.json. The session row (user_sessions) and
 * its Redis copy are readable by whoever reads the database, so the list of
 * what lands there is reviewed, not accidental.
 *
 * Three rules, static on purpose (an assignment is a textual fact):
 *   - a key not in `keys` fails: declare it, then it may land;
 *   - a key in `forbidden` (password, passwordHash) never appears, not even as a
 *     property of an object written to the session — except inside mfaPending
 *     while `pendingPasswordAllowed` is true, a flag that may only flip to false;
 *   - a key in `sealed` is written through the sealing helper, not in clear.
 *     `plaintextAllowed` lists the sealed keys still written in clear today; it
 *     may only shrink. (The sealing helper does not exist yet: today the two
 *     lists are equal, and this test pins that they cannot grow.)
 *
 * Run: cd server && node --test auth/sessionShape.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('../testUtils/routeSurfaceSweep');

const SERVER = path.resolve(__dirname, '..');
const shape = require('./sessionShape.json');

// `session.key = value` and `req.session.key = value`; `==` and `=>` are not assignments.
const ASSIGN = /\bsession\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
// A method patched onto the session object (establishSession.js suppressSessionPersistence).
const FUNCTION_RHS = /^\s*(?:async\s*)?(?:\(|function\b|[\w$]+\s*=>)/;

function sourceFiles() {
    const out = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'coverage') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(?:js|mts|cjs)$/.test(e.name) && !/\.test\./.test(e.name) && !p.includes(`${path.sep}testUtils${path.sep}`)) out.push(p);
        }
    })(SERVER);
    return out;
}

/** The brace-balanced text after `= {`, or '' when the right-hand side is not an object literal. */
function objectLiteralAfter(code, from) {
    const open = code.indexOf('{', from);
    if (open < 0 || !/^\s*\{/.test(code.slice(from, open + 1))) return '';
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
    }
    return '';
}

/** Property names of a one-level object literal: `a: 1, b, ...rest` → ['a', 'b']. */
function literalKeys(obj) {
    const inner = obj.slice(1, -1);
    const keys = [];
    let depth = 0;
    let token = '';
    const flush = () => {
        const t = token.trim();
        token = '';
        if (!t || t.startsWith('...')) return;
        const m = t.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
        if (m) keys.push(m[1]);
    };
    for (const c of inner) {
        if ('{[('.includes(c)) depth++;
        else if ('}])'.includes(c)) depth--;
        if (c === ',' && depth === 0) { flush(); continue; }
        token += c;
    }
    flush();
    return keys;
}

const writes = [];
for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('session.') && !text.includes('session .')) continue;
    const code = stripComments(text);
    const rel = path.relative(SERVER, file).split(path.sep).join('/');
    for (const m of code.matchAll(ASSIGN)) {
        const rhsStart = m.index + m[0].length;
        const rhs = code.slice(rhsStart, rhsStart + 80);
        if (FUNCTION_RHS.test(rhs)) continue;
        const literal = objectLiteralAfter(code, rhsStart);
        writes.push({ file: rel, key: m[1], literalKeys: literal ? literalKeys(literal) : [] });
    }
}

test('the scan sees the login code', () => {
    assert.ok(writes.length >= 60, `suspiciously few session writes found (${writes.length})`);
    assert.ok(writes.some((w) => w.key === 'user'), 'no write of session.user found: the scan is broken');
});

test('every session key the server writes is declared', () => {
    const declared = new Set(shape.keys);
    const unknown = [...new Set(writes.filter((w) => !declared.has(w.key)).map((w) => `${w.key} (${w.file})`))];
    assert.deepEqual(unknown, [],
        `session keys written but not declared in auth/sessionShape.json:\n  ${unknown.join('\n  ')}\n` +
        'Declare the key (and, if it holds a secret, add it to `sealed` and write it through the sealing helper).');
});

test('no forbidden key lands in the session, except the password in mfaPending while that is still allowed', () => {
    const forbidden = new Set(shape.forbidden);
    const direct = writes.filter((w) => forbidden.has(w.key)).map((w) => `${w.key} (${w.file})`);
    assert.deepEqual(direct, [], `forbidden session keys written: ${direct.join(', ')}`);
    const nested = writes
        .filter((w) => w.literalKeys.some((k) => forbidden.has(k)))
        .filter((w) => !(w.key === 'mfaPending' && shape.pendingPasswordAllowed))
        .map((w) => `${w.key}.{${w.literalKeys.filter((k) => forbidden.has(k)).join(',')}} (${w.file})`);
    assert.deepEqual(nested, [], `objects written to the session carrying a forbidden key: ${nested.join(', ')}`);
});

test('the pending-password allowance is an honest flag', () => {
    const carries = writes.some((w) => w.key === 'mfaPending' && w.literalKeys.includes('password'));
    if (!carries) {
        assert.equal(shape.pendingPasswordAllowed, false,
            'mfaPending no longer carries the password: set pendingPasswordAllowed to false in auth/sessionShape.json so it cannot come back');
    }
});

test('sealed keys: the plaintext allowance only shrinks and names sealed keys only', () => {
    const sealed = new Set(shape.sealed);
    for (const k of shape.plaintextAllowed) assert.ok(sealed.has(k), `${k} is in plaintextAllowed but not in sealed`);
    const declared = new Set(shape.keys);
    for (const k of shape.sealed) assert.ok(declared.has(k), `${k} is sealed but not a declared key`);
});

test('synthetic: the key scan reads shorthand and explicit properties, and skips method patches', () => {
    assert.deepEqual(literalKeys('{ userId: user.id, isAdmin, user, password }'), ['userId', 'isAdmin', 'user', 'password']);
    assert.deepEqual(literalKeys('{ a: { b: 1, c: 2 }, ...rest, d }'), ['a', 'd']);
    assert.equal(objectLiteralAfter(' = { a: 1 };', 2), '{ a: 1 }');
    assert.equal(objectLiteralAfter(' = foo({ a: 1 });', 2), '');
    assert.ok(FUNCTION_RHS.test(' (cb) => { if (cb) cb(); }'));
    assert.ok(!FUNCTION_RHS.test(' result.encryptionKey;'));
});
