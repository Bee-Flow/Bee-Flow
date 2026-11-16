/**
 * The theme ratchets have to DISCRIMINATE (count the class that bypasses the theme, leave the token form alone, skip
 * comments and brand logos) and, as a gate, REFUSE (a tree over budget fails, --update never raises the budget).
 * The gate cases run the real script in a throwaway repo under os.tmpdir().
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    countPalette, countAccentTextWhite, countBareTokens, countUndefinedVars, definedVars, inAdminScope, withoutComments,
} from './theme-ratchet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('admin-palette counts palette classes, hex and rgb literals, not tokens or comments', () => {
    assert.strictEqual(countPalette('<span className="bg-green-500/15 text-green-500 hover:border-red-400" />'), 3);
    assert.strictEqual(countPalette("const c = { color: '#10B981', bg: 'rgba(245,158,11,0.15)' };"), 2);
    assert.strictEqual(countPalette('<p className="[color:#f59e0b] bg-[#fff]" />'), 2);
    assert.strictEqual(countPalette('<p className="text-[var(--success-ink)] bg-[var(--bg-tertiary)] text-white" />'), 0);
    assert.strictEqual(countPalette('// was bg-blue-600 and #10b981\n/* rgba(0,0,0,1) */ const x = 1;'), 0);
    // A palette name without a shade is not a palette class; an HTML entity is not a colour.
    assert.strictEqual(countPalette('<p className="text-red border-gray">&#123;</p>'), 0);
});

test('admin-palette leaves SVG paint attributes (brand logos) alone', () => {
    const logo = '<svg><path fill="#f35325" d="M1 1h10" /><stop stopColor="#9B4AB0" /><path stroke={\'#fff\'} /></svg>';
    assert.strictEqual(countPalette(logo), 0);
    assert.strictEqual(countPalette(`${logo}<span className="text-amber-700" />`), 1);
});

test('admin-palette covers the admin directories only', () => {
    assert.ok(inAdminScope('components/admin/security/X.tsx'));
    assert.ok(inAdminScope('pages/settings/GoogleMapsRow.tsx'));
    assert.ok(!inAdminScope('components/chat/MessageItem.tsx'));
    assert.ok(!inAdminScope('components/administration/X.tsx'));
});

test('accent-text-white counts white text on the accent in one class list', () => {
    assert.strictEqual(countAccentTextWhite('<b className="px-4 bg-[var(--accent-primary)] text-white" />'), 1);
    assert.strictEqual(countAccentTextWhite('<b className={`p-1 ${on ? \'bg-[var(--accent-primary)] text-white\' : \'\'}`} />'), 1);
    assert.strictEqual(countAccentTextWhite("const PRIMARY_BUTTON = 'text-white shadow-md [background:var(--accent-primary)]';"), 1);
    assert.strictEqual(countAccentTextWhite('<b className="bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]" />'), 0);
    // The accent's hover or fg variable is not the accent background; white elsewhere is not on the accent.
    assert.strictEqual(countAccentTextWhite('<b className="hover:bg-[var(--accent-primary-hover)] text-white" />'), 0);
    assert.strictEqual(countAccentTextWhite('<b className="text-white bg-black" /><i className="bg-[var(--accent-primary)]" />'), 0);
    assert.strictEqual(countAccentTextWhite('// bg-[var(--accent-primary)] text-white\nconst a = 1;'), 0);
});

test('bare-text-token counts bare text classes and --border-color, not the var() form', () => {
    assert.strictEqual(countBareTokens('<p className="text-primary hover:text-muted text-secondary" />'), 3);
    assert.strictEqual(countBareTokens('<p className="border-[var(--border-color)]" />'), 1);
    assert.strictEqual(countBareTokens('<p className="text-[var(--text-primary)] text-[var(--text-muted)] border-[var(--border-default)]" />'), 0);
    assert.strictEqual(countBareTokens('<p className="text-primary-foo text-secondary/80" />'), 1);
});

test('undefined-css-var: declared in CSS or set at runtime is defined; the rest is counted', () => {
    const css = [{ rel: 'index.css', text: ':root { --text-primary: #fff; /* --ghost: 1 */ }\n.a { color: var(--nowhere); }' }];
    const sources = [
        { rel: 'a.tsx', text: "<div style={{ '--fam': c }} className=\"[--tile:4px]\" />; el.style.setProperty('--sel-top', y);" },
        { rel: 'a.test.tsx', text: "const s = { '--only-in-test': 1 };" },
        { rel: 'b.ts', text: "const v = getComputedStyle(el).getPropertyValue('--only-read'); el.style.removeProperty('--only-removed'); apply(['--in-list', c]);" },
    ];
    const defined = definedVars(css, sources);
    for (const name of ['text-primary', 'fam', 'tile', 'sel-top', 'in-list']) assert.ok(defined.has(name), name);
    for (const name of ['ghost', 'nowhere', 'only-in-test', 'only-read', 'only-removed']) assert.ok(!defined.has(name), name);
    const use = "color: 'var(--text-primary)'; a: 'var(--fam)'; b: 'var(--danger, #dc2626)'; c: 'var(--only-in-test)'; d: 'var(--tw-ring-color)'; // var(--x)";
    assert.strictEqual(countUndefinedVars(use, defined), 2);
});

test('withoutComments keeps strings that look like comments', () => {
    assert.strictEqual(withoutComments("const u = 'https://x'; // gone").trimEnd(), "const u = 'https://x';");
    assert.strictEqual(withoutComments('a { b: url(//cdn); } /* c */', { css: true }).trimEnd(), 'a { b: url(//cdn); }');
});

function sandbox(files, budget) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-ratchet-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['theme-ratchet.mjs', 'ratchet-budget.mjs', 'entry-point.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, 'pkg/src', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    if (budget !== undefined) fs.writeFileSync(path.join(dir, 'pkg/.admin-palette-ratchet.json'), JSON.stringify({ count: budget }));
    const run = (...extra) => spawnSync(process.execPath, ['scripts/theme-ratchet.mjs', 'admin-palette', 'pkg', ...extra], { cwd: dir, encoding: 'utf8' });
    const budgetNow = () => JSON.parse(fs.readFileSync(path.join(dir, 'pkg/.admin-palette-ratchet.json'), 'utf8')).count;
    return { dir, run, budgetNow };
}

const TWO = { 'components/admin/A.tsx': '<p className="text-red-500 bg-green-500/10" />', 'components/admin/A.test.tsx': '<p className="text-red-500" />' };

test('gate: over budget fails, at budget passes, tests not counted', (t) => {
    const over = sandbox(TWO, 1);
    t.after(() => fs.rmSync(over.dir, { recursive: true, force: true }));
    const r = over.run();
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /❌ pkg: 2 .* budget is 1/);

    const at = sandbox(TWO, 2);
    t.after(() => fs.rmSync(at.dir, { recursive: true, force: true }));
    const ok = at.run();
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /➖ pkg: 2 .* at budget/);
});

test('gate: --update lowers but never raises; --list alone writes no budget', (t) => {
    const s = sandbox(TWO, 5);
    t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
    assert.match(s.run().stdout, /✅ pkg: 2 .* under the budget of 5/);
    assert.strictEqual(s.run('--update').status, 0);
    assert.strictEqual(s.budgetNow(), 2);
    fs.writeFileSync(path.join(s.dir, 'pkg/src/components/admin/B.tsx'), '<p className="text-blue-600" />');
    s.run('--update');
    assert.strictEqual(s.budgetNow(), 2);

    const fresh = sandbox(TWO);
    t.after(() => fs.rmSync(fresh.dir, { recursive: true, force: true }));
    const listed = fresh.run('--list');
    assert.strictEqual(listed.status, 0);
    assert.match(listed.stdout, /2 {2}src\/components\/admin\/A\.tsx/);
    assert.ok(!fs.existsSync(path.join(fresh.dir, 'pkg/.admin-palette-ratchet.json')));
});

test('unknown metric is a usage error', () => {
    const r = spawnSync(process.execPath, [path.join(HERE, 'theme-ratchet.mjs'), 'nope', 'agent-hub'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
});
