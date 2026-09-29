#!/usr/bin/env node
/**
 * Count ratchets — for the metrics that are a pattern in the source.
 *
 * Same contract as scripts/ts-ratchet.mjs: each package commits the count it
 * may still carry (<package>/.<metric>-ratchet.json), CI fails when a change
 * raises it, and `--update` lowers it after a conversion. It never raises the
 * count. The conversions take months; the ratchet is what stops the number
 * drifting back up in the meantime. It did drift: between the measurement in
 * the plan and the day this gate landed, inline styles went from 10,889 to
 * 10,933 and files using fireEvent from 511 to 515. The four metrics added
 * for phase 6 drifted the same way before they had a gate: files mocking
 * through the module cache went from 589 to 824, files pairing authFetch with
 * useEffect from 171 to 236.
 *
 * Metrics (a pattern metric counts matches; a file metric counts files):
 *   inline-style      `style={{ … }}` objects. The target is a Tailwind class
 *                     on the theme variable (`text-[var(--x)]`,
 *                     `bg-[var(--x)]`), of which the tree already carries
 *                     thousands.
 *   fire-event        fireEvent calls that have a userEvent equivalent: click,
 *                     dblClick, change, input and the four hover events. The
 *                     low-level ones — keyDown, mouseDown, drag*, scroll — are
 *                     NOT counted: userEvent has nothing that replaces them,
 *                     so they may stay. A `change` on a range input is counted
 *                     but cannot be converted either; there are four, so the
 *                     floor of this metric is not quite zero.
 *   module-mock       test files that stub a dependency by reaching into the
 *                     module system (`require.cache`, `Module._load`,
 *                     `_resolveFilename`). The target is injection through the
 *                     stores' init()/factory seams (phase 2, point 6).
 *   authfetch-effect  non-test files that call authFetch AND use useEffect:
 *                     a fetch wired by hand into a component's lifecycle. The
 *                     target is useQuery/useMutation in src/api/queries/.
 *   big-file          source files longer than the package's limit (400 lines
 *                     in agent-hub, 800 in server), in physical lines like
 *                     `wc -l`. Tests, i18n dictionaries, generated files,
 *                     demo fixtures and content templates do not count: their
 *                     length is data, not structure.
 *   line-ref          comment lines that point at a line number (`L353`,
 *                     `file.js#L3922`). The comment policy: name a symbol,
 *                     never a position — every one of these had gone stale.
 *   dutch-comment     files with at least one comment line in Dutch (two
 *                     distinct Dutch function words on one comment line). The
 *                     comment policy is English in code; Dutch belongs in the
 *                     i18n dictionaries, which are not scanned.
 *
 * Usage:
 *   node scripts/count-ratchet.mjs <metric> <package>            gate
 *   node scripts/count-ratchet.mjs <metric> <package> --update   lower the budget
 *   node scripts/count-ratchet.mjs <metric> <package> --list     per-file counts, highest first
 *
 * Every metric scans <package>/src when the package has one, and the package
 * directory itself when it does not (server/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_FILE = /\.test\.[jt]sx?$/;

/** Physical lines, as `wc -l` counts them — the unit the plan measured in. */
const lineCount = (text) => (text.match(/\n/g) || []).length + (text.endsWith('\n') || text === '' ? 0 : 1);

const BIG_FILE_LIMIT = { 'agent-hub': 400, server: 800 };
const BIG_FILE_EXEMPT = /(^|\/)(i18n|generated|templates|fixtures)\/|\.generated\.|^scripts\/content\//;

const LINE_REF = /#L\d+|\b(?:at|on|see|zie|near|line)\s+~?L\d{2,}|\(L\d{2,}\)/i;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;
const DUTCH_WORD = /\b(?:het|een|niet|wordt|worden|zijn|maar|ook|deze|dit|naar|wanneer|omdat|zodat|alleen|nog|geen|hier|daar|dan|moet)\b/gi;

const countMatches = (pattern) => (text) => (text.match(pattern) || []).length;

const METRICS = {
    'inline-style': {
        measure: countMatches(/\bstyle=\{\s*\{/g),
        what: 'inline style objects',
        advice: 'use a Tailwind class on the theme variable (text-[var(--x)], bg-[var(--x)]) instead',
    },
    'fire-event': {
        measure: countMatches(/\bfireEvent\.(?:click|dblClick|change|input|mouseOver|mouseEnter|mouseOut|mouseLeave)\s*\(/g),
        what: 'fireEvent calls with a userEvent equivalent',
        advice: 'use `const user = userEvent.setup()` and `await user.click()` / `user.type()` / `user.hover()` instead',
    },
    'module-mock': {
        include: (rel) => TEST_FILE.test(rel),
        measure: (text) => (/require\.cache|Module\._load|_resolveFilename/.test(text) ? 1 : 0),
        what: 'test files mocking through the module system',
        advice: 'inject the dependency through the module\'s init()/factory seam instead',
    },
    'authfetch-effect': {
        include: (rel) => !TEST_FILE.test(rel),
        measure: (text) => (/\bauthFetch\b/.test(text) && /\buseEffect\b/.test(text) ? 1 : 0),
        what: 'files pairing authFetch with useEffect',
        advice: 'read through useQuery/useMutation in src/api/queries/ instead',
    },
    'big-file': {
        include: (rel) => !TEST_FILE.test(rel) && !BIG_FILE_EXEMPT.test(rel),
        measure: (text, pkg) => (lineCount(text) > (BIG_FILE_LIMIT[pkg] ?? 400) ? 1 : 0),
        what: 'files over the line limit',
        advice: 'split the file by responsibility (container, hooks, presentation; or one module per phase) instead',
    },
    'line-ref': {
        measure: (text) => {
            let n = 0;
            for (const line of text.split('\n')) if (COMMENT_LINE.test(line) && LINE_REF.test(line)) n++;
            return n;
        },
        what: 'comments pointing at a line number',
        advice: 'name the function or symbol instead — line numbers go stale with the next edit above them',
    },
    'dutch-comment': {
        // The dictionaries hold translations and translator notes; their
        // language is their content, not a comment-policy question.
        include: (rel) => !/(^|\/)i18n\//.test(rel),
        measure: (text) => {
            for (const line of text.split('\n')) {
                if (!COMMENT_LINE.test(line)) continue;
                const words = new Set((line.match(DUTCH_WORD) || []).map((w) => w.toLowerCase()));
                if (words.size >= 2) return 1;
            }
            return 0;
        },
        what: 'files with Dutch comments',
        advice: 'write the comment in English (Dutch belongs in the i18n dictionaries)',
    },
};

const args = process.argv.slice(2);
const [metricName, pkg] = args.filter((a) => !a.startsWith('--'));
const metric = METRICS[metricName];
if (!metric || !pkg) {
    console.error(`count-ratchet: usage: node scripts/count-ratchet.mjs <${Object.keys(METRICS).join('|')}> <package> [--update] [--list]`);
    process.exit(2);
}
const update = args.includes('--update');
const list = args.includes('--list');

const dir = path.resolve(ROOT, pkg);
const srcDir = fs.existsSync(path.join(dir, 'src')) ? path.join(dir, 'src') : dir;
const scanned = path.relative(dir, srcDir) || '.';
const under = scanned === '.' ? `in ${pkg}` : `under ${scanned}`;
const budgetFile = path.join(dir, `.${metricName}-ratchet.json`);

// Same fence as the TypeScript ratchet: a vendored copy or a build artefact
// must not be able to move the count in either direction.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite']);

function collect(from, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, into);
        } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name)) {
            into.push(full);
        }
    }
    return into;
}

if (!fs.existsSync(dir)) {
    console.error(`count-ratchet: ${path.relative(ROOT, dir) || pkg} not found — is "${pkg}" a package directory?`);
    process.exit(2);
}

const rows = [];
let count = 0;
for (const file of collect(srcDir, [])) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (metric.include && !metric.include(path.relative(srcDir, file).split(path.sep).join('/'))) continue;
    const n = metric.measure(fs.readFileSync(file, 'utf8'), pkg);
    if (n === 0) continue;
    count += n;
    rows.push([n, rel]);
}

if (list) {
    rows.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    for (const [n, file] of rows) console.log(`${String(n).padStart(5)}  ${file}`);
    console.log('');
}

const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;

if (update || !existing) {
    const next = {
        _comment: `Highest number of ${metric.what} ${path.relative(ROOT, srcDir).split(path.sep).join('/')} may still carry. Lower it with \`node scripts/count-ratchet.mjs ${metricName} ${pkg} --update\` after a conversion; raising it is a deliberate edit that belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        count: existing ? Math.min(count, existing.count) : count,
    };
    fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${next.count} ${metric.what} (measured ${count} in ${rows.length} files)`);
    process.exit(0);
}

if (count > existing.count) {
    console.error(`❌ ${pkg}: ${count} ${metric.what} ${under}, budget is ${existing.count} — ${metric.advice} rather than raising the budget (\`--list\` shows where they are)`);
    process.exit(1);
}
if (count < existing.count) {
    console.log(`✅ ${pkg}: ${count} ${metric.what} ${under}, under the budget of ${existing.count}. Run \`node scripts/count-ratchet.mjs ${metricName} ${pkg} --update\` to lower it.`);
} else {
    console.log(`➖ ${pkg}: ${count} ${metric.what} ${under}, at budget`);
}
