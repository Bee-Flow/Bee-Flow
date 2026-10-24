// @typecheck
/**
 * Guard: the dependency rule from ARCHITECTURE.md, enforced.
 *
 * Every top-level entry of server/ (folder or loose .js file) sits in exactly
 * one layer, and dependencies point DOWNWARD only:
 *
 *     tooling   scripts/, testUtils/, CLIs   may require anything; the app never requires it
 *     entry     index.js, boot/, …           composition roots: wiring is their whole job
 *     api       routes/, auth/ routers       may require anything below
 *     feature   automation/, projects/, …    may require core + platform, NOT each other
 *     core      core/                        may require platform, NOT a feature
 *     platform  stores/, auth/, utils/, …    may require platform
 *     data      assets/, data/, prompts/     no code; not scanned
 *
 * LAYERS below is the whole classification, and the first test fails when a
 * top-level entry is missing from it: a new folder has to say where it lives.
 *
 * THE RATCHET. Every UPWARD edge (a require into a higher layer) and every
 * edge between two different features is counted per pair of units
 * (`stores -> core`, `core -> automation`, …) and compared with the budget in
 * server/.layering-ratchet.json. A pair missing from the file has budget 0. A
 * count may go down, never up; the test fails when a pair grows and names the
 * requires that make it up. Each require call counts, lazy ones included: the
 * whole file is scanned, function bodies too, not only the top-level requires
 * (comment lines are skipped). The lazy require is exactly how most of these
 * edges hide, so it is not a way around the budget.
 *
 *   node --test server/layering.test.js         the gate (also `npm run lint:layering-ratchet`)
 *   node server/layering.test.js --list         every counted pair, its count and budget
 *   node server/layering.test.js --update       lower the budget to the measured counts
 *
 * `--update` only lowers (and drops pairs that reached 0). Raising a pair is a
 * deliberate hand edit of the JSON that belongs in a commit message with a
 * reason — normally the answer is to move the shared piece down instead.
 *
 * CLASSIFICATION NOTES, because the data corrected the document more than once.
 * `license/` and `modules/` were first written down as features. They are not:
 * they answer "what tier is this org on, which capabilities does it hold" — the
 * same kind of cross-cutting question as auth, and core/entitlements/ is
 * *supposed* to depend on them. `core/entitlements/` answers that identical
 * question and is platform beside them; and the Express routers inside `auth/`
 * (`auth/…Routes.js`) are API surface, not platform. Mislabelling those routers
 * had a concrete cost: `core/http/validate` lives under core/, so a single zod
 * schema in an auth router read as a platform -> core violation. `boot/` is
 * start-up wiring (the migration ladder, background start-up tasks): a
 * composition root beside index.js, not platform. `migrations/` are run by that
 * ladder and may require anything, so they are `entry` too.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BUDGET_FILE = path.join(ROOT, '.layering-ratchet.json');

const RANK = { data: 0, platform: 1, core: 2, feature: 3, api: 4, entry: 5, tooling: 6 };

/** Unit -> layer. A unit is a top-level folder or file, plus the refinements in unitOf(). */
const LAYERS = {
    // tooling: test support, CLIs and separate containers.
    scripts: 'tooling', testUtils: 'tooling', types: 'tooling',
    'pwt-runner': 'tooling', 'terminal-runner': 'tooling',
    'migrateDb.js': 'tooling', 'reset-nc.js': 'tooling', 'seed-plans.js': 'tooling',
    'eslint.config.js': 'tooling',
    // entry: composition roots and start-up.
    'index.js': 'entry', 'auth/router.js': 'entry', boot: 'entry', 'boot-init.js': 'entry',
    migrations: 'entry',
    // api: HTTP surface.
    routes: 'api', 'auth/routers': 'api',
    // feature: one product surface each. jobs/ and workers/ are the scheduled
    // and background halves of features; services/ and agents/ are features
    // until they are split up or moved down.
    automation: 'feature', integrations: 'feature', services: 'feature', jobs: 'feature',
    projects: 'feature', agents: 'feature', workers: 'feature', support: 'feature',
    compliance: 'feature', appStudio: 'feature', cms: 'feature', cmsBuilder: 'feature',
    learning: 'feature', legal: 'feature', eval: 'feature', pipeline: 'feature',
    mcpServers: 'feature', playbooks: 'feature',
    // core: what Bee Flow is.
    core: 'core',
    // platform: infrastructure that knows nothing about a product surface.
    stores: 'platform', auth: 'platform', utils: 'platform', middleware: 'platform',
    telemetry: 'platform', license: 'platform', modules: 'platform', shared: 'platform',
    i18n: 'platform', config: 'platform', 'core/entitlements': 'platform',
    templates: 'platform', 'db.js': 'platform', 'storeModules.js': 'platform',
    'version.js': 'platform', 'package.json': 'platform',
    // data: no code.
    data: 'data', assets: 'data', prompts: 'data',
};

/** Never scanned and never classified: not part of the source tree. */
const IGNORED = new Set(['node_modules', 'coverage']);

/**
 * The routers inside auth/: `auth/loginRoutes.js`, `auth/login/currentUserRoutes.js`,
 * … and auth/securityKeys/index.js, which builds and exports the two
 * security-key routers.
 */
const AUTH_ROUTER = /^auth\/(.*Routes\.js|securityKeys\/index\.js)$/;

/** Which unit a server-relative posix path belongs to. */
function unitOf(rel) {
    if (AUTH_ROUTER.test(rel)) return 'auth/routers';
    if (rel === 'auth/router.js') return 'auth/router.js';
    if (rel === 'core/entitlements' || rel.startsWith('core/entitlements/')) return 'core/entitlements';
    return rel.split('/')[0];
}

const CODE = /\.(c|m)?js$/;
const TEST_CODE = /\.test\.(c|m)?js$|\.testkit\.js$/;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (dir === ROOT && LAYERS[e.name] === 'data') continue;
            walk(full, out);
        } else if (CODE.test(e.name) && !TEST_CODE.test(e.name)) out.push(full);
    }
    return out;
}

/** The file a relative require lands on, as Node would pick it (enough of it). */
function resolveTarget(abs) {
    for (const c of [abs, abs + '.js', abs + '.cjs', abs + '.json',
        path.join(abs, 'index.js'), path.join(abs, 'index.cjs')]) {
        try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }
    }
    return abs;
}

const REQUIRE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const posix = (p) => p.split(path.sep).join('/');

/** Every relative require between two different units: { from, to, at, target }. */
function edges() {
    const out = [];
    for (const file of walk(ROOT)) {
        const rel = posix(path.relative(ROOT, file));
        const from = unitOf(rel);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (COMMENT_LINE.test(line)) return;
            for (const m of line.matchAll(REQUIRE)) {
                const target = posix(path.relative(ROOT, resolveTarget(path.resolve(path.dirname(file), m[1]))));
                if (target.startsWith('..')) continue;
                const to = unitOf(target);
                if (to !== from) out.push({ from, to, at: `${rel}:${i + 1}`, target });
            }
        });
    }
    return out;
}

/** Upward, or sideways between two features: the edges the rule forbids. */
function isCounted(from, to) {
    const a = LAYERS[from], b = LAYERS[to];
    if (!a || !b) return false;
    if (RANK[b] > RANK[a]) return true;
    return a === 'feature' && b === 'feature' && from !== to;
}

const ALL = edges();
const COUNTED = ALL.filter(e => isCounted(e.from, e.to));
const pairKey = (e) => `${e.from} -> ${e.to}`;

function measure() {
    const counts = {};
    for (const e of COUNTED) counts[pairKey(e)] = (counts[pairKey(e)] || 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function readBudget() {
    try { return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); } catch { return null; }
}

const COMMENT = 'Highest number of requires per upward (or feature-to-feature) pair of units server/ may still carry; a pair not listed has budget 0. Lower it with `node server/layering.test.js --update` after removing edges; raising a pair is a deliberate edit that belongs in a commit message with a reason. The layers are in the header of server/layering.test.js.';

if (require.main === module && process.argv.includes('--update')) {
    const measured = measure();
    const existing = readBudget();
    const pairs = {};
    for (const [k, n] of Object.entries(measured)) {
        const cap = existing ? (existing.pairs || {})[k] ?? 0 : n;
        const next = Math.min(cap, n);
        if (next > 0) pairs[k] = next;
    }
    // A pair that grew keeps its old budget (the min above), so the gate still
    // fails on it; a pair that is new gets 0, so it is not written at all.
    const sorted = Object.fromEntries(Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b)));
    const total = Object.values(sorted).reduce((s, n) => s + n, 0);
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({
        _comment: COMMENT,
        _generated: new Date().toISOString().slice(0, 10),
        total,
        pairs: sorted,
    }, null, 2) + '\n');
    console.log(`layering: wrote ${Object.keys(sorted).length} pairs, ${total} requires, to ${path.relative(process.cwd(), BUDGET_FILE)}`);
}

if (require.main === module && process.argv.includes('--list')) {
    const budget = (readBudget() || {}).pairs || {};
    for (const [k, n] of Object.entries(measure())) {
        const [from, to] = k.split(' -> ');
        console.log(`${String(n).padStart(5)} / ${String(budget[k] ?? 0).padEnd(5)} ${k}   (${LAYERS[from]} -> ${LAYERS[to]})`);
    }
}

test('every top-level entry of server/ is classified into a layer', () => {
    const missing = [];
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
        if (!e.isDirectory() && (!CODE.test(e.name) || TEST_CODE.test(e.name))) continue;
        if (!LAYERS[e.name]) missing.push(e.name);
    }
    assert.deepStrictEqual(missing, [],
        'add each to LAYERS in server/layering.test.js (and to server/ARCHITECTURE.md):\n  ' + missing.join('\n  '));
    const unknown = [...new Set(ALL.map(e => e.to).filter(u => !LAYERS[u]))];
    assert.deepStrictEqual(unknown, [], 'requires land on unclassified units:\n  ' + unknown.join('\n  '));
});

test('no upward or feature-to-feature pair grows past .layering-ratchet.json', () => {
    const budgetFile = readBudget();
    assert.ok(budgetFile && budgetFile.pairs, `${path.basename(BUDGET_FILE)} is missing; run \`node server/layering.test.js --update\``);
    const budget = budgetFile.pairs;
    const measured = measure();
    const grown = [];
    for (const [k, n] of Object.entries(measured)) {
        const cap = budget[k] ?? 0;
        if (n <= cap) continue;
        const sites = COUNTED.filter(e => pairKey(e) === k).map(e => `${e.at} -> ${e.target}`);
        const shown = sites.length > 25 ? [...sites.slice(0, 25), `… and ${sites.length - 25} more (--list)`] : sites;
        grown.push(`${k}: ${n} requires, budget ${cap}\n    ${shown.join('\n    ')}`);
    }
    assert.deepStrictEqual(grown, [],
        'a layer edge grew; move the shared piece down (or pass it in) instead of raising the budget:\n  ' + grown.join('\n  '));
});

test('.layering-ratchet.json names only real upward pairs', () => {
    const budget = (readBudget() || {}).pairs || {};
    const bad = Object.keys(budget).filter(k => {
        const [from, to] = k.split(' -> ');
        return !to || !isCounted(from, to) || !Number.isInteger(budget[k]) || budget[k] < 1;
    });
    assert.deepStrictEqual(bad, [], 'not an upward or feature-to-feature pair with a positive count:\n  ' + bad.join('\n  '));
});

test('nothing below the API layer requires a router', () => {
    // Zero, and it stays zero (it is not in the budget file, and may not be):
    // whatever a module below routes/ is reaching up for was never HTTP. The
    // support feature's helpers live in support/ now, and the MCP signer the
    // token CLI needed is auth/mcpToken.js. Composition roots (index.js,
    // auth/router.js, boot/) and tooling are above the API layer and exempt.
    const bad = [...new Set(ALL
        .filter(e => LAYERS[e.to] === 'api' && RANK[LAYERS[e.from]] < RANK.api)
        .map(e => `${e.at} -> ${e.target}`))];
    assert.deepStrictEqual(bad, [], 'upward edges into the API layer:\n  ' + bad.join('\n  '));
});

// Measured when this guard landed; lower it when you remove an edge.
const LICENSE_MODULES_CYCLE = 9;

test('the license <-> modules cycle does not grow', () => {
    // Legal within the platform layer, so the pair ratchet does not see it.
    const n = ALL.filter(e =>
        (e.from === 'license' && e.to === 'modules') ||
        (e.from === 'modules' && e.to === 'license')).length;
    assert.ok(n <= LICENSE_MODULES_CYCLE,
        `license<->modules edges grew from ${LICENSE_MODULES_CYCLE} to ${n}; break the cycle rather than adding to it`);
});
