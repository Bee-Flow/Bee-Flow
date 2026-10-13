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
 *   authfetch-outside-api  non-test files outside src/api/ that call
 *                     authFetch themselves (utils/helpers.js, where it is
 *                     defined, not counted). The data layer is src/api/:
 *                     apiClient / createJsonResource (client.ts), mutate()
 *                     and the readers in api/queries/; a call written by hand
 *                     elsewhere is one more copy of URL, headers and error
 *                     handling.
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
 *   status-5xx        `.status(5xx)` calls with a literal 5xx status in non-test
 *                     code: a route that answers a server failure by hand. The
 *                     convention is to throw an HttpError (or next(err)) and
 *                     let core/http/terminalErrorHandler.js answer with a
 *                     correlation id. The eslint rule already forbids echoing
 *                     err.message in these; this metric counts all of them, so
 *                     the hand-written 5xx responses can only go down.
 *   sse-head          a `text/event-stream` head written by hand outside
 *                     core/http/ (an object-literal or setHeader
 *                     Content-Type, or res.type()), in non-test code. The
 *                     convention is openSse() from core/http/sseHelpers.js:
 *                     the head, the guarded send, the client-stop signal and
 *                     the keep-alive in one call, so a route cannot forget
 *                     one of them. Reading the header (boot/requestTiming.js)
 *                     or asking for it (an Accept header) is not counted.
 *   local-zod-helper  top-level declarations in routes/ and auth/ (non-test)
 *                     named after a helper of core/http/schemaParts.js
 *                     (worded, bodyOf, queryOf, choice, flag, wholeNumber,
 *                     idList, closedObject, orEmpty): a route re-declaring
 *                     the shared zod pieces. The ones left differ in
 *                     wording or defaults from the shared helper, so they
 *                     stay until someone words them the shared way.
 *   dutch-comment     files with at least one comment line in Dutch (two
 *                     distinct Dutch function words on one comment line). The
 *                     comment policy is English in code; Dutch belongs in the
 *                     i18n dictionaries, which are not scanned.
 *   import-zones      non-test files that import against the agent-hub layer
 *                     direction: src/api/** or src/hooks/** importing from
 *                     src/components/** or src/pages/**, and src/components/**
 *                     importing from src/pages/**. Relative and `@/` imports
 *                     are resolved against src/; a file counts once however
 *                     many of its imports point the wrong way. Tests are not
 *                     counted: rendering a page from a test is not a
 *                     dependency of the product. The target is moving the
 *                     shared piece down (into api/, hooks/ or components/),
 *                     then an eslint no-restricted-paths rule once at zero.
 *   unchecked-mutation  non-test calls of authFetch with a literal POST, PUT,
 *                     PATCH or DELETE method whose Response nobody checks:
 *                     authFetch does not throw on 4xx/5xx, so a caller that
 *                     neither reads `.ok`/`.status` nor hands the Response on
 *                     shows success when the server refused. A call counts as
 *                     checked when it is returned (the caller owns it) or
 *                     passed straight to a function; when the name it lands in
 *                     (directly, through a ternary or a `Promise.all`
 *                     destructuring) is read in the next 25 lines as
 *                     `.ok`/`.status`, passed to a function, or parsed and
 *                     branched on as `.error`/`.success`/`.ok`; or when a
 *                     `.then` reading `.ok`/`.status` follows it. The target
 *                     is `mutate()` from src/api/mutate.ts, which throws an
 *                     ApiError carrying the server's error text.
 *   inline-pglite     server test files that build their own node-postgres
 *                     adapter over a PGlite (an adapt/rawQuery function, a
 *                     rowCount mapping, a db.pool swap). The shared ones are
 *                     testUtils/pglitePool.js (`usePglitePool()`,
 *                     `pgliteQuery(pg)`) and testUtils/pgliteDb.js
 *                     (`pgliteDb()`, `dbFacade()`); testUtils/ itself is not
 *                     counted.
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

// Import direction in agent-hub: each zone may import from the zones listed
// after it, never from those before it.
const ZONE_OF = (rel) => rel.split('/')[0];
const FORBIDDEN_ZONES = {
    api: new Set(['components', 'pages']),
    hooks: new Set(['components', 'pages']),
    components: new Set(['pages']),
};
// `from '…'` (import and re-export), `import '…'`, `import('…')`, `require('…')`.
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** The src-relative path an import points at, or null for a package or a path outside src. */
function resolveImport(spec, fromRel) {
    let target;
    if (spec.startsWith('@/')) target = spec.slice(2);
    else if (spec.startsWith('./') || spec.startsWith('../')) target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    else return null;
    return target.startsWith('../') ? null : target;
}

// unchecked-mutation: a non-GET authFetch whose Response is never looked at.
const MUTATION_METHOD = /\bmethod\s*:\s*(['"`])(?:POST|PUT|PATCH|DELETE)\1/i;
const AUTHFETCH_CALL = /(?<![\w.$])authFetch\s*\(/g;
const CHECK_WINDOW_LINES = 25;

/** Index just past the `)` closing the call whose `(` sits at `open`, or -1. */
function closeParen(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i + 1;
    }
    return -1;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The names a call's Response lands in: `const res = await authFetch(`, the
 * branch of a ternary assignment, or an element of `const [a, b] = await Promise.all([`. */
function responseNames(text, callIndex, before) {
    const direct = before.match(/(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)(?:\s*:\s*[\w$.<>[\]| ]+?)?\s*=\s*(?:await\s+)?$/);
    if (direct) return [direct[1]];
    const back = text.slice(Math.max(0, callIndex - 1200), callIndex).split('\n').slice(-16).join('\n');
    if (/[?:]\s*(?:await\s+)?$/.test(before)) {
        const ternary = back.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*$/);
        if (ternary) return [ternary[1]];
    }
    if (/(?:^\s*|[[,]\s*)$/.test(before)) {
        const all = back.match(/\b(?:const|let|var)\s+\[([^\]]+)\]\s*=\s*await\s+Promise\.all\s*\(\s*\[[^;]*$/);
        if (all) return all[1].split(',').map((n) => n.trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    }
    return [];
}

/** True when `after` reads the Response: `.ok`/`.status`, hands it to a function,
 * or parses it and branches on the body's `error`/`success`. */
function responseRead(after, names) {
    return names.some((raw) => {
        const name = escapeRe(raw);
        if (new RegExp(`\\b${name}\\s*\\??\\.\\s*(?:ok|status)\\b|[(,]\\s*${name}\\s*[),]`).test(after)) return true;
        return new RegExp(`\\b${name}\\.json\\(`).test(after) && /(?<!\b(?:console|toast|log|logger))\.(?:error|success|ok)\b/.test(after);
    });
}

function countUncheckedMutations(text) {
    let n = 0;
    for (const m of text.matchAll(AUTHFETCH_CALL)) {
        const open = m.index + m[0].length - 1;
        const end = closeParen(text, open);
        if (end < 0) continue;
        if (!MUTATION_METHOD.test(text.slice(open, end))) continue;
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const before = text.slice(lineStart, m.index);
        // Returned: the caller receives the Response and owns the check.
        if (/(?:\breturn|=>)\s*(?:await\s+)?$/.test(before)) continue;
        // Handed straight to a reader: `readJson(await authFetch(…))`.
        if (/[\w$]\s*\(\s*(?:await\s+)?$/.test(before)) continue;
        const after = text.slice(end).split('\n').slice(0, CHECK_WINDOW_LINES).join('\n');
        if (/^\s*\.then\s*\(/.test(after)) {
            if (!/\.(?:ok|status)\b/.test(after)) n++;
            continue;
        }
        if (/\{[^}]*\b(?:ok|status)\b[^}]*\}\s*=\s*(?:await\s+)?$/.test(before)) continue;
        if (responseRead(after, responseNames(text, m.index, before))) continue;
        n++;
    }
    return n;
}

// inline-pglite: the shapes a hand-rolled node-postgres adapter over PGlite takes.
const INLINE_PGLITE_ADAPTER = /^(?:async\s+)?function\s+(?:adapt\w*|rawQuery|q|query)\s*\(|\browCount\s*:|typeof\s+[\w?.]+\.affectedRows|\.affectedRows\s*\?\?|\bpool\.(?:query|connect)\s*=|\bquery\s*:\s*\(sql, params\)\s*=>\s*pg\.query/m;

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
    'authfetch-outside-api': {
        include: (rel) => !TEST_FILE.test(rel) && !rel.startsWith('api/') && rel !== 'utils/helpers.js',
        measure: (text) => (/(?<![\w.$])authFetch\s*\(/.test(text) ? 1 : 0),
        what: 'files calling authFetch outside src/api',
        advice: 'call through src/api/ instead: apiClient or createJsonResource (api/client.ts), mutate() (api/mutate.ts), or a reader in api/queries/',
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
    'status-5xx': {
        include: (rel) => !TEST_FILE.test(rel),
        measure: countMatches(/\.status\(\s*5\d\d\s*\)/g),
        what: 'hand-written .status(5xx) responses',
        advice: 'throw an HttpError (core/http/errors.js) or call next(err) and let core/http/terminalErrorHandler.js answer',
    },
    'sse-head': {
        include: (rel) => !TEST_FILE.test(rel) && !rel.startsWith('core/http/'),
        measure: countMatches(/['"]Content-Type['"]\s*[:,]\s*['"`]text\/event-stream|\.type\(\s*['"`]text\/event-stream/gi),
        what: 'hand-written text/event-stream heads outside core/http',
        advice: 'open the stream with openSse() from core/http/sseHelpers.js (headers/flush/heartbeat options keep a route\'s own wire head)',
    },
    'local-zod-helper': {
        // Route and auth files only: elsewhere these names mean other things
        // (integrations/shared/idList.js parses a query string). Top-level
        // declarations only, so a local `const choice = data.choices[0]`
        // inside a handler is not one.
        include: (rel) => !TEST_FILE.test(rel) && /^(routes|auth)\//.test(rel),
        measure: countMatches(/^(?:const|let|function)\s+(?:worded|bodyOf|queryOf|choice|flag|wholeNumber|idList|closedObject|orEmpty)\b/gm),
        what: 'local copies of the zod schema helpers in routes/ and auth/',
        advice: 'import the helper from core/http/schemaParts.js (worded, bodyOf, queryOf, choice, flag, wholeNumber, idList, closedObject, orEmpty), or give a deliberately different helper its own name',
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
    'import-zones': {
        include: (rel) => !TEST_FILE.test(rel) && ZONE_OF(rel) in FORBIDDEN_ZONES,
        measure: (text, pkg, rel) => {
            const forbidden = FORBIDDEN_ZONES[ZONE_OF(rel)];
            for (const [, , spec] of text.matchAll(IMPORT_SPEC)) {
                const target = resolveImport(spec, rel);
                if (target && forbidden.has(ZONE_OF(target))) return 1;
            }
            return 0;
        },
        what: 'files importing against the layer direction (api/hooks -> components/pages, components -> pages)',
        advice: 'move the shared piece down into api/, hooks/ or components/ and import it from there',
    },
    'unchecked-mutation': {
        include: (rel) => !TEST_FILE.test(rel),
        measure: (text) => countUncheckedMutations(text),
        what: 'non-GET authFetch calls whose Response is not checked',
        advice: 'call mutate() from src/api/mutate.ts (it throws an ApiError on a non-2xx answer) and show the error, or check res.ok',
    },
    'inline-pglite': {
        include: (rel) => TEST_FILE.test(rel) && !rel.startsWith('testUtils/'),
        measure: (text) => (/\bnew PGlite\(/.test(text) && INLINE_PGLITE_ADAPTER.test(text) ? 1 : 0),
        what: 'test files with their own PGlite adapter',
        advice: 'use pgliteQuery(pg) / usePglitePool() from testUtils/pglitePool.js or pgliteDb()/dbFacade() from testUtils/pgliteDb.js instead',
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
    const srcRel = path.relative(srcDir, file).split(path.sep).join('/');
    if (metric.include && !metric.include(srcRel)) continue;
    const n = metric.measure(fs.readFileSync(file, 'utf8'), pkg, srcRel);
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
