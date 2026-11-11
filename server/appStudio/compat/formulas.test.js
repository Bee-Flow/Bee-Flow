'use strict';

/**
 * Compat corpus: the expression engine still reads every formula of every stored app, and every
 * expression of its own golden corpus, exactly as it did before the collection functions, `??`,
 * list and object literals and author functions were added.
 *
 * formulaBaseline.json holds, for every text the engine could parse back then, a fingerprint of
 * the parsed tree and of its value (formulaBaseline.mts says how it was written). Green means
 * each of those parses to the same tree and gives the same value today, so everything that was
 * added could only be written in a formula that was an error before. formulaAdditions.json holds
 * the other half: the error the engine of that time gave for each addition.
 *
 * Run: cd server && node --test appStudio/compat/formulas.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const engine = require('../../shared/expr/index.mjs');
const { CASES, SCOPE } = require('../../shared/expr/corpus.mjs');
const { BASELINE_FILE, ADDITIONS_FILE, ADDITIONS, candidates, fingerprint, keyOf, parseError } = require('./formulaBaseline.mts');

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const all = candidates(CASES);

test('the baseline covers the corpus: every fingerprint belongs to a text that is still there', () => {
    const present = new Set(all.map(keyOf));
    const gone = Object.keys(baseline.entries).filter((k) => !present.has(k));
    assert.deepEqual(gone, [], 'a corpus text or golden case the baseline was written from is gone');
    assert.equal(Object.keys(baseline.entries).length, baseline.about.parsed);
    assert.ok(baseline.about.parsed > 2000, 'sanity: the baseline holds the formulas of the corpus');
});

test('every text the engine could parse before parses to the same tree and gives the same value', () => {
    const moved = [];
    for (const expr of all) {
        const before = baseline.entries[keyOf(expr)];
        if (before === undefined) continue; // rejected before, or added after the baseline
        if (fingerprint(engine, expr) !== before) moved.push(expr);
    }
    assert.deepEqual(moved, [], 'a formula that was valid before now parses or evaluates differently');
});

test('the work budget and the depth limit cannot reach a formula of the baseline', () => {
    // Both apply to what the engine gained (shared/expr/limits.mjs), and no text of the baseline
    // uses any of it: each keeps exactly the limits it had. Shown, too, with both set to nearly
    // nothing: every fingerprint stays.
    const limits = require('../../shared/expr/limits.mjs');
    const { COLLECTION_CASES } = require('../../shared/expr/corpusCollections.mjs');
    const known = all.filter((expr) => baseline.entries[keyOf(expr)] !== undefined);
    assert.deepEqual(known.filter((expr) => engine.exprSince(expr) !== 0), []);
    assert.equal(limits.getMaxWork(), limits.DEFAULT_MAX_WORK);
    assert.equal(limits.getMaxValueDepth(), limits.DEFAULT_MAX_VALUE_DEPTH);
    try {
        limits.setMaxWork(1);
        limits.setMaxValueDepth(1);
        assert.deepEqual(known.filter((expr) => fingerprint(engine, expr) !== baseline.entries[keyOf(expr)]), []);
        // The golden cases of the additions themselves stay far under the defaults (10,000,000
        // units, 100 levels): none is refused with ten thousand times less work and 8 levels.
        limits.setMaxWork(limits.DEFAULT_MAX_WORK / 10_000);
        limits.setMaxValueDepth(8);
        assert.ok(COLLECTION_CASES.length > 50, 'sanity: the additions have golden cases');
        const refused = [...CASES, ...COLLECTION_CASES].filter((c) => /EXPR_MAX_(WORK|VALUE_DEPTH)/.test(engine.tryEvaluate(c.expr, SCOPE).error || ''));
        assert.deepEqual(refused.map((c) => c.expr), []);
    } finally {
        limits.setMaxWork(limits.DEFAULT_MAX_WORK);
        limits.setMaxValueDepth(limits.DEFAULT_MAX_VALUE_DEPTH);
    }
});

const additions = JSON.parse(fs.readFileSync(ADDITIONS_FILE, 'utf8'));

test('the additions were errors before: the engine at the base refused every one of them', () => {
    // formulaAdditions.json was written by the engine at `about.base` (formulaBaseline.mts): the
    // parse error it gave for each text. The same base as the baseline, so both halves agree.
    assert.equal(additions.about.base, baseline.about.base);
    assert.deepEqual(Object.keys(additions.rejected), [...ADDITIONS], 'one recorded error per addition, none left out');
    for (const expr of ADDITIONS) {
        assert.match(additions.rejected[expr], /^ExprError: (Unknown function: \w+|Unexpected token: [[?]|Unexpected character in expression: \{)$/, `the base refused ${expr} as grammar it did not have`);
        assert.equal(baseline.entries[keyOf(expr)], undefined, `was not valid before: ${expr}`);
        assert.equal(parseError(engine, expr), null, `parses today: ${expr}`);
    }
});

test('every function the engine gained is among the additions, and nothing else was unknown', () => {
    const unknownAtBase = new Set(Object.values(additions.rejected).map((m) => /^ExprError: Unknown function: (\w+)$/.exec(m)?.[1]).filter(Boolean));
    const gained = engine.EXPR_FUNCTIONS.filter((f) => f.since !== undefined).map((f) => f.name);
    assert.deepEqual([...unknownAtBase].sort(), [...gained].sort());
    // Everything else was callable at the base, under the same name and in the same order.
    assert.deepEqual(engine.EXPR_FUNCTION_NAMES.filter((name) => !gained.includes(name)), additions.about.functions);
});

test('with the base commit at hand, its engine refuses every addition (skipped without it)', (t) => {
    const { execFileSync } = require('node:child_process');
    const os = require('node:os');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const base = baseline.about.base;
    const git = (args, opts) => execFileSync('git', args, { cwd: path.join(__dirname, '..', '..', '..'), stdio: ['ignore', 'pipe', 'ignore'], ...opts });
    let names;
    try { names = git(['ls-tree', '--name-only', `${base}:server/shared/expr`], { encoding: 'utf8' }).split('\n').filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')); } catch { return t.skip(`commit ${base} is not in this checkout`); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expr-base-'));
    try {
        for (const name of names) fs.writeFileSync(path.join(dir, name), git(['show', `${base}:server/shared/expr/${name}`]));
        return import(pathToFileURL(path.join(dir, 'index.mjs')).href).then((old) => {
            for (const expr of ADDITIONS) {
                assert.throws(() => old.parseExpr(expr), (e) => e instanceof old.ExprError && `${e.name}: ${e.message}` === additions.rejected[expr], `the base engine refuses ${expr}`);
            }
            assert.deepEqual(old.EXPR_FUNCTION_NAMES, additions.about.functions);
            // And the baseline is what that engine makes of the corpus, byte for byte.
            for (const expr of all) {
                const before = baseline.entries[keyOf(expr)];
                if (before !== undefined) assert.equal(fingerprint(old, expr), before, expr); // a later corpus file is not in it
            }
        }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw e;
    }
});
