#!/usr/bin/env node
/**
 * Untranslated-string ratchet — the OTHER direction of the i18n guard.
 *
 * agent-hub/src/i18n/i18nGuard.test.js checks key → dictionary: a t('key') in
 * the source must exist in EN_DEFAULTS, the two dictionaries must agree, a
 * carrier property must name a real key. Every one of its checks starts from a
 * key. None of them can see the opposite mistake — a sentence on screen that
 * has no key at all — because there is no key to start from.
 *
 * That is this file. It counts the user-facing literals in JSX that never go
 * through t(): text nodes, and the placeholder/title/aria-label/alt attributes.
 *
 * WHY A RATCHET AND NOT A GATE. Measured over agent-hub/src at the time of
 * writing: 1427 non-test .jsx/.tsx files, 895 of them with no useTranslation
 * at all, and 5339 sites this file counts. A gate on "zero untranslated
 * strings" would be red on the day it lands and switched off within a
 * fortnight — the same reasoning that made scripts/eslint-budget.mjs and
 * scripts/ts-ratchet.mjs ratchets. So the package commits the number of
 * untranslated sites it may still carry (<package>/.i18n-ratchet.json), CI
 * fails when a change raises it, and `--update` lowers it after a conversion.
 * It never raises the number: a new untranslated string is the one thing this
 * gate exists to refuse.
 *
 * 5339 is well above the ~3350 a `>Capitalised text<` grep reports, and the
 * gap is not this file being loose. A grep like that only sees a text node
 * that starts on the same line as its `>`, which is the minority spelling —
 * the house style puts the sentence on its own line between the tags. The
 * scanner reads the node, not the line.
 *
 * WHAT COUNTS AS USER-FACING. The whole difficulty sits here. Too permissive
 * and the ratchet is decoration; too strict and a fleet spends its time
 * fighting the tool instead of translating. Every decision below is written
 * down because it is a decision, and every one has a test in
 * scripts/i18n-ratchet.test.mjs.
 *
 *  1. SCOPE IS JSX, FOUND BY WALKING THE SOURCE, NOT BY REGEX. `>Text<` as a
 *     pattern is unusable: `arr.length > 0 && <Row/>` matches it, and so does
 *     every `a > b` in the tree. So this file walks the source with a small
 *     JSX-aware scanner (scanJsx) that tracks whether it is in code, in an
 *     element's attributes, or in its children — the same choice check 8 of
 *     i18nGuard.test.js makes when it counts brackets instead of matching
 *     them, for the same reason: the thing being read is a nesting language.
 *     The scanner refuses to guess. A file whose bracket/tag nesting does not
 *     return to code at EOF is reported as UNPARSED and fails the run rather
 *     than contributing a number nobody can trust.
 *
 *  2. ONLY LITERAL ATTRIBUTE VALUES COUNT. `placeholder={t('x', 'Name')}` is
 *     an expression, so the scanner never sees a literal there — a string
 *     already inside t(), or a labelKey-style carrier prop, is the existing
 *     guard's business and is invisible to this one by construction.
 *
 *  3. FOUR ATTRIBUTES, NOT EVERY ATTRIBUTE. placeholder, title, aria-label and
 *     alt are the ones a user reads or hears. className, data-testid, id, key,
 *     href, value and the rest carry machine input; counting them would drown
 *     the real ones. `title` and `placeholder` on a COMPONENT (<Modal
 *     title="Settings">) count too — that is display copy wherever it lands.
 *     It is an allow-list, not a deny-list, for the reason CARRIERS in
 *     i18nGuard.test.js is one: a new attribute is a decision, not a surprise.
 *
 *  4. A `title` ON AN <svg> IS NOT A TOOLTIP. React renders it as a plain
 *     attribute and no browser shows it; the tooltip for an svg is a <title>
 *     CHILD element. Counting the attribute would ask a fleet to translate a
 *     string nobody can read.
 *
 *  5. alt="" IS DELIBERATE. An empty alt is the documented way to say
 *     "decorative, skip me" to a screen reader. There are 49 of them in the
 *     tree and every one is correct; a rule that demanded a key for them would
 *     be asking for the accessibility bug it looks like it is preventing.
 *
 *  6. NOT EVERY STRING IS A SENTENCE. A value with no run of two letters is
 *     punctuation, a number, an arrow, a bullet or an emoji — `—`, `·`, `→`,
 *     `✕`, `🐝`, `0`. Nothing to translate. Single non-letter characters fall
 *     out of the same rule.
 *
 *  7. MACHINE TOKENS ARE NOT COPY. One word carrying a separator is an
 *     identifier, a path, a MIME type, a colour or a URL: `created_at`,
 *     `application/json`, `#0ea5e9`, `https://…`, `v1.2.3`. Same subtraction
 *     the existing guard makes with MACHINE_WORD_RX, and for the same reason:
 *     without it a table of sort expressions reads as untranslated English.
 *
 *  8. <code>, <pre>, <kbd> AND <samp> HOLD LITERALS ON PURPOSE. Their children
 *     are the identifier, command or key the reader must type exactly. A
 *     translated `npm run dev` is a broken instruction. <style> and <script>
 *     children are not prose either. A <title> CHILD is not on that list: in
 *     svg it is the accessible name and in html it is the browser tab, so it
 *     is read — which is the opposite of the `title` ATTRIBUTE in rule 4, and
 *     that asymmetry is the point.
 *
 *  9. INTERPOLATION IS NOT TEXT. `{count}` is an expression container, so the
 *     scanner never yields it as a text node at all — an interpolation-only
 *     node cannot be reported. `Hello {name}` yields the text node `Hello `,
 *     which is copy, and is reported.
 *
 * 10. marketing/ IS COUNTED SEPARATELY AND NOT BUDGETED. The 48 files under
 *     src/marketing are the public product website. None of them imports
 *     useTranslation and none of them should: every sentence they show comes
 *     from the CMS (server/i18n/defaults/cmsDefaults.js seeds it, an editor
 *     changes it, the site serves what the CMS holds), and the English in the
 *     source is the shape of an empty block, not copy the app renders. Running
 *     them through t() would put the app's dictionary in charge of text the
 *     customer edits. They are reported under `marketing` in --list so the
 *     decision stays visible, and left out of the number.
 *
 * 11. demo/ AND test/ ARE OUT. demo/ is invented content — fake customers,
 *     fake tickets — which i18nGuard.test.js already excludes from its helper
 *     scan for the same reason ("demo content is a demo question, not an i18n
 *     one"). src/test/ is test infrastructure. i18n/ is the dictionaries.
 *
 * 12. ONLY JSX IS READ, NOT STRINGS THAT HAPPEN TO HOLD HTML. A few files
 *     build markup as a template literal — the export path in
 *     chat/WorkspaceNotebook.jsx writes `<img … alt="" />`, and
 *     webpages/WebpagePreview.jsx has a whole placeholder page. Those are
 *     strings; the scanner walks past them. They are a smaller and different
 *     problem, and reading them would mean guessing which template literals
 *     are markup.
 *
 * 13. THERE IS NO DEBUG EXEMPTION, because there is nothing to exempt. No .jsx
 *     or .tsx file in the tree renders JSX behind an `import.meta.env.DEV`
 *     branch; the machine-facing attributes people mean by "debug" —
 *     data-testid, id, key — are already out by rule 3. An exemption nobody
 *     can point at a line for is how a guard rots (see the rot checks in
 *     i18nGuard.test.js), so if a debug label ever does render, it renders on
 *     somebody's screen and gets a key like anything else.
 *
 * Usage:
 *   node scripts/i18n-ratchet.mjs <package>             gate (counts <package>/src)
 *   node scripts/i18n-ratchet.mjs <package> --update    lower the budget
 *   node scripts/i18n-ratchet.mjs <package> --list      print the sites still counted
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// The JSX scanner.
// ---------------------------------------------------------------------------

const IDENT_RX = /[A-Za-z0-9_$]+/y;

// Words after which a `<` or `/` opens an expression rather than continuing
// one. `return <div>` is the common one; without it every component's root
// element is read as a less-than.
const EXPR_KEYWORDS = new Set([
    'return', 'yield', 'typeof', 'in', 'of', 'case', 'do', 'else', 'await',
    'new', 'delete', 'void', 'instanceof',
]);

// Characters after which the same holds. `=> <div>` ends in `>`, `&& <div>` in
// `&`, `? <div>` in `?`. An identifier, `)` or `]` before a `<` means a
// comparison (`a < b`, `useState<string>()`), which is exactly the noise a
// `>Text<` regex cannot separate out.
const EXPR_OPENERS = new Set([...'([{,;=:?+-*%&|!~^<>']);

/**
 * Whether `prev` — the last token the walk consumed in this code frame — puts
 * the next `<` or `/` in expression position.
 *
 * It is tracked FORWARD rather than read backwards from the source, and that
 * is the whole point. Reading backwards means stepping over whitespace and
 * stopping at the first other character, which lands inside comments: the
 * three explanatory lines above the `<img` in
 * AppStudio/runtime/components/AppFileGallery.jsx end in a full stop, so a
 * backwards read saw `.` and refused to open the element — and the ratchet
 * then silently skipped the rest of that file's JSX. Walking forward, the
 * comment is already skipped and `prev` is still the `(` before it.
 */
function opensExpression(prev) {
    if (!prev) return true;
    if (prev.word) return EXPR_KEYWORDS.has(prev.text);
    return EXPR_OPENERS.has(prev.text);
}

/** Index just past the string literal opening at `at`. */
function endOfString(src, at) {
    const quote = src[at];
    for (let i = at + 1; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === quote) return i + 1;
        if (src[i] === '\n') return i; // unterminated: stop at the line, not at EOF
    }
    return src.length;
}

/**
 * Index just past the regex literal opening at `at`, or `at + 1` when the slash
 * turns out not to open one. Regexes have to be skipped whole: `/['"]/` would
 * otherwise start a string that swallows the rest of the line, and `/<\/p>/`
 * would open a phantom element.
 */
function endOfRegex(src, at) {
    let inClass = false;
    for (let i = at + 1; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }
        if (c === '\n') return at + 1;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) return i + 1;
    }
    return src.length;
}

/** Index just past the comment at `at`, or -1 when there is no comment there. */
function endOfComment(src, at) {
    if (src[at] !== '/') return -1;
    if (src[at + 1] === '/') {
        const nl = src.indexOf('\n', at);
        return nl === -1 ? src.length : nl;
    }
    if (src[at + 1] === '*') {
        const close = src.indexOf('*/', at + 2);
        return close === -1 ? src.length : close + 2;
    }
    return -1;
}

const ATTR_NAME_RX = /[A-Za-z_][A-Za-z0-9_:.-]*/y;
const TAG_NAME_RX = /[A-Za-z_$][A-Za-z0-9_$.:-]*/y;

/**
 * Every literal attribute value and every text node in `src`, each with the
 * tag it belongs to.
 *
 * Four states, kept on a stack so nesting is counted rather than matched:
 * `code` (JavaScript, including the inside of every `{…}` in JSX), `tag` (from
 * `<Foo` to its `>`), `children` (between `>` and the matching `</Foo>`), and
 * `template` (inside a backtick string). A `{` in a tag or in children pushes
 * `code`; a `}` seen while that frame's own brace count is back at 0 pops it.
 * Strings, regexes and comments are skipped whole in `code`, so nothing inside
 * them can move the counters.
 *
 * A template literal is a FRAME rather than a skip, and that is not tidiness.
 * A `${…}` is ordinary JavaScript and may hold anything an expression may hold
 * — including a regex holding a quote, which is exactly what
 * AppStudio/bi/FilterRowsEditor.jsx does:
 * ``JSON.parse(`"${src.slice(1, -1).replace(/"/g, '\\"')}"`)``. A skipper that
 * only knew about strings and braces read that `"` as the start of a string,
 * lost the closing backtick, and swallowed the remaining 200 lines of the file
 * as template text — silently, with the file still balanced at EOF. As a frame,
 * the interpolation is walked by the same code path as everything else, so the
 * regex is a regex.
 *
 * `unbalanced` is true when the stack has not returned to a single code frame
 * at EOF. The caller treats that as a failure rather than as zero findings: a
 * scanner that silently reads half a file is the one failure mode a ratchet
 * must not have, because the number would simply drop.
 */
function scanJsx(src) {
    const attrs = [];
    const texts = [];
    const stack = [{ type: 'code', braces: 0 }];
    let textFrom = -1;
    let i = 0;

    const flushText = (end) => {
        if (textFrom === -1) return;
        const raw = src.slice(textFrom, end);
        if (raw.trim()) texts.push({ raw, index: textFrom, tag: stack[stack.length - 1].tag });
        textFrom = -1;
    };
    // Landing back in a parent frame after a closed element: in children the
    // text picks up again, in code the element counts as a finished expression
    // (so the `<` of a sibling element is still in expression position).
    const resume = (at) => {
        const parent = stack[stack.length - 1];
        if (parent.type === 'children') textFrom = at;
        else if (parent.type === 'code') parent.prev = { text: '>' };
    };

    while (i < src.length) {
        const top = stack[stack.length - 1];
        const c = src[i];

        if (top.type === 'code') {
            if (/\s/.test(c)) { i++; continue; }
            const comment = endOfComment(src, i);
            if (comment !== -1) { i = comment; continue; }
            if (c === "'" || c === '"') { i = endOfString(src, i); top.prev = { text: c }; continue; }
            if (c === '`') { top.prev = { text: c }; stack.push({ type: 'template' }); i++; continue; }
            if (c === '/' && opensExpression(top.prev)) { i = endOfRegex(src, i); top.prev = { text: '/' }; continue; }
            if (c === '{') { top.braces++; top.prev = { text: c }; i++; continue; }
            if (c === '}') {
                if (top.braces === 0 && stack.length > 1) { stack.pop(); i++; resume(i); continue; }
                top.braces--; top.prev = { text: c }; i++; continue;
            }
            if (c === '<' && opensExpression(top.prev)) {
                TAG_NAME_RX.lastIndex = i + 1;
                const tag = TAG_NAME_RX.exec(src);
                if (tag && tag.index === i + 1) { stack.push({ type: 'tag', tag: tag[0] }); i += 1 + tag[0].length; continue; }
                if (src[i + 1] === '>') { stack.push({ type: 'children', tag: '' }); i += 2; textFrom = i; continue; }
            }
            IDENT_RX.lastIndex = i;
            const word = IDENT_RX.exec(src);
            if (word && word.index === i) { top.prev = { text: word[0], word: true }; i += word[0].length; continue; }
            top.prev = { text: c };
            i++;
            continue;
        }

        if (top.type === 'template') {
            if (c === '\\') { i += 2; continue; }
            if (c === '`') { stack.pop(); i++; continue; }
            if (c === '$' && src[i + 1] === '{') { stack.push({ type: 'code', braces: 0 }); i += 2; continue; }
            i++;
            continue;
        }

        if (top.type === 'tag') {
            if (/\s/.test(c)) { i++; continue; }
            const comment = endOfComment(src, i);
            if (comment !== -1) { i = comment; continue; }
            if (c === '/' && src[i + 1] === '>') { stack.pop(); i += 2; resume(i); continue; }
            if (c === '>') { stack.pop(); stack.push({ type: 'children', tag: top.tag }); i++; textFrom = i; continue; }
            if (c === '{') { stack.push({ type: 'code', braces: 0 }); i++; continue; } // {...spread}
            ATTR_NAME_RX.lastIndex = i;
            const name = ATTR_NAME_RX.exec(src);
            if (!name || name.index !== i) { i++; continue; }
            let k = i + name[0].length;
            while (k < src.length && /\s/.test(src[k])) k++;
            if (src[k] !== '=') { i = k; continue; } // boolean attribute
            k++;
            while (k < src.length && /\s/.test(src[k])) k++;
            if (src[k] === '"' || src[k] === "'") {
                const end = endOfString(src, k);
                attrs.push({ name: name[0], value: src.slice(k + 1, end - 1), index: k, tag: top.tag });
                i = end;
                continue;
            }
            if (src[k] === '{') { stack.push({ type: 'code', braces: 0 }); i = k + 1; continue; }
            i = k;
            continue;
        }

        // children
        if (c === '{') { flushText(i); stack.push({ type: 'code', braces: 0 }); i++; continue; }
        if (c === '<') {
            flushText(i);
            if (src[i + 1] === '/') {
                const gt = src.indexOf('>', i);
                stack.pop();
                i = gt === -1 ? src.length : gt + 1;
                resume(i);
                continue;
            }
            TAG_NAME_RX.lastIndex = i + 1;
            const tag = TAG_NAME_RX.exec(src);
            if (tag && tag.index === i + 1) { stack.push({ type: 'tag', tag: tag[0] }); i += 1 + tag[0].length; continue; }
            if (src[i + 1] === '>') { stack.push({ type: 'children', tag: '' }); i += 2; textFrom = i; continue; }
            i++;
            continue;
        }
        if (textFrom === -1) textFrom = i;
        i++;
    }
    flushText(src.length);
    return { attrs, texts, unbalanced: stack.length !== 1 || stack[0].type !== 'code' };
}

// ---------------------------------------------------------------------------
// What of that is user-facing.
// ---------------------------------------------------------------------------

const WATCHED_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt']);

// Children that are meant to be read literally: the command to type, the key
// to press, the identifier to copy. Plus the two that are not prose at all.
// `title` is deliberately NOT here — an svg's <title> CHILD is its accessible
// name and an HTML <title> is the tab, so both are read.
const LITERAL_CHILD_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'style', 'script']);

const ENTITY_RX = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g;
const WORD_RX = /[A-Za-z]{2,}/;
// One token carrying a separator: an identifier, a path, a MIME type, a
// colour, a URL, a version. `Don't` has no separator from this set and stays
// prose; `created_at` and `application/json` do not.
const MACHINE_TOKEN_RX = /^[\w@#$%&*+=~?^.:/\\-]*[_.:/\\@#][\w@#$%&*+=~?^.:/\\-]*$/;

/**
 * A value a person reads. Entities are dropped first — `&nbsp;` is a space,
 * not the word "nbsp" — and `{…}` with it, so `Step {n}` is judged on "Step".
 */
function isUserFacing(raw) {
    const value = raw.replace(ENTITY_RX, ' ').replace(/\{[^{}]*\}/g, ' ').trim();
    if (!WORD_RX.test(value)) return false;
    return !(!/\s/.test(value) && MACHINE_TOKEN_RX.test(value));
}

/** The untranslated user-facing literals in one file. */
function findUntranslated(rel, src) {
    const { attrs, texts, unbalanced } = scanJsx(src);
    if (unbalanced) return { unparsed: true, sites: [] };
    const lineAt = lineIndex(src);
    const sites = [];
    for (const { name, value, index, tag } of attrs) {
        if (!WATCHED_ATTRS.has(name)) continue;
        if (name === 'alt' && value === '') continue;
        if (name === 'title' && tag === 'svg') continue;
        if (!isUserFacing(value)) continue;
        sites.push({ rel, line: lineAt(index), kind: name, text: value });
    }
    for (const { raw, index, tag } of texts) {
        if (LITERAL_CHILD_TAGS.has(tag)) continue;
        if (!isUserFacing(raw)) continue;
        sites.push({ rel, line: lineAt(index), kind: 'text', text: raw.trim().replace(/\s+/g, ' ') });
    }
    return { unparsed: false, sites: sites.sort((a, b) => a.line - b.line) };
}

/**
 * A line lookup that walks the file once. The obvious
 * `src.slice(0, i).split('\n').length` per site is quadratic — the same trap
 * the duplicate-key check in i18nGuard.test.js documents, and this file reads
 * far more sites than that one reads keys.
 */
function lineIndex(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    return (index) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= index) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };
}

// ---------------------------------------------------------------------------
// Walking the package.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite']);
// Trees whose literals are not app copy. See rules 10 and 11 in the header.
const OUT_OF_SCOPE = ['i18n/', 'test/', 'demo/'];
const UNBUDGETED = ['marketing/'];

function collect(from, base, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, base, into);
        } else if (entry.isFile() && /\.(jsx|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
            into.push(path.relative(base, full).split(path.sep).join('/'));
        }
    }
    return into;
}

/** Every counted site in `srcDir`, plus the unbudgeted and unparsed files. */
function scanTree(srcDir) {
    const sites = [];
    const unbudgeted = [];
    const unparsed = [];
    for (const rel of collect(srcDir, srcDir, [])) {
        if (OUT_OF_SCOPE.some(prefix => rel.startsWith(prefix))) continue;
        const found = findUntranslated(rel, fs.readFileSync(path.join(srcDir, rel), 'utf8'));
        if (found.unparsed) { unparsed.push(rel); continue; }
        if (UNBUDGETED.some(prefix => rel.startsWith(prefix))) unbudgeted.push(...found.sites);
        else sites.push(...found.sites);
    }
    return { sites, unbudgeted, unparsed };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function main(argv) {
    const pkg = argv.find((a) => !a.startsWith('--'));
    if (!pkg) {
        console.error('i18n-ratchet: usage: node scripts/i18n-ratchet.mjs <package> [--update] [--list]');
        return 2;
    }
    const update = argv.includes('--update');
    const list = argv.includes('--list');

    const dir = path.resolve(ROOT, pkg);
    const srcDir = path.join(dir, 'src');
    const budgetFile = path.join(dir, '.i18n-ratchet.json');
    if (!fs.existsSync(srcDir)) {
        console.error(`i18n-ratchet: ${path.relative(ROOT, srcDir)} not found — is "${pkg}" a package directory?`);
        return 2;
    }

    const { sites, unbudgeted, unparsed } = scanTree(srcDir);
    if (unparsed.length) {
        console.error(`❌ ${pkg}: ${unparsed.length} file(s) the JSX scanner could not read to the end, so the count is not trustworthy:\n  ${unparsed.join('\n  ')}`);
        return 1;
    }

    if (list) {
        for (const s of sites) console.log(`src/${s.rel}:${s.line} [${s.kind}] ${JSON.stringify(s.text)}`);
        for (const s of unbudgeted) console.log(`src/${s.rel}:${s.line} [${s.kind}] ${JSON.stringify(s.text)}  (marketing — not budgeted)`);
    }

    const count = sites.length;
    const byKind = {};
    for (const s of sites) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    const kinds = Object.keys(byKind).sort().map(k => `${k} ${byKind[k]}`).join(', ');
    // The marketing figure rides along on every line so the choice not to
    // budget it stays a visible decision instead of a silent subtraction.
    const breakdown = unbudgeted.length ? `${kinds}; plus ${unbudgeted.length} in marketing, not budgeted` : kinds;

    const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
    if (update || !existing) {
        const next = {
            _comment: `Highest number of untranslated user-facing literals ${pkg}/src may still carry. Lower it with \`node scripts/i18n-ratchet.mjs ${pkg} --update\` after translating some; raising it is a deliberate edit that belongs in a commit message with a reason. What counts is documented in scripts/i18n-ratchet.mjs.`,
            _generated: new Date().toISOString().slice(0, 10),
            strings: existing ? Math.min(count, existing.strings) : count,
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${next.strings} untranslated literals (measured ${count}; ${breakdown})`);
        return 0;
    }

    if (count > existing.strings) {
        console.error(`❌ ${pkg}: ${count} untranslated user-facing literals under src (${breakdown}), budget is ${existing.strings} — put the ${count - existing.strings} new one(s) through t() rather than raising the budget. \`node scripts/i18n-ratchet.mjs ${pkg} --list\` names them.`);
        return 1;
    }
    if (count < existing.strings) {
        console.log(`✅ ${pkg}: ${count} untranslated literals under src (${breakdown}), under the budget of ${existing.strings}. Run \`node scripts/i18n-ratchet.mjs ${pkg} --update\` to lower it.`);
    } else {
        console.log(`➖ ${pkg}: ${count} untranslated literals under src (${breakdown}), at budget`);
    }
    return 0;
}

process.exit(main(process.argv.slice(2)));
