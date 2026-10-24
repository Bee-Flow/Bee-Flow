/**
 * catch-classify: the classifier has to put each shape in its bucket, the rewrite has to touch the
 * span it names and nothing else, and the count has to leave parse-or-default alone. Fixtures are
 * in-memory texts under a server/ path; nothing is read from or written to the tree.
 */

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let hasTs = false;
try { createRequire(new URL('../agent-hub/package.json', import.meta.url))('typescript'); hasTs = true; } catch { /* not installed */ }
const t = hasTs ? test : test.skip;

import { execFileSync } from 'node:child_process';

const dedupeModule = hasTs ? await import('./catch-classify.mjs') : {};
const { scanText, rewriteText, countSwallowed } = dedupeModule;
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const at = (rel) => path.join(SERVER, rel);
const buckets = (text, rel = 'routes/thing.js') => scanText(text, at(rel)).map((s) => s.bucket);
const rewrite = (text, rel = 'routes/thing.js', which = ['optional-table', 'lazy-require', 'fallback', 'best-effort']) => rewriteText(text, at(rel), which);

const HEAD = "'use strict';\nconst log = require('../telemetry/log');\n";

t('a debug-only catch around a side effect is best-effort', () => {
    const src = `${HEAD}async function f() {\n    try {\n        await notify();\n    } catch (e) {\n        log.debug('notify is optional', e);\n    }\n}\n`;
    assert.deepStrictEqual(buckets(src), ['best-effort']);
    const out = rewrite(src);
    assert.strictEqual(out.text, `${HEAD}const { bestEffort } = require('../utils/bestEffort');\nasync function f() {\n    try {\n        await notify();\n    } catch (e) {\n        bestEffort('routes/thing:f', e); // notify is optional\n    }\n}\n`);
});

t('a catch that leaves an outer default in place is a fallback', () => {
    const src = `${HEAD}async function f() {\n    let n = 0;\n    try { n = await count(); } catch (e) { log.debug('count unavailable', e); }\n    return n;\n}\n`;
    assert.deepStrictEqual(buckets(src), ['fallback']);
    const out = rewrite(src);
    assert.match(out.text, /catch \(e\) \{ fallback\('routes\/thing:f', e\); \/\* count unavailable \*\/ \}/);
    assert.match(out.text, /const \{ fallback \} = require\('\.\.\/utils\/bestEffort'\);/);
});

t('a missing-table message plus a query gets the isMissingTable guard in front of the log line', () => {
    const src = `${HEAD}async function f(db) {\n    try {\n        await db.query('SELECT 1 FROM optional_things');\n    } catch (e) {\n        log.debug('table may not exist yet', e);\n    }\n}\n`;
    assert.deepStrictEqual(buckets(src), ['optional-table']);
    const out = rewrite(src);
    assert.match(out.text, /catch \(e\) \{\n {8}if \(!isMissingTable\(e\)\) throw e;\n {8}log\.debug\('table may not exist yet', e\);/);
    assert.match(out.text, /const \{ isMissingTable \} = require\('\.\.\/utils\/isMissingTable'\);/);
});

t('a try that only requires gets the MODULE_NOT_FOUND guard', () => {
    const src = `${HEAD}let optional = null;\ntry { optional = require('./optional'); } catch (e) { log.debug('not shipped in this build', e); }\n`;
    assert.deepStrictEqual(buckets(src), ['lazy-require']);
    const out = rewrite(src);
    assert.match(out.text, /catch \(e\) \{ if \(e\?\.code !== 'MODULE_NOT_FOUND'\) throw e; log\.debug\('not shipped in this build', e\); \}/);
    assert.ok(!out.text.includes('utils/bestEffort'), 'no helper import for a guard that needs none');
});

t('a try with a require and a call is not a lazy-require', () => {
    const src = `${HEAD}try { require('./x').run(); } catch (e) { log.debug('x failed', e); }\n`;
    assert.deepStrictEqual(buckets(src), ['best-effort']);
});

t('auth, licence and access-deciding code is security-relevant and never rewritten', () => {
    const inAuth = `${HEAD}try { await check(); } catch (e) { log.debug('ignore', e); }\n`;
    assert.deepStrictEqual(buckets(inAuth, 'auth/session.js'), ['security-relevant']);
    assert.strictEqual(rewrite(inAuth, 'auth/session.js').text, null);
    const byBody = `${HEAD}try { await db.query('DELETE FROM sessions WHERE id = $1', [id]); } catch (e) { log.debug('ignore', e); }\n`;
    assert.deepStrictEqual(buckets(byBody), ['security-relevant']);
    const byPromise = `${HEAD}permissions.load(user).catch(() => null);\n`;
    assert.deepStrictEqual(buckets(byPromise), ['security-relevant']);
});

t('a promise catch is best-effort as a statement and a fallback when its value is used', () => {
    const src = `${HEAD}async function f() {\n    await sendMail().catch(() => {});\n    const rows = await load().catch(() => []);\n    const one = await pick().catch(() => null);\n    return [rows, one];\n}\n`;
    assert.deepStrictEqual(buckets(src), ['best-effort', 'fallback', 'fallback']);
    const out = rewrite(src).text;
    assert.match(out, /await sendMail\(\)\.catch\(\(e\) => bestEffort\('routes\/thing:f', e\)\);/);
    assert.match(out, /load\(\)\.catch\(\(e\) => fallback\('routes\/thing:f#2', e, \[\]\)\);/);
    assert.match(out, /pick\(\)\.catch\(\(e\) => fallback\('routes\/thing:f#3', e, null\)\);/);
});

t('parse-or-default and absent-or-default promises are not swallowed errors', () => {
    const src = `${HEAD}async function f(res, p) {\n    const body = await res.json().catch(() => null);\n    const st = await fs.promises.stat(p).catch(() => null);\n    const t = await fsp.readFile(p).catch(() => null);\n    return [body, st, t];\n}\n`;
    assert.strictEqual(countSwallowed(src, at('routes/thing.js')), 0);
});

t('count: debug-only, empty and promise sites; a catch that does more is not counted', () => {
    const src = `${HEAD}try { a(); } catch (e) { log.debug('x', e); }\ntry { b(); } catch {}\nc().catch(() => null);\ntry { d(); } catch (e) { log.warn('d', e); }\ntry { f(); } catch (e) { log.debug('x', e); throw e; }\nconst v = g().catch(() => 'x');\n`;
    assert.strictEqual(countSwallowed(src, at('routes/thing.js')), 3);
});

t('a helper name already used in the file is imported under an alias, not shadowed', () => {
    const src = `${HEAD}function fallback(x) { return x; }\nasync function f() {\n    const a = fallback(1);\n    return await load().catch(() => null) ?? a;\n}\n`;
    const out = rewrite(src).text;
    assert.match(out, /const \{ fallback: fallbackSwallowed \} = require\('\.\.\/utils\/bestEffort'\);/);
    assert.match(out, /\.catch\(\(e\) => fallbackSwallowed\('routes\/thing:f', e, null\)\)/);
    assert.match(out, /const a = fallback\(1\);/);
});

t('a one-line catch with a message keeps parsing, and an empty catch gets a binding', () => {
    const src = `${HEAD}try { a(); } catch (err) { log.debug('fall back to global', err); }\ntry { b(); } catch {}\ntry { c(); } catch { }\n`;
    const out = rewrite(src).text;
    assert.match(out, /catch \(err\) \{ bestEffort\('routes\/thing:anon', err\); \/\* fall back to global \*\/ \}/);
    assert.match(out, /catch \(e\) \{ bestEffort\('routes\/thing:anon#2', e\); \}/);
});

t('an "already closed" cleanup, a log without a binding and a script stay unknown', () => {
    const closed = `${HEAD}try { s.close(); } catch (e) { log.debug('already closed', e); }\n`;
    assert.deepStrictEqual(buckets(closed), ['unknown']);
    const unbound = `${HEAD}try { a(); } catch { log.debug('nope'); }\n`;
    assert.deepStrictEqual(buckets(unbound), ['unknown']);
    const dropped = `${HEAD}try { a(); } catch (e) { log.debug('x: ' + e.message); }\n`;
    assert.deepStrictEqual(buckets(dropped), ['best-effort']);
    assert.deepStrictEqual(buckets(`${HEAD}try { a(); } catch (e) { log.debug('x', e); }\n`, 'scripts/tool.js'), ['unknown']);
});

t('an ES module gets an import with the .js specifier', () => {
    const src = `import log from '../telemetry/log.js';\nexport async function f() {\n    await g().catch(() => {});\n}\n`;
    const out = rewrite(src, 'routes/thing.mjs').text;
    assert.match(out, /import \{ bestEffort \} from '\.\.\/utils\/bestEffort\.js';/);
});

t('the rewrite changes only the named spans', () => {
    const src = `${HEAD}// keep me\nasync function f() {\n    await a().catch(() => {});   // trailing\n    return 1;\n}\n`;
    const out = rewrite(src).text;
    const strip = (s) => s.replace(/const \{ bestEffort \} = require\('\.\.\/utils\/bestEffort'\);\n/, '').replace("(e) => bestEffort('routes/thing:f', e)", '() => {}');
    assert.strictEqual(strip(out), src);
});

t('dedupe: both codes tested by hand become isMissingTable; a 42P01-only check stays', () => {
    const src = `${HEAD}const NOT_PROVISIONED = new Set(['42P01', '42703']);\nfunction a(e) { return e && (e.code === '42703' || e.code === '42P01'); }\nfunction b(e) { return NOT_PROVISIONED.has(e?.code); }\nfunction c(e) { return e?.code === '42P01'; }\n`;
    const { dedupeMissingTable } = dedupeModule;
    const out = dedupeMissingTable(src, at('compliance/x.js'));
    assert.strictEqual(out.applied, 2);
    assert.ok(!out.text.includes('NOT_PROVISIONED'), 'the unused set is gone');
    assert.match(out.text, /function a\(e\) \{ return isMissingTable\(e\); \}/);
    assert.match(out.text, /function b\(e\) \{ return isMissingTable\(e\); \}/);
    assert.match(out.text, /function c\(e\) \{ return e\?\.code === '42P01'; \}/);
    assert.match(out.text, /const \{ isMissingTable \} = require\('\.\.\/utils\/isMissingTable'\);/);
});

t('the swallowed-error ratchet passes on the committed tree and lists its files', () => {
    const run = (args) => execFileSync(process.execPath, [path.join(SERVER, '..', 'scripts', 'count-ratchet.mjs'), 'swallowed-error', 'server', ...args], { encoding: 'utf8' });
    assert.match(run([]), /at budget|under budget/);
    assert.match(run(['--list']), /^ *\d+  \S+\.js$/m);
});
